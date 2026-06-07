/**
 * End-to-end roundtrip — exercise `StationProvider.start()` against a
 * Ream router fake, capture the registered handlers, drive them with
 * hand-built `HttpContext` shapes, and assert the rendered HTML +
 * status codes match AC4 / AC5 / AC14.
 *
 * Why hand-built handlers vs supertest-style HTTP: the in-process Ream
 * router can't be booted in isolation from Station's test environment
 * without dragging the full Ignitor / HyperServer stack. Driving the
 * captured handlers with a hand-built ctx tests the same surface
 * (handler logic + view rendering + repo plumbing) with zero NAPI / TCP
 * dependencies. Documented in Dev Agent Record.
 */
import "reflect-metadata";
import { beforeEach, describe, expect, it } from "vitest";
import { defineResource } from "../../src/defineResource.js";
import { ResourceRegistry } from "../../src/ResourceRegistry.js";
import StationProvider, {
	resetStationProviderFlags,
	type StationAppContext,
} from "../../src/StationProvider.js";
import { bypassTypeCheck } from "../__helpers__/bypass-type-check.js";
import { User } from "../fixtures/User.js";

interface CapturedRoute {
	method: "get" | "post" | "put" | "delete";
	path: string;
	handler: (ctx: HttpContextLike) => Promise<void> | void;
}

interface HttpContextLike {
	request: { qs(): Record<string, string | undefined> };
	response: ResponseRecorder;
	params: Record<string, string>;
	auth?: { user?: { id: unknown; [k: string]: unknown } };
}

class ResponseRecorder {
	status?: number;
	contentType?: string;
	body?: string;
	location?: string;
	private statusFn = (code: number): unknown => {
		this.status = code;
		return this;
	};
	private typeFn = (value: string): unknown => {
		this.contentType = value;
		return this;
	};
	private sendFn = (body: string): unknown => {
		this.body = body;
		return this;
	};
	private headerFn = (name: string, value: string): unknown => {
		if (name.toLowerCase() === "location") this.location = value;
		return this;
	};
	private redirectFn = (url: string): unknown => {
		this.status = 302;
		this.location = url;
		return this;
	};
	private jsonFn = (data: unknown): unknown => {
		this.body = JSON.stringify(data);
		this.contentType = "application/json";
		return this;
	};
	get status$() {
		return this.statusFn;
	}
	get type$() {
		return this.typeFn;
	}
	get send$() {
		return this.sendFn;
	}
	get header$() {
		return this.headerFn;
	}
	get redirect$() {
		return this.redirectFn;
	}
	get json$() {
		return this.jsonFn;
	}
}

function buildCtx(opts: {
	query?: Record<string, string>;
	params?: Record<string, string>;
}): { ctx: HttpContextLike; res: ResponseRecorder } {
	const res = new ResponseRecorder();
	const query = opts.query ?? {};
	const ctx: HttpContextLike = {
		request: { qs: () => query },
		response: bypassTypeCheck<HttpContextLike["response"]>({
			status: res.status$,
			type: res.type$,
			send: res.send$,
			json: res.json$,
			redirect: res.redirect$,
			header: res.header$,
		}),
		params: opts.params ?? {},
		// These roundtrip tests boot WITHOUT a warden `"auth"` binding, so
		// the 56.5 permission gate runs in dev-preview OPEN mode and this
		// preset user is incidental (the gate never consults it).
		auth: { user: { id: 1, roles: ["admin"] } },
	};
	return { ctx, res };
}

/**
 * In-memory recording mock — emulates the prepare/run/get/all surface
 * Atlas's `wrapPrepareMock` adapts. Pre-seeds N user rows; supports
 * SELECT * FROM users [WHERE id=?] [ORDER BY id DESC LIMIT N OFFSET M]
 * and SELECT COUNT(*).
 */
