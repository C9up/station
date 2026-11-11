/**
 * The admin sign-in never shows the auth backend's own error text: warden's
 * authenticate() turns any thrown error (a database outage, a bug in the
 * user lookup) into `{ authenticated: false, error: err.message }`, and that
 * message is for the operator, not for whoever submitted the form.
 */
import "reflect-metadata";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetStationProviderFlags } from "../../src/StationProvider.js";
import type { SecurityAuditEvent } from "../../src/types.js";
import {
	bootStation,
	buildCtx,
	buildFakeAuth,
	buildTableDb,
} from "../__helpers__/harness.js";
import { User } from "../fixtures/User.js";

const BACKEND_ERROR = "connect ECONNREFUSED db.internal:5432";

async function boot(result: Record<string, unknown>) {
	const auth = buildFakeAuth({});
	auth.manager.authenticate = () => Promise.resolve(result);
	const events: SecurityAuditEvent[] = [];
	const booted = await bootStation({
		db: buildTableDb([]).db,
		auth: auth.manager,
		config: { audit: (e) => void events.push(e) },
		resources: [{ entity: User }],
	});
	const login = booted.find("post", "/admin/login");
	return {
		events,
		async post(headers: Record<string, string> = {}) {
			const { ctx, res } = buildCtx({
				body: { email: "admin@example.com", password: "hunter2" },
				headers,
			});
			await login.handler(ctx);
			return res;
		},
	};
}

describe("station > login never prints the backend's error (bug 015)", () => {
	beforeEach(() => resetStationProviderFlags());

	it("a refused sign-in shows the fixed message, never result.error", async () => {
		const { post, events } = await boot({
			authenticated: false,
			error: BACKEND_ERROR,
		});
		const html = await post();
		expect(html.status).toBe(401);
		expect(html.body).toContain("Invalid email or password.");
		expect(html.body).not.toContain("ECONNREFUSED");

		const json = await post({ accept: "application/json" });
		expect(json.status).toBe(401);
		expect(JSON.parse(json.body ?? "null")).toEqual({
			error: "Invalid email or password.",
			code: "E_STATION_INVALID_CREDENTIALS",
		});
		expect(events.map((e) => e.action)).toEqual([
			"login_failed",
			"login_failed",
		]);
	});

	it("a backend crash is a 503 logged for the operator, not a failed login", async () => {
		const { post, events } = await boot({
			authenticated: false,
			error: BACKEND_ERROR,
			strategyCrash: true,
		});
		const logged = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const res = await post();
			expect(res.status).toBe(503);
			expect(res.body).toContain("Sign-in is temporarily unavailable.");
			expect(res.body).not.toContain("ECONNREFUSED");
			expect(logged).toHaveBeenCalledWith(
				expect.stringContaining(BACKEND_ERROR),
			);
		} finally {
			logged.mockRestore();
		}
		expect(events.map((e) => e.action)).not.toContain("login_failed");
	});
});
