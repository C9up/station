/**
 * The admin's security events reach an audit sink (bug 222): sign-in success,
 * failure and throttling, logout, authorization denials and CSRF blocks go to
 * `station.audit`, each with the client IP and request id; write events carry
 * the request origin too.
 */
import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StationConfig } from "../../src/StationProvider.js";
import { resetStationProviderFlags } from "../../src/StationProvider.js";
import type { AuditEvent, SecurityAuditEvent } from "../../src/types.js";
import {
	bootStation,
	buildCtx,
	buildFakeAuth,
	buildTableDb,
} from "../__helpers__/harness.js";
import { User } from "../fixtures/User.js";

const ORIGIN = {
	ip: "203.0.113.9",
	headers: { "user-agent": "probe/1.0", "x-request-id": "req-42" },
};

async function boot(opts: {
	permissions?: string[];
	config?: StationConfig;
	writes?: AuditEvent[];
}) {
	const events: SecurityAuditEvent[] = [];
	const auth = buildFakeAuth({ permissions: opts.permissions });
	const writes = opts.writes;
	const booted = await bootStation({
		db: buildTableDb([{ id: 1, name: "alice", age: 30 }]).db,
		auth: auth.manager,
		config: { audit: (e) => void events.push(e), ...opts.config },
		resources: [
			{
				entity: User,
				audit: writes === undefined ? undefined : (e) => void writes.push(e),
			},
		],
	});
	return { events, find: booted.find };
}

afterEach(() => vi.restoreAllMocks());

describe("station > security audit events (bug 222)", () => {
	beforeEach(() => resetStationProviderFlags());

	it("a failed sign-in emits exactly one login_failed with the origin", async () => {
		const { events, find } = await boot({});
		const { ctx, res } = buildCtx({
			...ORIGIN,
			body: { email: "admin@example.com", password: "wrong" },
		});
		await find("post", "/admin/login").handler(ctx);
		expect(res.status).toBe(401);
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			action: "login_failed",
			identifier: "admin@example.com",
			ip: "203.0.113.9",
			userAgent: "probe/1.0",
			requestId: "req-42",
		});
		expect(events[0]?.at).toBeInstanceOf(Date);
	});

	it("records sign-in, throttling and logout", async () => {
		const { events, find } = await boot({
			config: { loginRateLimit: { maxAttempts: 1 } },
		});
		const ok = buildCtx({
			...ORIGIN,
			body: { email: "admin@example.com", password: "hunter2" },
		});
		await find("post", "/admin/login").handler(ok.ctx);
		const token = String(ok.res.cookies[0]?.value);
		const out = buildCtx({ ...ORIGIN, cookies: { station_auth: token } });
		await find("post", "/admin/logout").handler(out.ctx);
		for (let i = 0; i < 2; i++) {
			const { ctx } = buildCtx({
				...ORIGIN,
				body: { email: "admin@example.com", password: "wrong" },
			});
			await find("post", "/admin/login").handler(ctx);
		}
		expect(events.map((e) => e.action)).toEqual([
			"login",
			"logout",
			"login_failed",
			"login_throttled",
		]);
		expect(events[0]?.userId).toBe(1);
		expect(events[1]?.userId).toBe(1);
	});

	it("a 403 emits one denied event naming the permission", async () => {
		const { events, find } = await boot({ permissions: ["station.access"] });
		const { ctx, res } = buildCtx({
			...ORIGIN,
			params: { id: "1" },
			cookies: { station_auth: "TOKEN_OK" },
			url: "/admin/users/1",
		});
		await find("get", "/admin/users/:id").handler(ctx);
		expect(res.status).toBe(403);
		expect(events).toEqual([
			expect.objectContaining({
				action: "denied",
				userId: 1,
				resource: "users",
				resourceAction: "show",
				permission: "station.users.show",
				path: "/admin/users/1",
				ip: "203.0.113.9",
			}),
		]);
	});

	it("a missing access permission and a CSRF block are recorded too", async () => {
		const { events, find } = await boot({ permissions: [] });
		const list = buildCtx({ ...ORIGIN, cookies: { station_auth: "TOKEN_OK" } });
		await find("get", "/admin/users").handler(list.ctx);
		vi.spyOn(console, "error").mockImplementation(() => {});
		const forged = buildCtx({
			...ORIGIN,
			csrfProtected: false,
			body: { email: "a@b.c", password: "x" },
			url: "/admin/login",
		});
		await find("post", "/admin/login").handler(forged.ctx);
		expect(events.map((e) => [e.action, e.permission ?? e.path])).toEqual([
			["denied", "station.access"],
			["csrf_denied", "/admin/login"],
		]);
	});

	it("write events carry the request origin", async () => {
		const writes: AuditEvent[] = [];
		const { find } = await boot({ writes });
		const { ctx } = buildCtx({
			...ORIGIN,
			params: { id: "1" },
			cookies: { station_auth: "TOKEN_OK" },
		});
		await find("delete", "/admin/users/:id").handler(ctx);
		expect(writes).toEqual([
			expect.objectContaining({
				action: "destroy",
				ip: "203.0.113.9",
				userAgent: "probe/1.0",
				requestId: "req-42",
			}),
		]);
	});

	it("a throwing sink is logged and never breaks the response", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const auth = buildFakeAuth({});
		const { find } = await bootStation({
			db: buildTableDb([]).db,
			auth: auth.manager,
			config: {
				audit: () => {
					throw new Error("sink down");
				},
			},
			resources: [{ entity: User }],
		});
		const { ctx, res } = buildCtx({
			body: { email: "admin@example.com", password: "wrong" },
		});
		await find("post", "/admin/login").handler(ctx);
		expect(res.status).toBe(401);
		expect(error.mock.calls.flat().join(" ")).toContain("sink down");
	});
});
