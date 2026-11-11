/**
 * A write whose payload is not an object fails as a whole: rune reports it on
 * the root (field "", rule "object"), and the admin surfaces that reason as a
 * form-level error instead of keying it under "" (where no field renders it)
 * or validating an empty object in its place.
 */
import "reflect-metadata";
import { beforeEach, describe, expect, it } from "vitest";
import { resetStationProviderFlags } from "../../src/StationProvider.js";
import { bootStation, buildCtx, buildTableDb } from "../__helpers__/harness.js";
import { User } from "../fixtures/User.js";

function withPayload(
	ctx: ReturnType<typeof buildCtx>["ctx"],
	payload: unknown,
): void {
	ctx.request.body = () => payload;
}

function flashSession() {
	let writing: Record<string, unknown> = {};
	let previous: Record<string, unknown> = {};
	return {
		session: {
			flash(key: string, value: unknown): void {
				writing[key] = value;
			},
			flashAll(input: Record<string, unknown>): void {
				Object.assign(writing, input);
			},
			flashMessages: { all: () => ({ ...previous }) },
		},
		written: () => writing,
		commit(): void {
			previous = writing;
			writing = {};
		},
	};
}

async function boot() {
	const table = buildTableDb([{ id: 1, name: "Ada", age: 36 }]);
	const station = await bootStation({
		db: table.db,
		resources: [{ entity: User }],
	});
	return { table, station };
}

describe("station > a non-object write payload (root validation failure)", () => {
	beforeEach(() => resetStationProviderFlags());

	it("a JSON client gets the root failure on field '' and nothing is written", async () => {
		const { table, station } = await boot();
		const { ctx, res } = buildCtx({
			params: { id: "1" },
			headers: { accept: "application/json" },
		});
		withPayload(ctx, [{ name: "Mallory" }]);
		await station.find("put", "/admin/users/:id").handler(ctx);
		expect(res.status).toBe(422);
		expect(res.body).toContain('"field":""');
		expect(res.body).not.toContain('"field":"name"');
		expect(table.rows.get(1)?.name).toBe("Ada");
	});

	it("an HTML form without a session shows the root failure as a form-level error", async () => {
		const { table, station } = await boot();
		const { ctx, res } = buildCtx({ params: { id: "1" } });
		withPayload(ctx, "name=Mallory");
		await station.find("put", "/admin/users/:id").handler(ctx);
		expect(res.status).toBe(422);
		const body = res.body ?? "";
		expect(body).toMatch(/<p class="st-form-error" role="alert">[^<]+<\/p>/);
		expect(body).not.toContain("st-field-error");
		expect(table.rows.get(1)?.name).toBe("Ada");
	});

	it("with a session the root failure is flashed and shown by the next form GET", async () => {
		const { table, station } = await boot();
		const flash = flashSession();
		const post = buildCtx({ params: { id: "1" } });
		post.ctx.session = flash.session;
		withPayload(post.ctx, null);
		await station.find("post", "/admin/users").handler(post.ctx);
		expect(post.res.status).toBe(302);
		expect(post.res.location).toBe("/admin/users/new");
		expect(table.rows.size).toBe(1);
		const errors = flash.written().errors;
		expect(errors).toEqual({});
		expect(flash.written().errorsBag).toEqual({
			E_VALIDATION_ERROR: expect.any(String),
		});

		flash.commit();
		const get = buildCtx();
		get.ctx.session = flash.session;
		await station.find("get", "/admin/users/new").handler(get.ctx);
		expect(get.res.body).toMatch(
			/<p class="st-form-error" role="alert">[^<]+<\/p>/,
		);
	});
});
