/**
 * Story 57.1 — the 404 leaf view rendered through the inker seam.
 *
 * Drives the real show handler (captured off `StationProvider.start()`)
 * with a MISSING id so the not-found branch fires, then asserts the page
 * that comes back is composed by `@c9up/inker`:
 *   - the `layout.inker` shell wraps it (doctype, `<title>… · Station</title>`,
 *     the Station CSS), proving `{% layout 'layout' %}` + `{{> body }}`
 *     composition through the package `templates/` root;
 *   - a HOSTILE id is HTML-escaped by inker's `{{ }}` (never live markup),
 *     proving the auto-escaping replaces the retired hand-rolled `escapeHtml`
 *     for this view.
 *
 * This exercises the full seam (`#renderNotFound` → `Templates.render`),
 * not a view function in isolation.
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
import { makeInkerRenderer } from "../__helpers__/inker-renderer.js";
import { User } from "../fixtures/User.js";

interface CapturedRoute {
	method: "get" | "post" | "put" | "delete";
	path: string;
	handler: (ctx: HttpContextLike) => Promise<void> | void;
}

interface HttpContextLike {
	request: { qs(): Record<string, string | undefined> };
	response: {
		status(code: number): unknown;
		type(value: string): unknown;
		send(body: string): unknown;
		redirect(url: string): unknown;
	};
	params: Record<string, string>;
	auth?: { user?: { id: unknown; [k: string]: unknown } };
}

class ResponseRecorder {
	status?: number;
	contentType?: string;
	body?: string;
	readonly api = {
		status: (code: number): unknown => {
			this.status = code;
			return this.api;
		},
		type: (value: string): unknown => {
			this.contentType = value;
			return this.api;
		},
		send: (body: string): unknown => {
			this.body = body;
			return this.api;
		},
		redirect: (): unknown => this.api,
	};
}

// A db whose `find(pk)` never matches → the show handler's not-found
// branch always fires (SELECT WHERE id = ? returns no rows).
function buildEmptyDb() {
	function runQuery(sql: string): Record<string, unknown>[] {
		if (sql.includes("COUNT(*)")) return [{ __scalar__: 0 }];
		return [];
	}
	return {
		execute() {
			return Promise.resolve({ rowsAffected: 0 });
		},
		query<T>(sql: string): Promise<T[]> {
			return Promise.resolve(bypassTypeCheck<T[]>(runQuery(sql)));
		},
	};
}

async function bootShowRoute(
	makeRenderer: () => {
		mount(d: string, dir: string): void;
	} = makeInkerRenderer,
): Promise<CapturedRoute> {
	const routes: CapturedRoute[] = [];
	const capture =
		(method: CapturedRoute["method"]) =>
		(path: string, handler: CapturedRoute["handler"]): unknown => {
			routes.push({ method, path, handler });
			return {};
		};
	const bindings = new Map<unknown, () => unknown>();
	const cache = new Map<unknown, unknown>();
	bindings.set("db", () => buildEmptyDb());
	bindings.set("router", () => ({
		get: capture("get"),
		post: capture("post"),
		put: capture("put"),
		delete: capture("delete"),
	}));
	bindings.set("inker", () => makeRenderer());
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
			has(token: unknown): boolean {
				return cache.has(token) || bindings.has(token);
			},
		},
		config: {
			get<T>(): T | undefined {
				return undefined;
			},
		},
	};
	const provider = new StationProvider(app);
	provider.register();
	await provider.boot();
	app.container
		.resolve<ResourceRegistry>(ResourceRegistry)
		.register(defineResource({ entity: User }));
	await provider.start();
	const show = routes.find(
		(r) => r.method === "get" && r.path === "/admin/users/:id",
	);
	if (!show) throw new Error("unreachable: show route not mounted");
	return show;
}

async function render404(
	id: string,
	makeRenderer?: () => { mount(d: string, dir: string): void },
): Promise<ResponseRecorder> {
	const show = await bootShowRoute(makeRenderer ?? makeInkerRenderer);
	const res = new ResponseRecorder();
	const ctx: HttpContextLike = {
		request: { qs: () => ({}) },
		response: bypassTypeCheck<HttpContextLike["response"]>(res.api),
		params: { id },
		auth: { user: { id: 1, roles: ["admin"] } },
	};
	await show.handler(ctx);
	return res;
}

describe("station > integration > 57.1 inker-rendered 404", () => {
	beforeEach(() => {
		resetStationProviderFlags();
	});

	it("composes the layout shell around the 404 body (doctype, title, CSS)", async () => {
		const res = await render404("99999");
		expect(res.status).toBe(404);
		expect(res.contentType).toBe("text/html; charset=utf-8");
		expect(res.body).toContain("<!doctype html>");
		expect(res.body).toContain("<title>Not Found · Station</title>");
		// The Station CSS from layout.inker is present (proves `<style>` inline).
		expect(res.body).toContain("--st-fg");
		// The body content rendered inside the layout's `{{> body }}` slot.
		expect(res.body).toContain("<h1>404 Not Found</h1>");
		expect(res.body).toContain("No users with ID <code>99999</code>");
		expect(res.body).toContain('href="/admin/users"');
	});

	it("HTML-escapes a hostile id — inker `{{ }}` never emits live markup", async () => {
		const res = await render404("<script>alert(1)</script>");
		expect(res.status).toBe(404);
		expect(res.body).toContain(
			"<code>&lt;script&gt;alert(1)&lt;/script&gt;</code>",
		);
		// The raw payload must NOT appear as executable markup.
		expect(res.body).not.toContain("<code><script>alert(1)</script></code>");
		expect(res.body).not.toContain("<script>alert(1)</script>");
	});

	it("falls back to a static 404 (never a 500) when the inker render itself throws", async () => {
		// A render fault (missing template on a partial publish, fs error, parse
		// failure) must not escalate a not-found into a server error. The renderer
		// mounts fine but rejects at render time.
		const makeFailing = () => ({
			mount(): void {},
			renderToString(): Promise<string> {
				return Promise.reject(new Error("boom: inker engine unavailable"));
			},
		});
		// The handler must resolve — no exception may escape the not-found branch.
		const res = await render404("<script>alert(1)</script>", makeFailing);
		expect(res.status).toBe(404);
		expect(res.contentType).toBe("text/html; charset=utf-8");
		expect(res.body).toContain("404 — Not Found");
		// The request-controlled id is still HTML-escaped in the fallback body.
		expect(res.body).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
		expect(res.body).not.toContain("<script>alert(1)</script>");
	});
});
