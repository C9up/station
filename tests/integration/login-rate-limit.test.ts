/**
 * Brute-force protection on POST /admin/login (bug 213): attempts are counted
 * per IP and per identifier before the credential check, the 6th in a window
 * is refused with 429 + Retry-After, a success clears the counters, and the
 * limiter and route middleware are configurable.
 */
import "reflect-metadata";
import { beforeEach, describe, expect, it } from "vitest";
import type { StationConfig } from "../../src/StationProvider.js";
import { resetStationProviderFlags } from "../../src/StationProvider.js";
import {
	bootStation,
	buildCtx,
	buildFakeAuth,
	buildTableDb,
} from "../__helpers__/harness.js";
import { User } from "../fixtures/User.js";

async function boot(config?: StationConfig) {
	const auth = buildFakeAuth({});
	const booted = await bootStation({
		db: buildTableDb([]).db,
		auth: auth.manager,
		config,
		resources: [{ entity: User }],
	});
	const login = booted.find("post", "/admin/login");
	async function attempt(email: string, password: string, ip = "10.0.0.1") {
		const { ctx, res } = buildCtx({ body: { email, password }, ip });
		await login.handler(ctx);
		return res;
	}
	return { auth, attempt, routes: booted.routes };
}

describe("station > admin login rate limit (bug 213)", () => {
	beforeEach(() => resetStationProviderFlags());

	it("refuses the 6th failed attempt with 429 + Retry-After, before authenticate", async () => {
		const { auth, attempt } = await boot();
		for (let i = 0; i < 5; i++) {
			expect((await attempt("admin@example.com", "nope")).status).toBe(401);
		}
		const sixth = await attempt("admin@example.com", "nope");
		expect(sixth.status).toBe(429);
		expect(Number(sixth.headers.get("retry-after"))).toBeGreaterThan(0);
		expect(auth.calls.authenticate).toBe(5);
		// The right password is refused too while the window lasts.
		expect((await attempt("admin@example.com", "hunter2")).status).toBe(429);
	});

	it("counts the identifier across IPs and the IP across identifiers", async () => {
		const byIdentifier = await boot();
		for (let i = 0; i < 5; i++) {
			await byIdentifier.attempt("admin@example.com", "x", `10.0.1.${i}`);
		}
		expect(
			(await byIdentifier.attempt(" ADMIN@example.com ", "x", "10.9.9.9"))
				.status,
		).toBe(429);

		resetStationProviderFlags();
		const byIp = await boot();
		for (let i = 0; i < 5; i++) {
			await byIp.attempt(`user${i}@example.com`, "x", "10.0.0.7");
		}
		expect(
			(await byIp.attempt("other@example.com", "x", "10.0.0.7")).status,
		).toBe(429);
	});

	it("a success clears the counters", async () => {
		const { attempt } = await boot();
		for (let i = 0; i < 4; i++) await attempt("admin@example.com", "nope");
		expect((await attempt("admin@example.com", "hunter2")).status).toBe(302);
		for (let i = 0; i < 5; i++) {
			expect((await attempt("admin@example.com", "nope")).status).toBe(401);
		}
	});

	it("uses an injected limiter (warden's AuthRateLimiter shape) with warden's keys", async () => {
		const seen: string[][] = [];
		const cleared: string[][] = [];
		const { attempt } = await boot({
			loginRateLimit: {
				limiter: {
					async attempt(...keys: string[]) {
						seen.push(keys);
						return { allowed: seen.length < 2, retryAfterSeconds: 42 };
					},
					async clear(...keys: string[]) {
						cleared.push(keys);
					},
				},
			},
		});
		expect(
			(await attempt("admin@example.com", "hunter2", "1.2.3.4")).status,
		).toBe(302);
		expect(seen[0]).toEqual(["ip:1.2.3.4", "id:admin@example.com"]);
		expect(cleared).toEqual([["ip:1.2.3.4", "id:admin@example.com"]]);
		const refused = await attempt("admin@example.com", "hunter2", "1.2.3.4");
		expect(refused.status).toBe(429);
		expect(refused.headers.get("retry-after")).toBe("42");
	});

	it("a limiter that throws refuses the login (fail-closed)", async () => {
		const { auth, attempt } = await boot({
			loginRateLimit: {
				limiter: {
					attempt: () => Promise.reject(new Error("redis down")),
					clear: () => Promise.resolve(),
				},
			},
		});
		const res = await attempt("admin@example.com", "hunter2");
		expect(res.status).toBe(503);
		expect(auth.calls.authenticate).toBe(0);
	});

	it("loginRateLimit: false turns the limiter off", async () => {
		const { attempt } = await boot({ loginRateLimit: false });
		for (let i = 0; i < 8; i++) {
			expect((await attempt("admin@example.com", "nope")).status).toBe(401);
		}
	});

	it("rejects a limit that would not limit", async () => {
		await expect(
			boot({ loginRateLimit: { maxAttempts: Number.POSITIVE_INFINITY } }),
		).rejects.toThrow(/maxAttempts/);
	});

	it("attaches the configured named middleware to every route Station mounts", async () => {
		const { routes } = await boot({ middleware: ["throttle"] });
		expect(routes.length).toBeGreaterThan(5);
		for (const r of routes) expect(r.middleware).toEqual(["throttle"]);
	});
});
