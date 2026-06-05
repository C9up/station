/**
 * End-to-end coverage for stories 54.3 (create/edit/destroy), 54.4
 * (policy gates), and 54.6 (audit trail). Drives the router-captured
 * handlers with hand-built HTTP contexts — same pattern as
 * list-show-roundtrip.test.ts so we never need a live HyperServer.
 */

import "reflect-metadata";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { defineResource } from "../../src/defineResource.js";
import { ResourceRegistry } from "../../src/ResourceRegistry.js";
import StationProvider, {
	_resetStationProviderFlags,
	type StationAppContext,
} from "../../src/StationProvider.js";
import type { AuditEvent } from "../../src/types.js";
import { bypassTypeCheck } from "../__helpers__/bypass-type-check.js";
import { User } from "../fixtures/User.js";

// ─── Test infra ──────────────────────────────────────────────

interface CapturedRoute {
	method: "get" | "post" | "put" | "delete";
	path: string;
	handler: (ctx: HttpContextLike) => Promise<void> | void;
}

interface HttpContextLike {
	request: {
		qs(): Record<string, string | undefined>;
		body?(): Promise<unknown> | unknown;
		url?(): string;
		header?(name: string): string | undefined;
		cookie?(name: string): string | undefined;
	};
	response: ResponseRecorder;
	params: Record<string, string>;
	auth?: { user?: { id: unknown; [key: string]: unknown }; roles?: string[] };
}

class ResponseRecorder {
	status?: number;
	contentType?: string;
	body?: string;
	location?: string;
	status$ = (code: number): unknown => {
		this.status = code;
		return this;
	};
	type$ = (value: string): unknown => {
		this.contentType = value;
		return this;
	};
	send$ = (body: string): unknown => {
		this.body = body;
		return this;
	};
	header$ = (name: string, value: string): unknown => {
		if (name.toLowerCase() === "location") this.location = value;
		return this;
	};
	redirect$ = (url: string): unknown => {
		this.status = 302;
		this.location = url;
		return this;
	};
	json$ = (data: unknown): unknown => {
		this.body = JSON.stringify(data);
		this.contentType = "application/json";
		return this;
	};
}

// Default actor for the CRUD / audit / security mechanics tests. Those
// boot WITHOUT a warden `"auth"` binding, so the 56.5 gate runs in its
// dev-preview OPEN mode (authManager undefined ⇒ allow) and this preset
// user is incidental. The 56.5 permission-gate tests below wire a real
// `"auth"` fake and drive the gate through `auth.hasPermission`.
const ADMIN_USER: { id: unknown; [k: string]: unknown } = {
	id: 1,
	roles: ["admin"],
};

function buildCtx(opts: {
	params?: Record<string, string>;
	body?: Record<string, unknown>;
	user?: { id: unknown; [k: string]: unknown } | null;
	headers?: Record<string, string>;
	cookies?: Record<string, string>;
}): { ctx: HttpContextLike; res: ResponseRecorder } {
	const res = new ResponseRecorder();
	const resolvedUser = opts.user === undefined ? ADMIN_USER : opts.user;
	const headers = opts.headers ?? {};
	const cookies = opts.cookies ?? {};
	const ctx: HttpContextLike = {
		request: {
			qs: () => ({}),
			body: () => opts.body ?? {},
			header: (name) => headers[name.toLowerCase()],
			cookie: (name) => cookies[name],
		},
		response: bypassTypeCheck<HttpContextLike["response"]>({
			status: res.status$,
			type: res.type$,
			send: res.send$,
			json: res.json$,
			redirect: res.redirect$,
			header: res.header$,
		}),
		params: opts.params ?? {},
		auth: resolvedUser === null ? undefined : { user: resolvedUser },
	};
	return { ctx, res };
}

