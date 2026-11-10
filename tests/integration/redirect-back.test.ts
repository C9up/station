/**
 * `redirect().back()` after a failed admin write (bug 228): a Referer is a
 * full URL, while ream's `request.url()` is the path only, so comparing the
 * two never matched and every user landed on the fallback. The Referer's
 * origin (scheme + host) is now checked against the request's own and the
 * redirect goes to its path and query.
 */
import "reflect-metadata";
import { beforeEach, describe, expect, it } from "vitest";
import { resetStationProviderFlags } from "../../src/StationProvider.js";
import {
	bootStation,
	buildCtx,
	buildTableDb,
	type CtxOptions,
} from "../__helpers__/harness.js";
import { User } from "../fixtures/User.js";

const FALLBACK = "/admin/users/new";

async function failCreate(
	referer: string | undefined,
	opts: Pick<CtxOptions, "host" | "secure"> = {},
): Promise<string> {
	const { find } = await bootStation({
		db: buildTableDb([]).db,
		resources: [{ entity: User }],
	});
	const { ctx, res } = buildCtx({
		...opts,
		body: { name: "x", age: "not-a-number" },
		headers: referer === undefined ? {} : { referer },
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

const HTTPS = { host: "admin.example.com", secure: true };

describe("station > redirect back after a failed write (bug 228)", () => {
	beforeEach(() => resetStationProviderFlags());

	it("follows a same-origin absolute Referer to its path and query", async () => {
		expect(
			await failCreate("https://admin.example.com/admin/users?page=2", HTTPS),
		).toBe("/admin/users?page=2");
	});

	it("follows a relative Referer, query included", async () => {
		expect(await failCreate("/admin/users?page=2")).toBe("/admin/users?page=2");
	});

	it("falls back when the Referer's scheme differs from the request's", async () => {
		expect(
			await failCreate("http://admin.example.com/admin/users", HTTPS),
		).toBe(FALLBACK);
		expect(
			await failCreate("https://admin.example.com/admin/users", {
				host: "admin.example.com",
			}),
		).toBe(FALLBACK);
	});

	it("falls back when the Referer's port differs from the request's", async () => {
		expect(
			await failCreate("https://admin.example.com:8443/admin/users", HTTPS),
		).toBe(FALLBACK);
	});

	it("falls back for a cross-host, protocol-relative or backslash Referer", async () => {
		for (const referer of [
			"https://evil.example/admin/users",
			"//evil.example/admin/users",
			"/\\evil.example/admin/users",
		]) {
			expect(await failCreate(referer, HTTPS)).toBe(FALLBACK);
		}
	});

	it("falls back when dot segments resolve to a protocol-relative path", async () => {
		for (const referer of [
			"/.//evil.example/admin",
			"/admin/..//evil.example",
			"https://admin.example.com/.//evil.example",
		]) {
			expect(await failCreate(referer, HTTPS)).toBe(FALLBACK);
		}
	});

	it("falls back without a Referer, or without a Host to check it against", async () => {
		expect(await failCreate(undefined, HTTPS)).toBe(FALLBACK);
		expect(
			await failCreate("https://admin.example.com/admin/users", {
				secure: true,
			}),
		).toBe(FALLBACK);
	});
});
