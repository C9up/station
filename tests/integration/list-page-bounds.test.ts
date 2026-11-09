/**
 * An oversized `?page=` never reaches the database (bug 221): atlas computes
 * `OFFSET (page-1)*perPage`, and past `Number.MAX_SAFE_INTEGER` the native
 * statement spec rejects the float, which surfaced as a 500.
 */
import "reflect-metadata";
import { beforeEach, describe, expect, it } from "vitest";
import { resetStationProviderFlags } from "../../src/StationProvider.js";
import { bootStation, buildCtx, buildTableDb } from "../__helpers__/harness.js";
import { User } from "../fixtures/User.js";

/** Rejects what the native driver rejects: a number that is not a safe integer. */
function strictDb(rows: ReadonlyArray<Record<string, unknown>>) {
	const table = buildTableDb(rows);
	const check = (params: unknown[]): void => {
		for (const p of params) {
			if (typeof p === "number" && !Number.isSafeInteger(p)) {
				throw new Error(
					`Invalid statement spec: invalid type: floating point \`${p}\`, expected u64`,
				);
			}
		}
	};
	return {
		table,
		db: {
			execute(sql: string, params: unknown[] = []) {
				check(params);
				return table.db.execute(sql, params);
			},
			query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
				check(params);
				if (/OFFSET\s+\d+e\+/i.test(sql)) {
					throw new Error("Invalid statement spec: float offset");
				}
				return table.db.query<T>(sql, params);
			},
		},
	};
}

describe("station > list page bounds (bug 221)", () => {
	beforeEach(() => resetStationProviderFlags());

	it("a 20-digit page redirects to the last page", async () => {
		const { db } = strictDb([
			{ id: 1, name: "a", age: 1 },
			{ id: 2, name: "b", age: 2 },
			{ id: 3, name: "c", age: 3 },
		]);
		const { find } = await bootStation({ db, resources: [{ entity: User }] });
		const { ctx, res } = buildCtx({
			query: { page: "99999999999999999999", perPage: "2" },
		});
		await find("get", "/admin/users").handler(ctx);
		expect(res.status).toBe(302);
		expect(res.location).toBe("/admin/users?page=2&perPage=2");
	});

	it("an empty table redirects to page 1", async () => {
		const { db } = strictDb([]);
		const { find } = await bootStation({ db, resources: [{ entity: User }] });
		const { ctx, res } = buildCtx({
			query: { page: "99999999999999999999", perPage: "100" },
		});
		await find("get", "/admin/users").handler(ctx);
		expect(res.status).toBe(302);
		expect(res.location).toBe("/admin/users?page=1&perPage=100");
	});

	it("the largest page whose offset stays exact still queries normally", async () => {
		const { db } = strictDb([{ id: 1, name: "a", age: 1 }]);
		const { find } = await bootStation({ db, resources: [{ entity: User }] });
		const last = Math.floor(Number.MAX_SAFE_INTEGER / 100) + 1;
		const { ctx, res } = buildCtx({
			query: { page: String(last), perPage: "100" },
		});
		await find("get", "/admin/users").handler(ctx);
		expect(res.status).toBe(302);
		expect(res.location).toBe("/admin/users?page=1&perPage=100");
	});
});