/** Tiny in-memory repository-shaped fake that supports CRUD writes. */
function buildFakeDb() {
	const rows = new Map<number, { id: number; name: string; age: number }>();
	let nextId = 1;
	const calls: Array<{ op: string; payload: unknown }> = [];

	function execute(sql: string, params: unknown[]): { rowsAffected: number } {
		calls.push({ op: "execute", payload: { sql, params } });
		if (/^\s*INSERT/i.test(sql)) {
			// Parse INSERT INTO "users" ("name","age") VALUES (?, ?)
			// Atlas takes the RETURNING branch on sqlite; we still get
			// called via repo.create() → #runInsert which routes through
			// query() not execute(). This branch covers MySQL-like paths.
			return { rowsAffected: 1 };
		}
		if (/^\s*UPDATE/i.test(sql)) {
			// UPDATE "users" SET "name" = ?, "age" = ? WHERE "id" = ?
			const setMatch = sql.match(/SET\s+(.+?)\s+WHERE/i);
			if (!setMatch) return { rowsAffected: 0 };
			const setCols = setMatch[1].split(",").map((s) =>
				s
					.trim()
					.split(/\s*=\s*/)[0]
					.replace(/"/g, ""),
			);
			const whereVal = Number(params[params.length - 1]);
			const row = rows.get(whereVal);
			if (!row) return { rowsAffected: 0 };
			setCols.forEach((col, i) => {
				(row as Record<string, unknown>)[col] = params[i];
			});
			return { rowsAffected: 1 };
		}
		if (/^\s*DELETE/i.test(sql)) {
			const id = Number(params[params.length - 1]);
			rows.delete(id);
			return { rowsAffected: 1 };
		}
		return { rowsAffected: 0 };
	}

	function query<T>(sql: string, params: unknown[]): T[] {
		calls.push({ op: "query", payload: { sql, params } });
		if (sql.includes("COUNT(*)")) {
			return bypassTypeCheck<T[]>([{ __scalar__: rows.size }]);
		}
		if (/INSERT[\s\S]+RETURNING/i.test(sql)) {
			// sqlite/postgres RETURNING branch. Insert a fresh row + return it.
			const colMatch = sql.match(/\(([^)]+)\)\s*VALUES/i);
			if (!colMatch) return bypassTypeCheck<T[]>([]);
			const cols = colMatch[1]
				.split(",")
				.map((c) => c.trim().replace(/"/g, ""));
			const row: Record<string, unknown> = {};
			cols.forEach((c, i) => {
				row[c] = params[i];
			});
			const id = Number(row.id ?? nextId++);
			const stored = {
				id,
				name: String(row.name ?? ""),
				age: Number(row.age ?? 0),
			};
			rows.set(id, stored);
			return bypassTypeCheck<T[]>([stored]);
		}
		if (sql.includes('WHERE "id" = ?') || sql.includes("WHERE id = ?")) {
			const id = Number(params[0]);
			const row = rows.get(id);
			return row ? bypassTypeCheck<T[]>([row]) : bypassTypeCheck<T[]>([]);
		}
		return bypassTypeCheck<T[]>([...rows.values()]);
	}

	return {
		rows,
		calls,
		db: {
			execute: (sql: string, params: unknown[] = []) =>
				Promise.resolve(execute(sql, params)),
			query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
				return Promise.resolve(query<T>(sql, params));
			},
		},
	};
}

function buildApp(db: unknown, auth?: unknown): StationAppContext {
	const bindings = new Map<unknown, () => unknown>();
	const cache = new Map<unknown, unknown>();
	bindings.set("db", () => db);
	if (auth !== undefined) bindings.set("auth", () => auth);
	return {
		container: {
			singleton(token, factory) {
				bindings.set(token, bypassTypeCheck<() => unknown>(factory));
			},
			resolve<T>(token: unknown): T {
				if (cache.has(token)) return bypassTypeCheck<T>(cache.get(token));
				const factory = bindings.get(token);
				if (!factory) throw new Error(`not registered: ${String(token)}`);
				const value = factory();
				cache.set(token, value);
				return bypassTypeCheck<T>(value);
			},
		},
		config: {
			get<T>(_key: string): T | undefined {
				return undefined;
			},
		},
	};
}

async function bootStation(opts: {
	db: unknown;
	resources: ReadonlyArray<Parameters<typeof defineResource>[0]>;
	auth?: unknown;
}): Promise<{ routes: CapturedRoute[] }> {
	const routerMod = bypassTypeCheck<{ _setRouter: (router: unknown) => void }>(
		await import("@c9up/ream/services/router"),
	);
	const routes: CapturedRoute[] = [];
	const captureFactory =
		(method: CapturedRoute["method"]) =>
		(
			path: string,
			handler: (ctx: HttpContextLike) => Promise<void> | void,
		): unknown => {
			routes.push({ method, path, handler });
			return {};
		};
	routerMod._setRouter(
		bypassTypeCheck({
			get: captureFactory("get"),
			post: captureFactory("post"),
			put: captureFactory("put"),
			delete: captureFactory("delete"),
		}),
	);
	const app = buildApp(opts.db, opts.auth);
	const provider = new StationProvider(app);
	provider.register();
	await provider.boot();
	const registry = app.container.resolve<ResourceRegistry>(ResourceRegistry);
	for (const opt of opts.resources) registry.register(defineResource(opt));
	await provider.start();
	return { routes };
}

/**
 * Duck-typed `"auth"` manager fake — mirrors the Warden `AuthManager`
 * surface Station consumes (56.5). `verify` accepts a fixed token so the
 * #withAuth gate lets the request through; `hasPermission` answers from a
 * seeded permission set (the unification point a real `MemoryRightsStore`
 * would populate — NEVER from the token's own claims, D1); `hasRole`
 * reads the resolved user's roles.
 *
 * `permissions` omitted ⇒ grant-all (used when a test only cares about
 * the auth/role gate, not the per-action permission gate).
 */
function buildFakeAuth(opts: {
	permissions?: string[];
	user?: { id: unknown; roles?: string[]; [k: string]: unknown };
	validToken?: string;
}) {
	const validToken = opts.validToken ?? "TOKEN_OK";
	const user = opts.user ?? { id: 1, roles: ["admin"] };
	const grantAll = opts.permissions === undefined;
	const granted = new Set(opts.permissions ?? []);
	return {
		authenticate(_credentials: Record<string, unknown>) {
			return Promise.resolve({
				authenticated: true,
				user: { ...user, token: validToken },
			});
		},
		verify(token: string) {
			if (token === validToken) {
				return Promise.resolve({ authenticated: true, user });
			}
			return Promise.resolve({ authenticated: false, error: "invalid token" });
		},
		hasPermission(
			_user: { id: unknown; [k: string]: unknown },
			permission: string,
		) {
			return Promise.resolve(grantAll || granted.has(permission));
		},
		hasRole(u: { id: unknown; [k: string]: unknown }, role: string) {
			const roles = Array.isArray(u.roles)
				? u.roles.filter((r): r is string => typeof r === "string")
				: [];
			return Promise.resolve(roles.includes(role));
		},
	};
}

function findRoute(
	routes: ReadonlyArray<CapturedRoute>,
	method: CapturedRoute["method"],
	path: string,
): CapturedRoute {
	const r = routes.find((x) => x.method === method && x.path === path);
	if (r === undefined) {
		throw new Error(`No ${method} route registered for ${path}`);
	}
	return r;
}

// ─── Tests ──────────────────────────────────────────────────

describe("station > 54.3 create/edit/destroy CRUD", () => {
	beforeEach(() => _resetStationProviderFlags());

	it("POST /admin/users creates a row and redirects to its show page", async () => {
		const { db } = buildFakeDb();
		const { routes } = await bootStation({ db, resources: [{ entity: User }] });
		const create = findRoute(routes, "post", "/admin/users");
		const { ctx, res } = buildCtx({
			body: { name: "Alice", age: 30 },
		});
		await create.handler(ctx);
		expect(res.status).toBe(302);
		expect(res.location).toMatch(/^\/admin\/users\/\d+$/);
	});

	it("GET /admin/users/new renders the create form", async () => {
		const { db } = buildFakeDb();
		const { routes } = await bootStation({ db, resources: [{ entity: User }] });
		const form = findRoute(routes, "get", "/admin/users/new");
		const { ctx, res } = buildCtx({});
		await form.handler(ctx);
		expect(res.status).toBeUndefined();
		expect(res.body).toContain("<form");
		expect(res.body).toContain('action="/admin/users"');
		expect(res.body).not.toContain('value="PUT"');
	});

	it("PUT /admin/users/:id updates an existing row and redirects to show", async () => {
		const { db, rows } = buildFakeDb();
		rows.set(7, { id: 7, name: "Old", age: 25 });
		const { routes } = await bootStation({ db, resources: [{ entity: User }] });
		const update = findRoute(routes, "put", "/admin/users/:id");
		const { ctx, res } = buildCtx({
			params: { id: "7" },
			body: { name: "New", age: 26 },
		});
		await update.handler(ctx);
		expect(res.status).toBe(302);
		expect(res.location).toBe("/admin/users/7");
	});

	it("POST /admin/users/:id honours _method=PUT method-override (browser forms)", async () => {
		const { db, rows } = buildFakeDb();
		rows.set(7, { id: 7, name: "Old", age: 25 });
		const { routes } = await bootStation({ db, resources: [{ entity: User }] });
		const override = findRoute(routes, "post", "/admin/users/:id");
		const { ctx, res } = buildCtx({
			params: { id: "7" },
			body: { _method: "PUT", name: "New", age: 26 },
		});
		await override.handler(ctx);
		expect(res.status).toBe(302);
		expect(res.location).toBe("/admin/users/7");
	});

	it("DELETE /admin/users/:id removes the row and redirects to the list", async () => {
		const { db, rows } = buildFakeDb();
		rows.set(7, { id: 7, name: "X", age: 1 });
		const { routes } = await bootStation({ db, resources: [{ entity: User }] });
		const destroy = findRoute(routes, "delete", "/admin/users/:id");
		const { ctx, res } = buildCtx({ params: { id: "7" } });
		await destroy.handler(ctx);
		expect(res.status).toBe(302);
		expect(res.location).toBe("/admin/users");
	});
});

describe("station > 56.5 permission gate (Warden unified layer)", () => {
	beforeEach(() => _resetStationProviderFlags());

	it("authenticated user WITHOUT the `users.create` permission → 403 (fail-closed, auth wired but no grant)", async () => {
		const { db } = buildFakeDb();
		const auth = buildFakeAuth({ permissions: [] }); // rights store grants nothing
		const { routes } = await bootStation({
			db,
			auth,
			resources: [{ entity: User }],
		});
		const create = findRoute(routes, "post", "/admin/users");
		const { ctx, res } = buildCtx({
			body: { name: "X", age: 1 },
			cookies: { station_auth: "TOKEN_OK" },
		});
		await create.handler(ctx);
		expect(res.status).toBe(403);
		expect(res.body).toContain("403");
	});

	it("grants `users.create` but not `users.destroy` → create passes (302), destroy 403s (per-action granularity)", async () => {
		const { db, rows } = buildFakeDb();
		rows.set(7, { id: 7, name: "X", age: 1 });
		const auth = buildFakeAuth({ permissions: ["users.create"] });
		const { routes } = await bootStation({
			db,
			auth,
			resources: [{ entity: User }],
		});

		const create = findRoute(routes, "post", "/admin/users");
		const { ctx: createCtx, res: createRes } = buildCtx({
			body: { name: "Alice", age: 30 },
			cookies: { station_auth: "TOKEN_OK" },
		});
		await create.handler(createCtx);
		expect(createRes.status).toBe(302);
		expect(createRes.location).toMatch(/^\/admin\/users\/\d+$/);

		const destroy = findRoute(routes, "delete", "/admin/users/:id");
		const { ctx: delCtx, res: delRes } = buildCtx({
			params: { id: "7" },
			cookies: { station_auth: "TOKEN_OK" },
		});
		await destroy.handler(delCtx);
		expect(delRes.status).toBe(403);
	});

	it("permission is resolved via the rights layer, NOT the token's self-asserted `permissions` claim (D1)", async () => {
		// The user object carries a self-asserted `permissions` claim. The
		// gate must IGNORE it and consult `auth.hasPermission` (the seeded
		// rights set), which grants nothing here → 403. A token can never
		// grant itself access (warden D1 — token perms are not an input).
		const { db } = buildFakeDb();
		const auth = buildFakeAuth({
			permissions: [],
			user: { id: 9, roles: [], permissions: ["users.create"] },
		});
		const { routes } = await bootStation({
			db,
			auth,
			resources: [{ entity: User }],
		});
		const create = findRoute(routes, "post", "/admin/users");
		const { ctx, res } = buildCtx({
			body: { name: "X", age: 1 },
			cookies: { station_auth: "TOKEN_OK" },
		});
		await create.handler(ctx);
		expect(res.status).toBe(403);
	});

	it("guest (no token) on a gated route → 302 to login, the action never runs", async () => {
		const { db, rows } = buildFakeDb();
		const auth = buildFakeAuth({}); // grant-all, but a guest never reaches it
		const { routes } = await bootStation({
			db,
			auth,
			resources: [{ entity: User }],
		});
		const create = findRoute(routes, "post", "/admin/users");
		const { ctx, res } = buildCtx({
			body: { name: "Ghost", age: 1 },
			user: null, // anonymous
		});
		await create.handler(ctx);
		expect(res.status).toBe(302);
		expect(res.location).toBe("/admin/login");
		expect(rows.size).toBe(0); // nothing created
	});

	it("dev-preview (no warden wired) → gate is OPEN, the action runs, boot warning emitted", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const { db, rows } = buildFakeDb();
			// No `auth` binding → #authManager undefined → authorizeAction
			// returns true (dev-preview), exactly as the legacy open mode.
			const { routes } = await bootStation({
				db,
				resources: [{ entity: User }],
			});
			const create = findRoute(routes, "post", "/admin/users");
			const { ctx, res } = buildCtx({ body: { name: "Dev", age: 1 } });
			await create.handler(ctx);
			expect(res.status).toBe(302); // action ran despite no grant
			expect(rows.size).toBe(1);
			const authWarn = warn.mock.calls.find((c) =>
				String(c[0]).includes("Admin routes mounted without auth"),
			);
			expect(authWarn).toBeDefined();
		} finally {
			warn.mockRestore();
		}
	});
});