function buildSeededDb(userCount: number) {
	const users: Array<{ id: number; name: string; age: number }> = [];
	for (let i = 1; i <= userCount; i++) {
		users.push({ id: i, name: `user-${i}`, age: 20 + (i % 50) });
	}
	function runQuery(sql: string, params: unknown[]): Record<string, unknown>[] {
		// COUNT scalar — atlas's `#runScalar` aliases the aggregate as
		// `__scalar__`. Returning the alias is mandatory; using `count` or
		// `COUNT(*)` keys silently falls back to 0.
		if (sql.includes("COUNT(*)")) {
			return [{ __scalar__: users.length }];
		}
		// `find(pk)` — `SELECT ... WHERE "id" = ? LIMIT 1`. Match on the
		// WHERE clause specifically because the COUNT branch above also
		// contained `LIMIT` in some compiler outputs.
		if (sql.includes('WHERE "id" = ?') || sql.includes("WHERE id = ?")) {
			const id = Number(params[0]);
			const row = users.find((u) => u.id === id);
			return row ? [row] : [];
		}
		// List query — ORDER BY "id" DESC LIMIT N OFFSET M
		const limitMatch = sql.match(/LIMIT (\d+)/);
		const offsetMatch = sql.match(/OFFSET (\d+)/);
		const limit = limitMatch
			? Number.parseInt(limitMatch[1] ?? "0", 10)
			: users.length;
		const offset = offsetMatch ? Number.parseInt(offsetMatch[1] ?? "0", 10) : 0;
		const sorted = [...users].sort((a, b) => b.id - a.id);
		return sorted.slice(offset, offset + limit);
	}
	return {
		users,
		db: {
			execute(_sql: string, _params: unknown[] = []) {
				return Promise.resolve({ rowsAffected: 0 });
			},
			query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
				return Promise.resolve(bypassTypeCheck<T[]>(runQuery(sql, params)));
			},
		},
	};
}

