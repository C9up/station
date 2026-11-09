/**
 * Admin permissions live in their own namespace and entering the admin needs
 * an explicit access permission (bug 214): an application grant named
 * `users.edit` for its own features never opens the admin.
 */
import "reflect-metadata";
import { beforeEach, describe, expect, it } from "vitest";
import { resetStationProviderFlags } from "../../src/StationProvider.js";
import {
	bootStation,
	buildCtx,
	buildFakeAuth,
	buildTableDb,
} from "../__helpers__/harness.js";
import { User } from "../fixtures/User.js";

const COOKIE = { station_auth: "TOKEN_OK" };

function seed() {
	return buildTableDb([{ id: 1, name: "alice", age: 30 }]);
}

describe("station > admin permission namespace (bug 214)", () => {
	beforeEach(() => resetStationProviderFlags());

	it("an app-level `users.edit` grant does not open PUT /admin/users/:id", async () => {
		const table = seed();
		const auth = buildFakeAuth({ permissions: ["users.edit"] });
		const { find } = await bootStation({
			db: table.db,
			auth: auth.manager,
			resources: [{ entity: User }],
		});
		const { ctx, res } = buildCtx({
			params: { id: "1" },
			body: { name: "pwn", age: "1" },
			cookies: COOKIE,
		});
		await find("put", "/admin/users/:id").handler(ctx);
		expect(res.status).toBe(403);
		expect(table.rows.get(1)?.name).toBe("alice");
	});

	it("station.access + station.users.edit passes", async () => {
		const table = seed();
		const auth = buildFakeAuth({
			permissions: ["station.access", "station.users.edit"],
		});
		const { find } = await bootStation({
			db: table.db,
			auth: auth.manager,
			resources: [{ entity: User }],
		});
		const { ctx, res } = buildCtx({
			params: { id: "1" },
			body: { name: "bob", age: "2" },
			cookies: COOKIE,
		});
		await find("put", "/admin/users/:id").handler(ctx);
		expect(res.status).toBe(302);
		expect(auth.asked).toEqual(["station.access", "station.users.edit"]);
		expect(table.rows.get(1)?.name).toBe("bob");
	});

	it("an authenticated user without station.access is 403 on every admin route", async () => {
		const auth = buildFakeAuth({ permissions: ["station.users.list"] });
		const { find } = await bootStation({
			db: seed().db,
			auth: auth.manager,
			resources: [{ entity: User }],
		});
		for (const path of ["/admin", "/admin/users"]) {
			const { ctx, res } = buildCtx({ cookies: COOKIE });
			await find("get", path).handler(ctx);
			expect(res.status).toBe(403);
		}
	});

	it("accessPermission: false drops the access gate; the per-action one stays", async () => {
		const auth = buildFakeAuth({ permissions: ["station.users.list"] });
		const { find } = await bootStation({
			db: seed().db,
			auth: auth.manager,
			config: { accessPermission: false },
			resources: [{ entity: User }],
		});
		const list = buildCtx({ cookies: COOKIE });
		await find("get", "/admin/users").handler(list.ctx);
		expect(list.res.status ?? 200).toBe(200);
		const show = buildCtx({ params: { id: "1" }, cookies: COOKIE });
		await find("get", "/admin/users/:id").handler(show.ctx);
		expect(show.res.status).toBe(403);
	});

	it("permissionPrefix renames the whole namespace", async () => {
		const auth = buildFakeAuth({});
		const { find } = await bootStation({
			db: seed().db,
			auth: auth.manager,
			config: { permissionPrefix: "backoffice" },
			resources: [{ entity: User }],
		});
		const { ctx } = buildCtx({ cookies: COOKIE });
		await find("get", "/admin/users").handler(ctx);
		expect(auth.asked).toEqual(["backoffice.access", "backoffice.users.list"]);
	});

	it("rejects an empty permissionPrefix at start", async () => {
		await expect(
			bootStation({
				db: seed().db,
				auth: buildFakeAuth({}).manager,
				config: { permissionPrefix: "" },
				resources: [{ entity: User }],
			}),
		).rejects.toThrow(/permissionPrefix/);
	});
});