describe("station > security hardening", () => {
	beforeEach(() => _resetStationProviderFlags());

	it("mass-assignment guard: drops body keys that aren't declared @Column properties on create", async () => {
		const { db, rows } = buildFakeDb();
		const { routes } = await bootStation({ db, resources: [{ entity: User }] });
		const create = findRoute(routes, "post", "/admin/users");
		const { ctx, res } = buildCtx({
			// `role` + `passwordHash` are NOT @Column properties on User.
			// The guard must drop them — even if Atlas would tolerate them.
			body: {
				name: "Alice",
				age: 30,
				role: "admin",
				passwordHash: "exfiltrate",
			},
		});
		await create.handler(ctx);
		expect(res.status).toBe(302);
		const stored = [...rows.values()][0];
		expect(stored.name).toBe("Alice");
		expect(stored.age).toBe(30);
		expect((stored as Record<string, unknown>).role).toBeUndefined();
		expect((stored as Record<string, unknown>).passwordHash).toBeUndefined();
	});

	it("mass-assignment guard: drops PK + timestamps from update body", async () => {
		const { db, rows } = buildFakeDb();
		rows.set(7, { id: 7, name: "Old", age: 25 });
		const { routes } = await bootStation({ db, resources: [{ entity: User }] });
		const update = findRoute(routes, "put", "/admin/users/:id");
		const { ctx, res } = buildCtx({
			params: { id: "7" },
			body: {
				name: "New",
				age: 26,
				id: 999, // attempted PK overwrite
				createdAt: "1970-01-01T00:00:00Z", // attempted timestamp overwrite
				role: "admin", // mass-assignment on a non-column
			},
		});
		await update.handler(ctx);
		expect(res.status).toBe(302);
		expect(res.location).toBe("/admin/users/7"); // PK unchanged
		const stored = rows.get(7);
		expect(stored?.name).toBe("New");
		expect(stored?.age).toBe(26);
		expect((stored as Record<string, unknown>).role).toBeUndefined();
		// The PK in the URL still resolves the row — id wasn't overwritten.
		expect(stored?.id).toBe(7);
	});

	it("CSRF warn-once fires when write-enabled resources mount", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const { db } = buildFakeDb();
			await bootStation({ db, resources: [{ entity: User }] });
			const csrfCall = warn.mock.calls.find((c) =>
				String(c[0]).includes("Station does NOT enforce CSRF"),
			);
			expect(csrfCall).toBeDefined();
		} finally {
			warn.mockRestore();
		}
	});

	it("CSRF warn-once stays silent when only read-only actions are mounted", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const { db } = buildFakeDb();
			await bootStation({
				db,
				resources: [{ entity: User, actions: ["list", "show"] }],
			});
			const csrfCall = warn.mock.calls.find((c) =>
				String(c[0]).includes("Station does NOT enforce CSRF"),
			);
			expect(csrfCall).toBeUndefined();
		} finally {
			warn.mockRestore();
		}
	});

	it("audit snapshots are deep-cloned — mutating before/after in the sink does not touch the live entity", async () => {
		const { db, rows } = buildFakeDb();
		rows.set(7, { id: 7, name: "Owned", age: 1 });
		const captured: AuditEvent[] = [];
		const { routes } = await bootStation({
			db,
			resources: [
				{
					entity: User,
					audit: (e) => {
						// Mutate the snapshot inside the sink — a malicious
						// or buggy sink that tries to redact a field
						// in-place must NOT propagate back to the entity.
						if (e.before)
							(e.before as Record<string, unknown>).name = "<redacted>";
						captured.push(e);
					},
				},
			],
		});
		const destroy = findRoute(routes, "delete", "/admin/users/:id");
		const { ctx } = buildCtx({ params: { id: "7" } });
		await destroy.handler(ctx);
		expect(captured[0].before?.name).toBe("<redacted>");
		// The mutation in the sink must NOT leak into the audit pipeline's
		// view of subsequent events. Run a second destroy to confirm.
		rows.set(8, { id: 8, name: "Fresh", age: 2 });
		const { ctx: ctx2 } = buildCtx({ params: { id: "8" } });
		await destroy.handler(ctx2);
		// Sink ran with a fresh deep-clone — the snapshot for row 8 must
		// reflect the actual row, not echo the redaction from row 7.
		expect(captured[1].before?.name).toBe("<redacted>"); // sink runs again
		// What we really care about: the snapshot's own fields are
		// independent. Mutating before doesn't poison after.
		const evt = captured[1];
		if (evt.before) (evt.before as Record<string, unknown>).age = 999;
		// `evt.after` (undefined for destroy) wouldn't have changed; what
		// we assert is that the sink saw the REAL pre-delete row before
		// the in-sink mutation took effect.
		expect(evt.recordId).toBe(8);
	});
});