function buildApp(db: unknown): StationAppContext {
	const bindings = new Map<unknown, () => unknown>();
	const cache = new Map<unknown, unknown>();
	bindings.set("db", () => db);
	const app: StationAppContext = {
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
	return app;
}

/**
 * Boot StationProvider with a captured-router fake. Returns the
 * captured routes for direct handler invocation.
 */
async function bootStation(opts: {
	db: unknown;
	resources: ReadonlyArray<Parameters<typeof defineResource>[0]>;
}): Promise<{ routes: CapturedRoute[] }> {
	const routerMod = bypassTypeCheck<{ _setRouter: (router: unknown) => void }>(
		await import("@c9up/ream/services/router"),
	);
	const { _setRouter } = routerMod;
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
	const fakeRouter = {
		get: captureFactory("get"),
		post: captureFactory("post"),
		put: captureFactory("put"),
		delete: captureFactory("delete"),
	};
	// _setRouter expects a `Router` shape; the fake satisfies the four
	// verbs StationProvider.start() reaches for (get/post/put/delete).
	// Routed through bypass-type-check to honour AC15's no-`as` rule.
	_setRouter(bypassTypeCheck(fakeRouter));

	const app = buildApp(opts.db);
	const provider = new StationProvider(app);
	provider.register();
	await provider.boot();
	const registry = app.container.resolve<ResourceRegistry>(ResourceRegistry);
	for (const opt of opts.resources) registry.register(defineResource(opt));
	await provider.start();

	return { routes };
}

describe("station > integration > list/show roundtrip (50 seeded users)", () => {
	beforeEach(() => {
		resetStationProviderFlags();
	});

	it("GET /admin/users renders 25 rows by default", async () => {
		const { db } = buildSeededDb(50);
		const { routes } = await bootStation({
			db,
			resources: [{ entity: User }],
		});
		const listRoute = routes.find(
			(r) => r.method === "get" && r.path === "/admin/users",
		);
		expect(listRoute).toBeDefined();
		if (!listRoute) throw new Error("unreachable");

		const { ctx, res } = buildCtx({ query: {} });
		await listRoute.handler(ctx);

		expect(res.contentType).toBe("text/html; charset=utf-8");
		expect(res.body).toContain("<table>");
		// 25 rows of data → 25 `<tr>` inside <tbody>. The header row is in
		// <thead>, so a substring count on `<tr>` after the first <tbody>
		// gives us the data row count exactly.
		const bodyMatch = res.body?.match(/<tbody>(.*?)<\/tbody>/s);
		const bodyRows = bodyMatch?.[1]?.match(/<tr>/g) ?? [];
		expect(bodyRows).toHaveLength(25);
		// First listed row (DESC order on id) is the highest seeded id = 50.
		expect(res.body).toContain(`>user-50<`);
		// Caption: 50 total, 25/page → "Showing 1–25 of 50".
		expect(res.body).toContain("Showing 1–25 of 50");
	});

	it("GET /admin/users?page=2 renders the next 25 rows", async () => {
		const { db } = buildSeededDb(50);
		const { routes } = await bootStation({
			db,
			resources: [{ entity: User }],
		});
		const listRoute = routes.find(
			(r) => r.method === "get" && r.path === "/admin/users",
		);
		if (!listRoute) throw new Error("unreachable");
		const { ctx, res } = buildCtx({ query: { page: "2" } });
		await listRoute.handler(ctx);
		expect(res.body).toContain("Showing 26–50 of 50");
		// page 2 of DESC-sorted → id 25 is the highest on this page.
		expect(res.body).toContain(`>user-25<`);
		// No <a> link for next/prev since we're on the last page; ensure the
		// disabled-Next marker is present.
		expect(res.body).toContain('<span class="st-disabled">Next »</span>');
	});

	it("GET /admin/users?page=99 redirects (302) to the last real page", async () => {
		const { db } = buildSeededDb(50);
		const { routes } = await bootStation({
			db,
			resources: [{ entity: User }],
		});
		const listRoute = routes.find(
			(r) => r.method === "get" && r.path === "/admin/users",
		);
		if (!listRoute) throw new Error("unreachable");
		const { ctx, res } = buildCtx({ query: { page: "99" } });
		await listRoute.handler(ctx);
		expect(res.status).toBe(302);
		expect(res.location).toBe("/admin/users?page=2&perPage=25");
	});

	it("GET /admin/users?perPage=500 clamps perPage to 100 + console.warn once", async () => {
		const { db } = buildSeededDb(50);
		const { routes } = await bootStation({
			db,
			resources: [{ entity: User }],
		});
		const listRoute = routes.find(
			(r) => r.method === "get" && r.path === "/admin/users",
		);
		if (!listRoute) throw new Error("unreachable");

		const warnSpy: unknown[][] = [];
		const original = console.warn;
		console.warn = (...args: unknown[]) => {
			warnSpy.push(args);
		};
		try {
			const { ctx, res } = buildCtx({ query: { perPage: "500" } });
			await listRoute.handler(ctx);
			expect(res.body).toContain("Showing 1–50 of 50");
			const clampWarn = warnSpy.filter((c) =>
				String(c[0]).includes("perPage clamped to 100"),
			);
			expect(clampWarn).toHaveLength(1);
		} finally {
			console.warn = original;
		}
	});

	it("GET /admin/users/:id renders the show view for an existing row", async () => {
		const { db } = buildSeededDb(50);
		const { routes } = await bootStation({
			db,
			resources: [{ entity: User }],
		});
		const showRoute = routes.find(
			(r) => r.method === "get" && r.path === "/admin/users/:id",
		);
		if (!showRoute) throw new Error("unreachable");
		const { ctx, res } = buildCtx({ params: { id: "1" } });
		await showRoute.handler(ctx);
		expect(res.body).toContain("<dt>name</dt>");
		expect(res.body).toContain("<dd>user-1</dd>");
	});

	it("GET /admin/users/99999 returns 404 with Station-branded HTML", async () => {
		const { db } = buildSeededDb(50);
		const { routes } = await bootStation({
			db,
			resources: [{ entity: User }],
		});
		const showRoute = routes.find(
			(r) => r.method === "get" && r.path === "/admin/users/:id",
		);
		if (!showRoute) throw new Error("unreachable");
		const { ctx, res } = buildCtx({ params: { id: "99999" } });
		await showRoute.handler(ctx);
		expect(res.status).toBe(404);
		expect(res.body).toContain("404 Not Found");
		expect(res.body).toContain("No users with ID <code>99999</code>");
	});

	it("resources with `actions: ['list']` do NOT mount the show route", async () => {
		const { db } = buildSeededDb(50);
		const { routes } = await bootStation({
			db,
			resources: [{ entity: User, actions: ["list"] }],
		});
		expect(
			routes.find((r) => r.method === "get" && r.path === "/admin/users"),
		).toBeDefined();
		expect(
			routes.find((r) => r.method === "get" && r.path === "/admin/users/:id"),
		).toBeUndefined();
	});

	it("GET /admin/widgets falls through (Station does NOT mount routes for unregistered resources)", async () => {
		// D6 + AC14 — Station owns ONLY the routes it registered. A request
		// for a slug that was never `defineResource()`d must not produce a
		// Station route entry; Ream's default 404 handles the fall-through.
		const { db } = buildSeededDb(50);
		const { routes } = await bootStation({
			db,
			resources: [{ entity: User }],
		});
		expect(
			routes.find((r) => r.method === "get" && r.path === "/admin/widgets"),
		).toBeUndefined();
		expect(routes.find((r) => r.path === "/admin/widgets/:id")).toBeUndefined();
		// Sanity — the registered slug DID mount, so absence of widgets is
		// not just "nothing mounted at all".
		expect(
			routes.find((r) => r.method === "get" && r.path === "/admin/users"),
		).toBeDefined();
	});
});
