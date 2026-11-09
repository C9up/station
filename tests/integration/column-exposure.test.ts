/**
 * Secret columns and the editable allow-list (bugs 209, 210).
 *
 * A column the model hides (`serializeAs: null`) or whose name marks it as a
 * secret is never rendered nor writable unless the resource names it, the
 * form never pre-fills a secret, and a column hidden from the form is neither
 * writable nor default-filled.
 */
import "reflect-metadata";
import { beforeEach, describe, expect, it } from "vitest";
import { resetStationProviderFlags } from "../../src/StationProvider.js";
import { bootStation, buildCtx, buildTableDb } from "../__helpers__/harness.js";
import { Account } from "../fixtures/Account.js";

const HASH = "$argon2id$v=19$m=65536$SECRETHASH";
const TOKEN = "tok_LIVE_123";

function seed() {
	return buildTableDb([
		{
			id: 1,
			email: "root@x.io",
			password: HASH,
			api_token: TOKEN,
			is_admin: true,
		},
	]);
}

function row(table: ReturnType<typeof seed>): Record<string, unknown> {
	const r = table.rows.get(1);
	if (r === undefined) throw new Error("row 1 vanished");
	return r;
}

describe("station > secret columns are not rendered (bug 209)", () => {
	beforeEach(() => resetStationProviderFlags());

	it("list, show and edit never contain a serializeAs:null or token value", async () => {
		const table = seed();
		const { find } = await bootStation({
			db: table.db,
			resources: [{ entity: Account }],
		});
		for (const [path, params] of [
			["/admin/accounts", {}],
			["/admin/accounts/:id", { id: "1" }],
			["/admin/accounts/:id/edit", { id: "1" }],
		] as const) {
			const { ctx, res } = buildCtx({ params });
			await find("get", path).handler(ctx);
			expect(res.status ?? 200).toBe(200);
			expect(res.body).toContain("root@x.io");
			expect(res.body).not.toContain("SECRETHASH");
			expect(res.body).not.toContain(TOKEN);
			expect(res.body).not.toContain(">password<");
		}
	});

	it("an explicitly editable password renders as an empty password input", async () => {
		const table = seed();
		const { find } = await bootStation({
			db: table.db,
			resources: [{ entity: Account, editable: ["email", "password"] }],
		});
		const { ctx, res } = buildCtx({ params: { id: "1" } });
		await find("get", "/admin/accounts/:id/edit").handler(ctx);
		expect(res.body).toContain(
			'<input id="f-password" type="password" name="password" value="">',
		);
		expect(res.body).not.toContain("SECRETHASH");
	});

	it("list.columns / show.columns restrict what each view renders", async () => {
		const table = seed();
		const { find } = await bootStation({
			db: table.db,
			resources: [
				{
					entity: Account,
					list: { columns: ["email"] },
					show: { columns: ["id", "email"] },
				},
			],
		});
		const list = buildCtx();
		await find("get", "/admin/accounts").handler(list.ctx);
		expect(list.res.body).toContain("<th>email</th>");
		expect(list.res.body).not.toContain("<th>id</th>");
		expect(list.res.body).not.toContain("<th>isAdmin</th>");

		const show = buildCtx({ params: { id: "1" } });
		await find("get", "/admin/accounts/:id").handler(show.ctx);
		expect(show.res.body).toContain("<dt>email</dt>");
		expect(show.res.body).not.toContain("<dt>isAdmin</dt>");
	});

	it("an allow-list naming an unknown column fails at mount", async () => {
		const table = seed();
		await expect(
			bootStation({
				db: table.db,
				resources: [{ entity: Account, list: { columns: ["emial"] } }],
			}),
		).rejects.toThrow(/emial/);
	});
});

describe("station > editable allow-list (bug 210)", () => {
	beforeEach(() => resetStationProviderFlags());

	it("a hidden boolean keeps its stored value across an honest edit", async () => {
		const table = seed();
		const { find } = await bootStation({
			db: table.db,
			resources: [
				{ entity: Account, formFields: { isAdmin: { hidden: true } } },
			],
		});
		const form = buildCtx({ params: { id: "1" } });
		await find("get", "/admin/accounts/:id/edit").handler(form.ctx);
		expect(form.res.body).not.toContain('name="isAdmin"');

		const { ctx, res } = buildCtx({
			params: { id: "1" },
			body: { email: "new@x.io" },
		});
		await find("put", "/admin/accounts/:id").handler(ctx);
		expect(res.status).toBe(302);
		expect(row(table).email).toBe("new@x.io");
		expect(row(table).is_admin).toBe(true);
	});

	it("a hidden column and a secret column in a forged body are dropped", async () => {
		const table = seed();
		row(table).is_admin = false;
		const { find } = await bootStation({
			db: table.db,
			resources: [
				{ entity: Account, formFields: { isAdmin: { hidden: true } } },
			],
		});
		const { ctx, res } = buildCtx({
			params: { id: "1" },
			body: {
				email: "root@x.io",
				isAdmin: "1",
				password: "plaintext",
				apiToken: "forged",
			},
		});
		await find("put", "/admin/accounts/:id").handler(ctx);
		expect(res.status).toBe(302);
		expect(row(table).is_admin).toBe(false);
		expect(row(table).password).toBe(HASH);
		expect(row(table).api_token).toBe(TOKEN);
	});

	it("editable is the only source of writable keys, on create and edit", async () => {
		const table = seed();
		const { find } = await bootStation({
			db: table.db,
			resources: [{ entity: Account, editable: ["email"] }],
		});
		const edit = buildCtx({
			params: { id: "1" },
			body: { email: "e@x.io", isAdmin: "" },
		});
		await find("put", "/admin/accounts/:id").handler(edit.ctx);
		expect(edit.res.status).toBe(302);
		expect(row(table).is_admin).toBe(true);

		const form = buildCtx();
		await find("get", "/admin/accounts/new").handler(form.ctx);
		expect(form.res.body).toContain('name="email"');
		expect(form.res.body).not.toContain('name="isAdmin"');
	});

	it("an editable secret keeps its value when submitted empty, changes when filled", async () => {
		const table = seed();
		const { find } = await bootStation({
			db: table.db,
			resources: [{ entity: Account, editable: ["email", "password"] }],
		});
		const empty = buildCtx({
			params: { id: "1" },
			body: { email: "root@x.io", password: "" },
		});
		await find("put", "/admin/accounts/:id").handler(empty.ctx);
		expect(empty.res.status).toBe(302);
		expect(row(table).password).toBe(HASH);

		const filled = buildCtx({
			params: { id: "1" },
			body: { email: "root@x.io", password: "new-hash" },
		});
		await find("put", "/admin/accounts/:id").handler(filled.ctx);
		expect(row(table).password).toBe("new-hash");
	});

	it("editable naming the primary key or an unknown column fails at mount", async () => {
		await expect(
			bootStation({
				db: seed().db,
				resources: [{ entity: Account, editable: ["id", "email"] }],
			}),
		).rejects.toThrow(/'id'/);
		resetStationProviderFlags();
		await expect(
			bootStation({
				db: seed().db,
				resources: [{ entity: Account, editable: ["nope"] }],
			}),
		).rejects.toThrow(/'nope'/);
	});
});