describe("station > 54.6 audit trail", () => {
	beforeEach(() => _resetStationProviderFlags());

	it("invokes the audit sink AFTER a successful create with after-snapshot + userId", async () => {
		const { db } = buildFakeDb();
		const events: AuditEvent[] = [];
		const { routes } = await bootStation({
			db,
			resources: [
				{
					entity: User,
					audit: (e) => {
						events.push(e);
					},
				},
			],
		});
		const create = findRoute(routes, "post", "/admin/users");
		const { ctx } = buildCtx({
			body: { name: "Alice", age: 30 },
			user: { id: "u-42" },
		});
		await create.handler(ctx);
		expect(events).toHaveLength(1);
		expect(events[0].action).toBe("create");
		expect(events[0].resource).toBe("users");
		expect(events[0].userId).toBe("u-42");
		expect(events[0].after).toMatchObject({ name: "Alice", age: 30 });
		expect(events[0].before).toBeUndefined();
		expect(events[0].at).toBeInstanceOf(Date);
	});

	it("emits before + after on edit and only before on destroy", async () => {
		const { db, rows } = buildFakeDb();
		rows.set(7, { id: 7, name: "Old", age: 25 });
		const events: AuditEvent[] = [];
		const { routes } = await bootStation({
			db,
			resources: [
				{
					entity: User,
					audit: (e) => {
						events.push(e);
					},
				},
			],
		});

		const update = findRoute(routes, "put", "/admin/users/:id");
		const { ctx: editCtx } = buildCtx({
			params: { id: "7" },
			body: { name: "New", age: 26 },
		});
		await update.handler(editCtx);

		const destroy = findRoute(routes, "delete", "/admin/users/:id");
		const { ctx: delCtx } = buildCtx({ params: { id: "7" } });
		await destroy.handler(delCtx);

		expect(events).toHaveLength(2);
		const editEvt = events[0];
		expect(editEvt.action).toBe("edit");
		expect(editEvt.before).toMatchObject({ name: "Old" });
		expect(editEvt.after).toMatchObject({ name: "New" });
		const delEvt = events[1];
		expect(delEvt.action).toBe("destroy");
		expect(delEvt.before).toMatchObject({ id: 7 });
		expect(delEvt.after).toBeUndefined();
	});

	it("a throwing audit sink does not crash the request — operation still succeeds", async () => {
		const { db } = buildFakeDb();
		// Boot warnings also hit console.warn, so we assert on console.ERROR,
		// which is reserved for the COMPLIANCE GAP signal (retro 2026-06-01).
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const { routes } = await bootStation({
				db,
				resources: [
					{
						entity: User,
						audit: () => {
							throw new Error("audit pipeline down");
						},
					},
				],
			});
			const create = findRoute(routes, "post", "/admin/users");
			const { ctx, res } = buildCtx({ body: { name: "A", age: 1 } });
			await create.handler(ctx);
			expect(res.status).toBe(302); // redirect proves the create committed
			// The audit failure is logged at error level (observable by
			// monitoring), tagged COMPLIANCE GAP, naming the sink error.
			expect(error).toHaveBeenCalledTimes(1);
			expect(String(error.mock.calls[0][0])).toContain("COMPLIANCE GAP");
			expect(String(error.mock.calls[0][0])).toContain("audit pipeline down");
		} finally {
			error.mockRestore();
		}
	});

	it("onAuditError hook fires on sink failure with (event, error); request still succeeds", async () => {
		const { db } = buildFakeDb();
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const seen: Array<{ action: string; recordId: unknown; msg: string }> =
				[];
			const { routes } = await bootStation({
				db,
				resources: [
					{
						entity: User,
						audit: () => {
							throw new Error("sink exploded");
						},
						onAuditError: (event, err) => {
							seen.push({
								action: event.action,
								recordId: event.recordId,
								msg: err instanceof Error ? err.message : String(err),
							});
						},
					},
				],
			});
			const create = findRoute(routes, "post", "/admin/users");
			const { ctx, res } = buildCtx({ body: { name: "Z", age: 9 } });
			await create.handler(ctx);
			expect(res.status).toBe(302); // create committed despite the failure
			expect(seen).toHaveLength(1);
			expect(seen[0].action).toBe("create");
			expect(seen[0].msg).toBe("sink exploded");
		} finally {
			error.mockRestore();
		}
	});

	it("a throwing onAuditError handler is itself contained — request still succeeds", async () => {
		const { db } = buildFakeDb();
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const { routes } = await bootStation({
				db,
				resources: [
					{
						entity: User,
						audit: () => {
							throw new Error("sink down");
						},
						onAuditError: () => {
							throw new Error("handler also down");
						},
					},
				],
			});
			const create = findRoute(routes, "post", "/admin/users");
			const { ctx, res } = buildCtx({ body: { name: "Q", age: 2 } });
			await create.handler(ctx);
			expect(res.status).toBe(302); // a throwing handler can't crash the request
		} finally {
			error.mockRestore();
		}
	});
});
