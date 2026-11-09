/**
 * The `_method` override only reaches actions the resource enables (bug 211):
 * a resource without `destroy` cannot be deleted through POST `_method=DELETE`,
 * and one without `edit` cannot be updated through `_method=PUT`.
 */
import "reflect-metadata";
import { beforeEach, describe, expect, it } from "vitest";
import { resetStationProviderFlags } from "../../src/StationProvider.js";
import { bootStation, buildCtx, buildTableDb } from "../__helpers__/harness.js";
import { User } from "../fixtures/User.js";

function seed() {
	return buildTableDb([{ id: 1, name: "alice", age: 30 }]);
}

describe("station > method override honours the enabled actions (bug 211)", () => {
	beforeEach(() => resetStationProviderFlags());

	it("_method=DELETE is 405 and keeps the row when destroy is not enabled", async () => {
		const table = seed();
		const { find } = await bootStation({
			db: table.db,
			resources: [{ entity: User, actions: ["list", "show", "edit"] }],
		});
		const { ctx, res } = buildCtx({
			params: { id: "1" },
			body: { _method: "DELETE" },
		});
		await find("post", "/admin/users/:id").handler(ctx);
		expect(res.status).toBe(405);
		expect(table.rows.has(1)).toBe(true);
	});

	it("without edit but with destroy, _method=DELETE deletes and _method=PUT is 405", async () => {
		const table = seed();
		const { find } = await bootStation({
			db: table.db,
			resources: [{ entity: User, actions: ["list", "destroy"] }],
		});
		const put = buildCtx({
			params: { id: "1" },
			body: { _method: "PUT", name: "mallory", age: "1" },
		});
		await find("post", "/admin/users/:id").handler(put.ctx);
		expect(put.res.status).toBe(405);
		expect(table.rows.get(1)?.name).toBe("alice");

		const del = buildCtx({ params: { id: "1" }, body: { _method: "DELETE" } });
		await find("post", "/admin/users/:id").handler(del.ctx);
		expect(del.res.status).toBe(302);
		expect(table.rows.has(1)).toBe(false);
	});

	it("mounts no override route when neither edit nor destroy is enabled", async () => {
		const { routes } = await bootStation({
			db: seed().db,
			resources: [{ entity: User, actions: ["list", "show"] }],
		});
		expect(
			routes.some((r) => r.method === "post" && r.path === "/admin/users/:id"),
		).toBe(false);
	});
});
