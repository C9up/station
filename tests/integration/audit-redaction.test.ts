/**
 * Audit snapshots never carry secret column values by default (bug 216): a
 * `serializeAs: null` or credential-named column is replaced with
 * "[redacted]", an edit still reports that it changed, and `auditSecrets`
 * opts back in.
 */
import "reflect-metadata";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetStationProviderFlags } from "../../src/StationProvider.js";
import type { AuditEvent } from "../../src/types.js";
import { bootStation, buildCtx, buildTableDb } from "../__helpers__/harness.js";
import { Account } from "../fixtures/Account.js";

const HASH = "$argon2id$v=19$m=65536$SECRETHASH";

function seed() {
	return buildTableDb([
		{
			id: 1,
			email: "root@x.io",
			password: HASH,
			api_token: "tok_LIVE",
			is_admin: true,
		},
	]);
}

function only(events: AuditEvent[]): AuditEvent {
	expect(events).toHaveLength(1);
	const [event] = events;
	if (event === undefined) throw new Error("no audit event");
	return event;
}

describe("station > audit redaction (bug 216)", () => {
	beforeEach(() => resetStationProviderFlags());

	it("a destroy event redacts the secret columns of its before image", async () => {
		const events: AuditEvent[] = [];
		const { find } = await bootStation({
			db: seed().db,
			resources: [{ entity: Account, audit: (e) => void events.push(e) }],
		});
		const { ctx } = buildCtx({ params: { id: "1" } });
		await find("delete", "/admin/accounts/:id").handler(ctx);
		const event = only(events);
		expect(event.before).toMatchObject({
			email: "root@x.io",
			password: "[redacted]",
			apiToken: "[redacted]",
			isAdmin: true,
		});
		expect(JSON.stringify(event)).not.toContain("SECRETHASH");
	});

	it("an edit reports a changed secret by name, never by value", async () => {
		const events: AuditEvent[] = [];
		const { find } = await bootStation({
			db: seed().db,
			resources: [
				{
					entity: Account,
					editable: ["email", "password"],
					audit: (e) => void events.push(e),
				},
			],
		});
		const changed = buildCtx({
			params: { id: "1" },
			body: { email: "root@x.io", password: "new-hash" },
		});
		await find("put", "/admin/accounts/:id").handler(changed.ctx);
		const event = only(events);
		expect(event.redactedChanges).toEqual(["password"]);
		expect(event.after?.password).toBe("[redacted]");
		expect(JSON.stringify(event)).not.toMatch(/SECRETHASH|new-hash/);

		events.length = 0;
		const untouched = buildCtx({
			params: { id: "1" },
			body: { email: "other@x.io", password: "" },
		});
		await find("put", "/admin/accounts/:id").handler(untouched.ctx);
		expect(only(events).redactedChanges).toEqual([]);
	});

	it("resetStationProviderFlags() re-arms the audit shallow-copy warning", async () => {
		// A value neither structuredClone (function) nor JSON (bigint) can copy
		// forces the warned shallow-copy fallback.
		const uncloneable = { format: () => "x", serial: 1n };
		const destroyOnce = async () => {
			const { find } = await bootStation({
				db: buildTableDb([
					{ id: 1, email: uncloneable, password: HASH, is_admin: false },
				]).db,
				resources: [{ entity: Account, audit: () => undefined }],
			});
			const { ctx } = buildCtx({ params: { id: "1" } });
			await find("delete", "/admin/accounts/:id").handler(ctx);
		};
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			await destroyOnce();
			const shallow = (call: unknown[]) =>
				String(call[0]).includes("using a shallow copy");
			expect(warn.mock.calls.filter(shallow)).toHaveLength(1);
			resetStationProviderFlags();
			await destroyOnce();
			expect(warn.mock.calls.filter(shallow)).toHaveLength(2);
		} finally {
			warn.mockRestore();
		}
	});

	it("auditSecrets: true keeps the raw values", async () => {
		const events: AuditEvent[] = [];
		const { find } = await bootStation({
			db: seed().db,
			resources: [
				{
					entity: Account,
					auditSecrets: true,
					audit: (e) => void events.push(e),
				},
			],
		});
		const { ctx } = buildCtx({ params: { id: "1" } });
		await find("delete", "/admin/accounts/:id").handler(ctx);
		expect(only(events).before?.password).toBe(HASH);
	});
});
