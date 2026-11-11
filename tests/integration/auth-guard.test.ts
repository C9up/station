/**
 * The admin authenticates through a named warden guard (`station.guard`),
 * defaulting to the manager's default one, and refuses at boot a guard that
 * cannot carry station's sign-in: one that issues no bearer token, such as a
 * session guard, used to make every POST /admin/login a 500.
 */
import "reflect-metadata";
import { beforeEach, describe, expect, it } from "vitest";
import type { StationConfig } from "../../src/StationProvider.js";
import { resetStationProviderFlags } from "../../src/StationProvider.js";
import { bootStation, buildCtx, buildTableDb } from "../__helpers__/harness.js";
import { User } from "../fixtures/User.js";

const USER = { id: 1, roles: ["admin"] };

/** A warden-shaped manager with a JWT-like `api` guard and a session `web` one. */
function twoGuardManager(defaultGuard: "api" | "web") {
	const calls: Array<[string, string | undefined]> = [];
	const jwt = {
		name: "jwt",
		authenticate: () => Promise.resolve({ authenticated: false }),
		verify: () => Promise.resolve({ authenticated: false }),
		signToken: () => "TOKEN",
		revoke: () => Promise.resolve(true),
	};
	const session = {
		name: "session",
		authenticate: () => Promise.reject(new Error("USE_LOGIN")),
		verify: () => Promise.resolve({ authenticated: false }),
	};
	const guards = new Map<string, unknown>([
		["api", jwt],
		["web", session],
	]);
	const manager = {
		authenticate(creds: Record<string, unknown>, guard?: string) {
			calls.push(["authenticate", guard]);
			if (creds.password !== "hunter2") {
				return Promise.resolve({ authenticated: false });
			}
			return Promise.resolve({
				authenticated: true,
				user: { ...USER, token: "TOKEN" },
			});
		},
		verify(token: string, guard?: string) {
			calls.push(["verify", guard]);
			return Promise.resolve(
				token === "TOKEN"
					? { authenticated: true, user: USER }
					: { authenticated: false },
			);
		},
		getStrategy(guard?: string) {
			calls.push(["getStrategy", guard]);
			const strategy = guards.get(guard ?? defaultGuard);
			if (strategy === undefined) {
				throw new Error(`Guard "${String(guard)}" is not registered`);
			}
			return strategy;
		},
		hasPermission: () => Promise.resolve(true),
		hasRole: () => Promise.resolve(true),
	};
	return { manager, calls };
}

function boot(manager: unknown, config?: StationConfig) {
	return bootStation({
		db: buildTableDb([{ id: 1, name: "Ada", age: 36 }]).db,
		auth: manager,
		config,
		resources: [{ entity: User }],
	});
}

describe("station > the admin's warden guard (bug 016)", () => {
	beforeEach(() => resetStationProviderFlags());

	it("station.guard names the guard for sign-in, the gate and logout", async () => {
		const { manager, calls } = twoGuardManager("web");
		const station = await boot(manager, { guard: "api" });
		calls.length = 0;

		const login = buildCtx({
			body: { email: "admin@example.com", password: "hunter2" },
		});
		await station.find("post", "/admin/login").handler(login.ctx);
		expect(login.res.status).toBe(302);

		const show = buildCtx({
			params: { id: "1" },
			cookies: { station_auth: "TOKEN" },
		});
		await station.find("get", "/admin/users/:id").handler(show.ctx);
		expect(show.res.status).toBeUndefined();
		expect(show.res.body).toContain("Ada");

		const logout = buildCtx({ cookies: { station_auth: "TOKEN" } });
		await station.find("post", "/admin/logout").handler(logout.ctx);

		expect(calls.length).toBeGreaterThan(0);
		expect(calls.filter(([, guard]) => guard !== "api")).toEqual([]);
		expect(calls.map(([call]) => call)).toEqual(
			expect.arrayContaining(["authenticate", "verify", "getStrategy"]),
		);
	});

	it("a session default guard is refused at boot with the option to set", async () => {
		const { manager } = twoGuardManager("web");
		await expect(boot(manager)).rejects.toThrow(/station\.guard/);
	});

	it("a session guard named explicitly is refused at boot", async () => {
		const { manager } = twoGuardManager("api");
		await expect(boot(manager, { guard: "web" })).rejects.toThrow(
			/guard 'web'.*bearer token/s,
		);
	});

	it("an unknown guard name is refused at boot", async () => {
		const { manager } = twoGuardManager("api");
		await expect(boot(manager, { guard: "admin" })).rejects.toThrow(
			/guard 'admin'/,
		);
	});

	it("an empty guard name is refused at boot", async () => {
		const { manager } = twoGuardManager("api");
		await expect(boot(manager, { guard: "" })).rejects.toThrow(
			/station\.guard/,
		);
	});

	it("without station.guard the manager's default token guard is used", async () => {
		const { manager, calls } = twoGuardManager("api");
		const station = await boot(manager);
		const login = buildCtx({
			body: { email: "admin@example.com", password: "hunter2" },
		});
		await station.find("post", "/admin/login").handler(login.ctx);
		expect(login.res.status).toBe(302);
		expect(calls).toContainEqual(["authenticate", undefined]);
	});
});
