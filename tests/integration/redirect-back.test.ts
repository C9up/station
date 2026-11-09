/**
 * `redirect().back()` after a failed admin write (bug 228): a Referer is a
 * full URL, while ream's `request.url()` is the path only, so comparing the
 * two never matched and every user landed on the fallback. The Referer's host
 * is now checked against the request's own and the redirect goes to its path.
 */
import "reflect-metadata";
import { beforeEach, describe, expect, it } from "vitest";
import { resetStationProviderFlags } from "../../src/StationProvider.js";
import { bootStation, buildCtx, buildTableDb } from "../__helpers__/harness.js";
import { User } from "../fixtures/User.js";

async function failCreate(headers: Record<string, string>): Promise<string> {
	const { find } = await bootStation({
		db: buildTableDb([]).db,
		resources: [{ entity: User }],
	});
	const { ctx, res } = buildCtx({
		body: { name: "x", age: "not-a-number" },
		headers,
		url: "/admin/users",
	});
	ctx.session = {
		flash() {},
		flashAll() {},
		flashMessages: { all: () => ({}) },
	};
	await find("post", "/admin/users").handler(ctx);
	expect(res.status).toBe(302);
	return String(res.location);
}

describe("station > redirect back after a failed write (bug 228)", () => {
	beforeEach(() => resetStationProviderFlags());

	it("follows a same-host absolute Referer to its path", async () => {
		expect(
			await failCreate({
				host: "admin.example.com",
				referer: "https://admin.example.com/admin/users?page=2",
			}),
		).toBe("/admin/users");
	});

	it("follows a relative Referer", async () => {
		expect(await failCreate({ referer: "/admin/users" })).toBe("/admin/users");
	});

	it("falls back for a cross-host, protocol-relative or backslash Referer", async () => {
		for (const referer of [
			"https://evil.example/admin/users",
			"//evil.example/admin/users",
			"/\\evil.example/admin/users",
		]) {
			expect(await failCreate({ host: "admin.example.com", referer })).toBe(
				"/admin/users/new",
			);
		}
	});

	it("falls back without a Referer, or without a Host to check it against", async () => {
		expect(await failCreate({ host: "admin.example.com" })).toBe(
			"/admin/users/new",
		);
		expect(
			await failCreate({ referer: "https://admin.example.com/admin/users" }),
		).toBe("/admin/users/new");
	});
});
