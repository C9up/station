/**
 * POST /admin/login refusals follow the same content negotiation as every
 * other admin refusal: a JSON or XHR client gets a JSON body with a code, a
 * browser gets the sign-in page.
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
	return async (
		body: Record<string, unknown>,
		headers: Record<string, string> = JSON_CLIENT,
	) => {
		const { ctx, res } = buildCtx({ body, headers, ip: "10.0.0.1" });
		await login.handler(ctx);
		return res;
	};
}

const JSON_CLIENT = { accept: "application/json" };
const XHR_CLIENT = { "x-requested-with": "XMLHttpRequest" };

function jsonBody(res: { contentType?: string; body?: string }): unknown {
	expect(res.contentType).toBe("application/json");
	return JSON.parse(res.body ?? "null");
}

describe("station > login refusals are content-negotiated (bug 019)", () => {
	beforeEach(() => resetStationProviderFlags());

	it("400 on missing credentials", async () => {
		const post = await boot();
		const res = await post({ email: "admin@example.com" });
		expect(res.status).toBe(400);
		expect(jsonBody(res)).toEqual({
			error: "Email and password are both required.",
			code: "E_STATION_LOGIN_CREDENTIALS_REQUIRED",
		});
	});

	it("401 on a wrong password, for JSON and XHR callers", async () => {
		const post = await boot();
		for (const headers of [JSON_CLIENT, XHR_CLIENT]) {
			const res = await post(
				{ email: "admin@example.com", password: "nope" },
				headers,
			);
			expect(res.status).toBe(401);
			expect(jsonBody(res)).toMatchObject({
				code: "E_STATION_INVALID_CREDENTIALS",
			});
		}
	});

	it("429 keeps Retry-After and answers JSON", async () => {
		const post = await boot({ loginRateLimit: { maxAttempts: 1 } });
		await post({ email: "admin@example.com", password: "nope" });
		const res = await post({ email: "admin@example.com", password: "nope" });
		expect(res.status).toBe(429);
		expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
		expect(jsonBody(res)).toEqual({
			error: "Too many sign-in attempts. Try again later.",
			code: "E_STATION_TOO_MANY_LOGIN_ATTEMPTS",
		});
	});

	it("503 when the limiter fails answers JSON", async () => {
		const post = await boot({
			loginRateLimit: {
				limiter: {
					attempt: () => Promise.reject(new Error("redis down")),
					clear: () => Promise.resolve(),
				},
			},
		});
		const res = await post({ email: "admin@example.com", password: "x" });
		expect(res.status).toBe(503);
		expect(jsonBody(res)).toEqual({
			error: "Sign-in is temporarily unavailable.",
			code: "E_STATION_LOGIN_UNAVAILABLE",
		});
	});

	it("a browser still gets the sign-in page", async () => {
		const post = await boot();
		const res = await post(
			{ email: "admin@example.com", password: "nope" },
			{ accept: "text/html" },
		);
		expect(res.status).toBe(401);
		expect(res.contentType).toMatch(/text\/html/);
		expect(res.body).toContain('role="alert"');
	});
});
