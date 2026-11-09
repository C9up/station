/**
 * The admin session cookie and its end (bugs 215, 217): `Secure` follows the
 * environment under every spelling, the cookie is scoped to `/admin`, and
 * logout revokes the token it carried instead of only clearing the cookie.
 */
import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	resetStationProviderFlags,
	type StationConfig,
} from "../../src/StationProvider.js";
import {
	bootStation,
	buildCtx,
	buildFakeAuth,
	buildTableDb,
	type CtxOptions,
} from "../__helpers__/harness.js";
import { User } from "../fixtures/User.js";

const original = process.env.NODE_ENV;

afterEach(() => {
	process.env.NODE_ENV = original;
	vi.restoreAllMocks();
});

async function boot(
	opts: { revocable?: boolean; config?: StationConfig } = {},
) {
	const auth = buildFakeAuth({ revocable: opts.revocable });
	const booted = await bootStation({
		db: buildTableDb([{ id: 1, name: "alice", age: 30 }]).db,
		auth: auth.manager,
		config: opts.config,
		resources: [{ entity: User }],
	});
	async function login(extra: Partial<CtxOptions> = {}) {
		const { ctx, res } = buildCtx({
			...extra,
			body: { email: "admin@example.com", password: "hunter2" },
		});
		await booted.find("post", "/admin/login").handler(ctx);
		const [cookie] = res.cookies;
		if (cookie === undefined) throw new Error("no cookie set");
		return cookie;
	}
	return { auth, login, find: booted.find };
}

describe("station > admin cookie flags (bug 215)", () => {
	beforeEach(() => resetStationProviderFlags());

	for (const env of ["prod", "production", "staging"]) {
		it(`is Secure under NODE_ENV=${env}`, async () => {
			process.env.NODE_ENV = env;
			const { login } = await boot();
			expect((await login()).options?.secure).toBe(true);
		});
	}

	it("is not Secure over plain HTTP in development, Secure over HTTPS", async () => {
		process.env.NODE_ENV = "development";
		const { login } = await boot();
		expect((await login()).options?.secure).toBe(false);
		const overTls = await login({ secure: true });
		expect(overTls.options?.secure).toBe(true);
	});

	it("cookieSecure overrides the default", async () => {
		process.env.NODE_ENV = "development";
		const { login } = await boot({ config: { cookieSecure: true } });
		expect((await login()).options?.secure).toBe(true);
	});

	it("is scoped to /admin, and cleared on that path", async () => {
		const { login, find } = await boot();
		const cookie = await login();
		expect(cookie.options?.path).toBe("/admin");
		expect(cookie.options?.httpOnly).toBe(true);

		const { ctx, res } = buildCtx({
			cookies: { station_auth: String(cookie.value) },
		});
		await find("post", "/admin/logout").handler(ctx);
		expect(res.cleared).toEqual([
			{ name: "station_auth", options: { path: "/admin" } },
		]);
	});
});

describe("station > logout revokes the token (bug 217)", () => {
	beforeEach(() => resetStationProviderFlags());

	it("a token replayed after logout is refused", async () => {
		const { auth, login, find } = await boot({ revocable: true });
		const token = String((await login()).value);

		const before = buildCtx({ cookies: { station_auth: token } });
		await find("get", "/admin/users").handler(before.ctx);
		expect(before.res.status ?? 200).toBe(200);

		const out = buildCtx({ cookies: { station_auth: token } });
		await find("post", "/admin/logout").handler(out.ctx);
		expect(auth.calls.revoke).toEqual([token]);

		const replay = buildCtx({ cookies: { station_auth: token } });
		await find("get", "/admin/users").handler(replay.ctx);
		expect(replay.res.status).toBe(302);
		expect(replay.res.location).toBe("/admin/login");
	});

	it("warns once when the auth strategy cannot revoke, and still logs out", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const { login, find } = await boot();
		for (let i = 0; i < 2; i++) {
			const token = String((await login()).value);
			const { ctx, res } = buildCtx({ cookies: { station_auth: token } });
			await find("post", "/admin/logout").handler(ctx);
			expect(res.location).toBe("/admin/login");
		}
		const said = warn.mock.calls
			.flat()
			.filter((m) => String(m).includes("cannot revoke"));
		expect(said).toHaveLength(1);
	});
});
