/**
 * A column the resource renders as a password input is a secret everywhere,
 * not only in the form: its submitted value is never flashed into the session
 * and its stored value never reaches an audit snapshot, even when its name
 * does not look like a credential.
 */
import "reflect-metadata";
import { BaseEntity, Column, Entity, PrimaryKey } from "@c9up/atlas";
import { beforeEach, describe, expect, it } from "vitest";
import type { AuditEvent } from "../../src/types.js";
import { resetStationProviderFlags } from "../../src/warnedOnce.js";
import { bootStation, buildCtx, buildTableDb } from "../__helpers__/harness.js";

@Entity("agents")
class Agent extends BaseEntity {
	@PrimaryKey() declare id: number;
	@Column() declare email: string;
	@Column() declare passcode: string;
}

const STORED = "stored-passcode-7731";

async function boot(
	events: AuditEvent[],
	views: { show?: { columns: string[] } } = {},
) {
	const table = buildTableDb([{ id: 1, email: "a@x.io", passcode: STORED }]);
	const station = await bootStation({
		db: table.db,
		resources: [
			{
				entity: Agent,
				formFields: { passcode: { inputType: "password" } },
				audit: (e) => void events.push(e),
				...views,
			},
		],
	});
	return { table, station };
}

describe("station > a formFields password input is a secret (bug 014)", () => {
	beforeEach(() => resetStationProviderFlags());

	it("a failed edit never flashes the typed passcode into the session", async () => {
		const { station } = await boot([]);
		const flashed: Record<string, unknown> = {};
		const { ctx, res } = buildCtx({
			params: { id: "1" },
			body: { email: 42, passcode: "hunter2" },
		});
		ctx.session = {
			flash: (key: string, value: unknown) => {
				flashed[key] = value;
			},
			flashAll: (input: Record<string, unknown>) => {
				Object.assign(flashed, input);
			},
			flashMessages: { all: () => ({}) },
		};
		await station.find("put", "/admin/agents/:id").handler(ctx);
		expect(res.status).toBe(302);
		expect(flashed).toHaveProperty("email");
		expect(flashed).not.toHaveProperty("passcode");
		expect(JSON.stringify(flashed)).not.toContain("hunter2");
	});

	it("a failed edit without a session does not echo the passcode either", async () => {
		const { station } = await boot([]);
		const { ctx, res } = buildCtx({
			params: { id: "1" },
			body: { email: 42, passcode: "hunter2" },
		});
		await station.find("put", "/admin/agents/:id").handler(ctx);
		expect(res.status).toBe(422);
		expect(res.body).not.toContain("hunter2");
	});

	it("audit snapshots redact the passcode and report its change by name", async () => {
		const events: AuditEvent[] = [];
		const { table, station } = await boot(events);
		const { ctx, res } = buildCtx({
			params: { id: "1" },
			body: { email: "b@x.io", passcode: "hunter2" },
		});
		await station.find("put", "/admin/agents/:id").handler(ctx);
		expect(res.status).toBe(302);
		expect(table.rows.get(1)?.passcode).toBe("hunter2");
		expect(events).toHaveLength(1);
		const [event] = events;
		expect(event?.before?.passcode).toBe("[redacted]");
		expect(event?.after?.passcode).toBe("[redacted]");
		expect(event?.redactedChanges).toEqual(["passcode"]);
		expect(JSON.stringify(event)).not.toMatch(/hunter2|stored-passcode/);

		events.length = 0;
		const destroy = buildCtx({ params: { id: "1" } });
		await station.find("delete", "/admin/agents/:id").handler(destroy.ctx);
		expect(events[0]?.before?.passcode).toBe("[redacted]");
	});

	it("the list and show pages leave the passcode out by default (bug 029)", async () => {
		const { station } = await boot([]);
		const list = buildCtx({});
		await station.find("get", "/admin/agents").handler(list.ctx);
		expect(list.res.body).toContain("a@x.io");
		expect(list.res.body).not.toContain(STORED);

		const show = buildCtx({ params: { id: "1" } });
		await station.find("get", "/admin/agents/:id").handler(show.ctx);
		expect(show.res.body).toContain("a@x.io");
		expect(show.res.body).not.toContain(STORED);
	});

	it("naming the passcode in show.columns is the opt-in that shows it", async () => {
		const { station } = await boot([], {
			show: { columns: ["email", "passcode"] },
		});
		const show = buildCtx({ params: { id: "1" } });
		await station.find("get", "/admin/agents/:id").handler(show.ctx);
		expect(show.res.body).toContain(STORED);
	});
});
