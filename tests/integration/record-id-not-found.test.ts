/**
 * A record id that cannot name a row of the primary key's type is a 404, not
 * a 500. On Postgres atlas types the bound parameter from the column and
 * refuses a string that does not parse ("parameter $1: 'abc' is not a valid
 * integer"); the fake below refuses the same way.
 */
import "reflect-metadata";
import { BaseEntity, Column, Entity, PrimaryKey } from "@c9up/atlas";
import { beforeEach, describe, expect, it } from "vitest";
import { resetStationProviderFlags } from "../../src/StationProvider.js";
import { bootStation, buildCtx, buildTableDb } from "../__helpers__/harness.js";
import { User } from "../fixtures/User.js";

@Entity("tickets")
class Ticket extends BaseEntity {
	@PrimaryKey({ type: "uuid" }) declare id: string;
	@Column() declare title: string;
}

const I32_MAX = 2_147_483_647;

/** A Postgres-like connection: an INT4 parameter must parse as an i32. */
function postgresLike(seed: ReadonlyArray<Record<string, unknown>>) {
	const table = buildTableDb(seed);
	const query = table.db.query;
	return {
		...table,
		db: {
			...table.db,
			query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
				for (const [i, p] of params.entries()) {
					const s = String(p);
					const n = Number(s);
					if (!/^-?[0-9]+$/.test(s) || Math.abs(n) > I32_MAX) {
						return Promise.reject(
							new Error(`parameter $${i + 1}: '${s}' is not a valid integer`),
						);
					}
				}
				return query<T>(sql, params);
			},
		},
	};
}

const ROUTES = [
	["get", "/admin/users/:id"],
	["get", "/admin/users/:id/edit"],
	["put", "/admin/users/:id"],
	["delete", "/admin/users/:id"],
] as const;

describe("station > an id the primary key cannot hold is a 404 (bug 017)", () => {
	beforeEach(() => resetStationProviderFlags());

	it.each(["abc", "1e3", "99999999999", "new"])(
		"'%s' answers the not-found page on show, edit, update and destroy",
		async (id) => {
			const table = postgresLike([{ id: 1, name: "Ada", age: 36 }]);
			const station = await bootStation({
				db: table.db,
				resources: [{ entity: User }],
			});
			for (const [method, path] of ROUTES) {
				const { ctx, res } = buildCtx({
					params: { id },
					body: { name: "x", age: "1" },
				});
				await station.find(method, path).handler(ctx);
				expect(res.status).toBe(404);
				expect(res.body).toContain("Not Found");
			}
			expect(table.rows.get(1)?.name).toBe("Ada");
		},
	);

	it("a database failure on the lookup still propagates", async () => {
		const table = buildTableDb([]);
		const station = await bootStation({
			db: {
				...table.db,
				query: () => Promise.reject(new Error("connection terminated")),
			},
			resources: [{ entity: User }],
		});
		const { ctx } = buildCtx({ params: { id: "1" } });
		await expect(
			station.find("get", "/admin/users/:id").handler(ctx),
		).rejects.toThrow("connection terminated");
	});

	it("a uuid primary key refuses a non-uuid id without querying", async () => {
		const table = buildTableDb([]);
		const station = await bootStation({
			db: table.db,
			resources: [{ entity: Ticket }],
		});
		const { ctx, res } = buildCtx({ params: { id: "1 OR 1=1" } });
		await station.find("get", "/admin/tickets/:id").handler(ctx);
		expect(res.status).toBe(404);
		expect(table.statements).toEqual([]);
	});
});
