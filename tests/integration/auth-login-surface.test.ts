/**
 * Story 54.7 — Warden integration + login surface.
 *
 * Drives StationProvider.start() with a fake `auth` manager bound in
 * the container so the provider mounts `/admin/login`,
 * `/admin/logout`, and wraps every CRUD route behind `#withAuth`. The
 * captured handlers are invoked directly (same pattern as
 * `list-show-roundtrip.test.ts`) — no Ignitor / HyperServer boot.
 *
 * Coverage:
 *   - GET /admin/login renders the form (200, escapes ?error=)
 *   - POST /admin/login with bad creds → 401, form re-rendered, NO cookie
 *   - POST /admin/login with good creds → 302 /admin, session cookie set
 *   - POST /admin/logout → clears cookie, redirects to login
 *   - Gated CRUD route w/o token → 302 /admin/login
 *   - Gated CRUD route w/ valid token → handler runs, ctx.auth.user populated
 *   - Gated CRUD route w/ JSON Accept → 401 JSON instead of redirect
 *   - requireRole gate → authenticated user without role gets 403
 *   - Stale cookie → clearCookie + redirect (no auth loop)
 */
import "reflect-metadata";
import { beforeEach, describe, expect, it } from "vitest";
import { defineResource } from "../../src/defineResource.js";
import { ResourceRegistry } from "../../src/ResourceRegistry.js";
import StationProvider, {
	resetStationProviderFlags,
	type StationAppContext,
	type StationConfig,
} from "../../src/StationProvider.js";
import { bypassTypeCheck } from "../__helpers__/bypass-type-check.js";
import { makeInkerRenderer } from "../__helpers__/inker-renderer.js";
import { User } from "../fixtures/User.js";

interface CapturedRoute {
	method: "get" | "post" | "put" | "delete";
	path: string;
	handler: (ctx: HttpContextLike) => Promise<void> | void;
}

interface CookieSet {
	value: string;
	options?: Record<string, unknown>;
}

class ResponseRecorder {
	status?: number;
	contentType?: string;
	body?: string;
	location?: string;
	cookies: Map<string, CookieSet> = new Map();
	clearedCookies: string[] = [];
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
	private cookieFn = (
		name: string,
		value: string,
		options?: Record<string, unknown>,
	): unknown => {
		this.cookies.set(name, { value, options });
		return this;
	};
	private clearCookieFn = (
		name: string,
		_options?: Record<string, unknown>,
	): unknown => {
		this.clearedCookies.push(name);
		this.cookies.delete(name);
		return this;
	};
	get fns() {
		return {
			status: this.statusFn,
			type: this.typeFn,
			send: this.sendFn,
			header: this.headerFn,
			redirect: this.redirectFn,
			json: this.jsonFn,
			cookie: this.cookieFn,
			clearCookie: this.clearCookieFn,
		};
	}
}

interface HttpContextLike {
	request: {
		qs(): Record<string, string | undefined>;
		body?(): Promise<unknown> | unknown;
		header?(name: string): string | undefined;
		cookie?(name: string): string | undefined;
		/** Blackhole's CSRF-verified signal — login/logout fail-close on it (57.6). */
		csrfProtected?: boolean;
	};
	response: ReturnType<ResponseRecorder["fns"]["status"]> extends unknown
		? Record<string, unknown>
		: never;
	params: Record<string, string>;
	auth?: { user?: { id: unknown; [key: string]: unknown }; roles?: string[] };
}

function buildCtx(opts: {
	query?: Record<string, string>;
	params?: Record<string, string>;
	body?: Record<string, unknown>;
	headers?: Record<string, string>;
	cookies?: Record<string, string>;
	/**
	 * Blackhole's CSRF-verified signal. Defaults to `true` so the login/logout
	 * POST handlers (which now fail-close on it, 57.6) proceed — these tests
	 * predate CSRF enforcement and exercise the auth surface, not CSRF.
	 */
	csrfProtected?: boolean;
}): { ctx: HttpContextLike; res: ResponseRecorder } {
	const res = new ResponseRecorder();
	const query = opts.query ?? {};
	const headers = opts.headers ?? {};
	const cookies = opts.cookies ?? {};
	const body = opts.body;
	const ctx: HttpContextLike = {
		request: {
			qs: () => query,
			body: body !== undefined ? () => body : undefined,
			header: (name) => headers[name.toLowerCase()],
			cookie: (name) => cookies[name],
			csrfProtected: opts.csrfProtected ?? true,
		},
		response: bypassTypeCheck<HttpContextLike["response"]>(res.fns),
		params: opts.params ?? {},
	};
	return { ctx, res };
}

interface FakeAuthOptions {
	validToken?: string;
	validCreds?: { email: string; password: string };
	user?: {
		id: unknown;
		email?: string;
		roles?: string[];
		[key: string]: unknown;
	};
	verifyError?: string;
	authenticateError?: string;
	/**
	 * Permissions the rights layer grants this user (56.5). Omitted ⇒
	 * grant-all, so the login-surface tests focus on the token/role gate
	 * without the per-action permission gate interfering. A test probing
	 * the permission gate passes an explicit (possibly empty) set.
	 */
	permissions?: string[];
}

function buildFakeAuth(opts: FakeAuthOptions) {
	const validToken = opts.validToken ?? "TOKEN_OK";
	const issuedToken = "ISSUED_TOKEN_42";
	const validCreds = opts.validCreds ?? {
		email: "admin@example.com",
		password: "hunter2",
	};
	// Default authenticated actor is an admin. Role-specific tests pass
	// `user` explicitly; the per-action permission gate (56.5) is
	// grant-all unless `permissions` is set, so these tests isolate the
	// token/role gate.
	const user = opts.user ?? {
		id: 1,
		email: validCreds.email,
		roles: ["admin"],
	};
	const grantAll = opts.permissions === undefined;
	const granted = new Set(opts.permissions ?? []);
	return {
		issuedToken,
		manager: {
			authenticate(credentials: Record<string, unknown>) {
				if (
					credentials.email === validCreds.email &&
					credentials.password === validCreds.password
				) {
					// Mirror Warden's real AuthResult shape: the issued token
					// lives on `user.token`, NOT at the top level. (The old
					// fixture put it top-level, which hid the contract drift.)
					return Promise.resolve({
						authenticated: true,
						user: { ...user, token: issuedToken },
					});
				}
				return Promise.resolve({
					authenticated: false,
					error: opts.authenticateError ?? "Invalid credentials",
				});
			},
			verify(token: string) {
				if (token === validToken || token === issuedToken) {
					return Promise.resolve({ authenticated: true, user });
				}
				return Promise.resolve({
					authenticated: false,
					error: opts.verifyError ?? "Invalid token",
				});
			},
			// 56.5 — the coarse authorization helpers Station consumes
			// through the `"auth"` alias. `hasPermission` answers from the
			// seeded rights set (NEVER the token's claims, D1); `hasRole`
			// reads the resolved user's roles.
			hasPermission(
				_user: { id: unknown; [key: string]: unknown },
				permission: string,
			) {
				return Promise.resolve(grantAll || granted.has(permission));
			},
			hasRole(u: { id: unknown; [key: string]: unknown }, role: string) {
				const roles = Array.isArray(u.roles)
					? u.roles.filter((r): r is string => typeof r === "string")
					: [];
				return Promise.resolve(roles.includes(role));
			},
		},
	};
}

function buildApp(
	db: unknown,
	auth: unknown,
	stationConfig?: StationConfig,
): StationAppContext {
	const bindings = new Map<unknown, () => unknown>();
	const cache = new Map<unknown, unknown>();
	bindings.set("db", () => db);
	if (auth !== undefined) bindings.set("auth", () => auth);
	// 57.1 — Station resolves the shared inker renderer via the `"inker"` alias
	// (AdonisJS package-views pattern) at start(); bind a real Templates-backed stub.
	bindings.set("inker", () => makeInkerRenderer());
	return {
		container: {
			singleton(token, factory) {
				bindings.set(token, bypassTypeCheck<() => unknown>(factory));
			},
			async resolve<T>(token: unknown): Promise<T> {
				if (cache.has(token)) return bypassTypeCheck<T>(cache.get(token));
				const factory = bindings.get(token);
				if (!factory) throw new Error(`not registered: ${String(token)}`);
				const value = await factory();
				cache.set(token, value);
				return bypassTypeCheck<T>(value);
			},
			has(token: unknown): boolean {
				return cache.has(token) || bindings.has(token);
			},
		},
		config: {
			get<T>(key: string): T | undefined {
				if (key === "station" && stationConfig !== undefined) {
					return bypassTypeCheck<T>(stationConfig);
				}
				return undefined;
			},
		},
	};
}

function buildMinimalDb() {
	const rows: Array<{ id: number; name: string; age: number }> = [
		{ id: 1, name: "alice", age: 30 },
	];
	return {
		execute(_sql: string, _params: unknown[] = []) {
			return Promise.resolve({ rowsAffected: 0 });
		},
		query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
			if (sql.includes("COUNT(*)")) {
				// COUNT scalar under both atlas aliases: `#runScalar` reads
				// `__scalar__`, `paginate()` reads `count`. The list handler
				// routed here goes through `paginate()`, so `count` is
				// mandatory (else `meta.total` silently resolves to 0).
				return Promise.resolve(
					bypassTypeCheck<T[]>([
						{ __scalar__: rows.length, count: rows.length },
					]),
				);
			}
			if (sql.includes('WHERE "id" = ?') || sql.includes("WHERE id = ?")) {
				const id = Number(params[0]);
				const row = rows.find((r) => r.id === id);
				return Promise.resolve(bypassTypeCheck<T[]>(row ? [row] : []));
			}
			return Promise.resolve(bypassTypeCheck<T[]>(rows));
		},
	};
}

async function bootStation(opts: {
	auth?: unknown;
	stationConfig?: StationConfig;
	resources?: ReadonlyArray<Parameters<typeof defineResource>[0]>;
}): Promise<{ routes: CapturedRoute[] }> {
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

	const app = buildApp(buildMinimalDb(), opts.auth, opts.stationConfig);
	// The provider resolves the host router from the container under `'router'`
	// (as Ignitor registers it) — NOT via a `@c9up/ream` import.
	app.container.singleton("router", () => fakeRouter);
	const provider = new StationProvider(app);
	provider.register();
	await provider.boot();
	const registry =
		await app.container.resolve<ResourceRegistry>(ResourceRegistry);
	const resources = opts.resources ?? [{ entity: User }];
	for (const r of resources) registry.register(defineResource(r));
	await provider.start();
	return { routes };
}

describe("station > integration > 54.7 warden integration + login surface", () => {
	beforeEach(() => {
		resetStationProviderFlags();
	});

	it("does NOT mount /admin/login when no auth manager is bound (legacy open mode)", async () => {
		const { routes } = await bootStation({ auth: undefined });
		const loginGet = routes.find(
			(r) => r.method === "get" && r.path === "/admin/login",
		);
		expect(loginGet).toBeUndefined();
		// And the list route still works without auth.
		const list = routes.find(
			(r) => r.method === "get" && r.path === "/admin/users",
		);
		expect(list).toBeDefined();
	});

	it("mounts GET /admin/login + POST /admin/login + POST /admin/logout when auth is bound", async () => {
		const { manager } = buildFakeAuth({});
		const { routes } = await bootStation({ auth: manager });
		expect(
			routes.find((r) => r.method === "get" && r.path === "/admin/login"),
		).toBeDefined();
		expect(
			routes.find((r) => r.method === "post" && r.path === "/admin/login"),
		).toBeDefined();
		expect(
			routes.find((r) => r.method === "post" && r.path === "/admin/logout"),
		).toBeDefined();
	});

	it("GET /admin/login renders the form and HTML-escapes ?error=", async () => {
		const { manager } = buildFakeAuth({});
		const { routes } = await bootStation({ auth: manager });
		const loginGet = routes.find(
			(r) => r.method === "get" && r.path === "/admin/login",
		);
		if (!loginGet) throw new Error("unreachable");
		const { ctx, res } = buildCtx({
			query: { error: "<script>x</script>" },
		});
		await loginGet.handler(ctx);
		expect(res.contentType).toBe("text/html; charset=utf-8");
		expect(res.body).toContain('name="email"');
		expect(res.body).toContain('name="password"');
		// Error was HTML-escaped, raw <script> never reaches the page.
		expect(res.body).not.toContain("<script>x</script>");
		expect(res.body).toContain("&lt;script&gt;x&lt;/script&gt;");
	});

	it("POST /admin/login with bad creds → 401, form re-rendered, NO cookie set", async () => {
		const { manager } = buildFakeAuth({});
		const { routes } = await bootStation({ auth: manager });
		const loginPost = routes.find(
			(r) => r.method === "post" && r.path === "/admin/login",
		);
		if (!loginPost) throw new Error("unreachable");
		const { ctx, res } = buildCtx({
			body: { email: "admin@example.com", password: "wrong" },
		});
		await loginPost.handler(ctx);
		expect(res.status).toBe(401);
		expect(res.contentType).toBe("text/html; charset=utf-8");
		expect(res.body).toContain('name="password"');
		expect(res.body).toContain("Invalid credentials");
		// Email is preserved so user doesn't retype.
		expect(res.body).toContain('value="admin@example.com"');
		expect(res.cookies.size).toBe(0);
	});

	it("POST /admin/login with good creds → 302 /admin + sets session cookie", async () => {
		const { manager, issuedToken } = buildFakeAuth({});
		const { routes } = await bootStation({ auth: manager });
		const loginPost = routes.find(
			(r) => r.method === "post" && r.path === "/admin/login",
		);
		if (!loginPost) throw new Error("unreachable");
		const { ctx, res } = buildCtx({
			body: { email: "admin@example.com", password: "hunter2" },
		});
		await loginPost.handler(ctx);
		expect(res.status).toBe(302);
		expect(res.location).toBe("/admin");
		const cookie = res.cookies.get("station_auth");
		expect(cookie?.value).toBe(issuedToken);
		expect(cookie?.options?.httpOnly).toBe(true);
		expect(cookie?.options?.sameSite).toBe("Lax");
	});

	it("POST /admin/login rejects empty email/password with 400 before hitting authenticate", async () => {
		let called = false;
		const { manager } = buildFakeAuth({});
		const spied = {
			...manager,
			authenticate(creds: Record<string, unknown>) {
				called = true;
				return manager.authenticate(creds);
			},
		};
		const { routes } = await bootStation({ auth: spied });
		const loginPost = routes.find(
			(r) => r.method === "post" && r.path === "/admin/login",
		);
		if (!loginPost) throw new Error("unreachable");
		const { ctx, res } = buildCtx({ body: { email: "", password: "" } });
		await loginPost.handler(ctx);
		expect(res.status).toBe(400);
		expect(called).toBe(false);
		expect(res.body).toContain("Email and password are both required");
	});

	it("POST /admin/logout clears the cookie and redirects to /admin/login", async () => {
		const { manager } = buildFakeAuth({});
		const { routes } = await bootStation({ auth: manager });
		const logout = routes.find(
			(r) => r.method === "post" && r.path === "/admin/logout",
		);
		if (!logout) throw new Error("unreachable");
		const { ctx, res } = buildCtx({
			cookies: { station_auth: "anything" },
		});
		await logout.handler(ctx);
		expect(res.clearedCookies).toContain("station_auth");
		expect(res.status).toBe(302);
		expect(res.location).toBe("/admin/login");
	});

	// 57.6 — the login surface fail-closes on CSRF too. Login is open (no auth
	// gate), so the CSRF guard is its sole pre-check; logout must not be forceable
	// cross-site. Both refuse before doing any work when the request wasn't
	// CSRF-verified (`ctx.request.csrfProtected !== true`).
	it("POST /admin/login with csrfProtected=false → 403 before authenticate", async () => {
		const { manager } = buildFakeAuth({});
		const { routes } = await bootStation({ auth: manager });
		const login = routes.find(
			(r) => r.method === "post" && r.path === "/admin/login",
		);
		if (!login) throw new Error("unreachable");
		const { ctx, res } = buildCtx({
			body: { email: "admin@example.com", password: "hunter2" },
			csrfProtected: false,
		});
		await login.handler(ctx);
		expect(res.status).toBe(403);
		// No session cookie was set — the credentials were never checked.
		expect(res.cookies.size).toBe(0);
	});

	it("POST /admin/logout with csrfProtected=false → 403, cookie NOT cleared", async () => {
		const { manager } = buildFakeAuth({});
		const { routes } = await bootStation({ auth: manager });
		const logout = routes.find(
			(r) => r.method === "post" && r.path === "/admin/logout",
		);
		if (!logout) throw new Error("unreachable");
		const { ctx, res } = buildCtx({
			cookies: { station_auth: "anything" },
			csrfProtected: false,
		});
		await logout.handler(ctx);
		expect(res.status).toBe(403);
		expect(res.clearedCookies).not.toContain("station_auth");
	});

	it("gated CRUD route w/o token → 302 /admin/login", async () => {
		const { manager } = buildFakeAuth({});
		const { routes } = await bootStation({ auth: manager });
		const list = routes.find(
			(r) => r.method === "get" && r.path === "/admin/users",
		);
		if (!list) throw new Error("unreachable");
		const { ctx, res } = buildCtx({});
		await list.handler(ctx);
		expect(res.status).toBe(302);
		expect(res.location).toBe("/admin/login");
	});

	it("gated CRUD route w/ valid cookie → handler runs, ctx.auth.user populated", async () => {
		const { manager } = buildFakeAuth({});
		const { routes } = await bootStation({ auth: manager });
		const list = routes.find(
			(r) => r.method === "get" && r.path === "/admin/users",
		);
		if (!list) throw new Error("unreachable");
		const { ctx, res } = buildCtx({
			cookies: { station_auth: "TOKEN_OK" },
		});
		await list.handler(ctx);
		expect(res.contentType).toBe("text/html; charset=utf-8");
		expect(res.body).toContain("<table>");
		expect(ctx.auth?.user?.id).toBe(1);
	});

	it("gated CRUD route w/ Authorization: Bearer header also works", async () => {
		const { manager } = buildFakeAuth({});
		const { routes } = await bootStation({ auth: manager });
		const list = routes.find(
			(r) => r.method === "get" && r.path === "/admin/users",
		);
		if (!list) throw new Error("unreachable");
		const { ctx, res } = buildCtx({
			headers: { authorization: "Bearer TOKEN_OK" },
		});
		await list.handler(ctx);
		expect(res.contentType).toBe("text/html; charset=utf-8");
		expect(res.body).toContain("<table>");
	});

	it("gated CRUD route with JSON Accept → 401 JSON instead of redirect", async () => {
		const { manager } = buildFakeAuth({});
		const { routes } = await bootStation({ auth: manager });
		const list = routes.find(
			(r) => r.method === "get" && r.path === "/admin/users",
		);
		if (!list) throw new Error("unreachable");
		const { ctx, res } = buildCtx({
			headers: { accept: "application/json" },
		});
		await list.handler(ctx);
		expect(res.status).toBe(401);
		expect(res.contentType).toBe("application/json");
		expect(res.body).toContain("authentication required");
	});

	it("stale cookie → clearCookie + 302 /admin/login (no infinite loop)", async () => {
		const { manager } = buildFakeAuth({});
		const { routes } = await bootStation({ auth: manager });
		const list = routes.find(
			(r) => r.method === "get" && r.path === "/admin/users",
		);
		if (!list) throw new Error("unreachable");
		const { ctx, res } = buildCtx({
			cookies: { station_auth: "STALE_OR_FORGED" },
		});
		await list.handler(ctx);
		expect(res.clearedCookies).toContain("station_auth");
		expect(res.status).toBe(302);
		expect(res.location).toBe("/admin/login");
	});

	it("requireRole gate → authenticated user without role gets 403, not redirect", async () => {
		const { manager } = buildFakeAuth({
			user: { id: 1, email: "u@example.com", roles: ["editor"] },
		});
		const { routes } = await bootStation({
			auth: manager,
			stationConfig: { requireRole: "admin" },
		});
		const list = routes.find(
			(r) => r.method === "get" && r.path === "/admin/users",
		);
		if (!list) throw new Error("unreachable");
		const { ctx, res } = buildCtx({
			cookies: { station_auth: "TOKEN_OK" },
		});
		await list.handler(ctx);
		expect(res.status).toBe(403);
		expect(res.body).toBe("Forbidden");
	});

	it("requireRole gate → user WITH the required role passes through", async () => {
		const { manager } = buildFakeAuth({
			user: { id: 1, email: "u@example.com", roles: ["admin", "editor"] },
		});
		const { routes } = await bootStation({
			auth: manager,
			stationConfig: { requireRole: "admin" },
		});
		const list = routes.find(
			(r) => r.method === "get" && r.path === "/admin/users",
		);
		if (!list) throw new Error("unreachable");
		const { ctx, res } = buildCtx({
			cookies: { station_auth: "TOKEN_OK" },
		});
		await list.handler(ctx);
		expect(res.contentType).toBe("text/html; charset=utf-8");
		expect(ctx.auth?.roles).toContain("admin");
	});

	it("permission gate (56.5): an authenticated user lacking `users.list` is denied at the authorization layer", async () => {
		// No requireRole, so authentication alone passes #withAuth; the deny
		// comes from the per-action permission gate — `auth.hasPermission`
		// returns false for the unseeded `users.list`. Distinguished from
		// the requireRole gate by the response body (deny() vs "Forbidden").
		const { manager } = buildFakeAuth({
			user: { id: 5, email: "ed@example.com", roles: ["editor"] },
			permissions: [], // rights store grants nothing
		});
		const { routes } = await bootStation({ auth: manager });
		const list = routes.find(
			(r) => r.method === "get" && r.path === "/admin/users",
		);
		if (!list) throw new Error("unreachable");
		const { ctx, res } = buildCtx({ cookies: { station_auth: "TOKEN_OK" } });
		await list.handler(ctx);
		expect(res.status).toBe(403);
		expect(res.body).toContain("does not have access to this resource action");
	});

	it("requireAuth: false in station config disables the gate even when auth is bound", async () => {
		const { manager } = buildFakeAuth({});
		const { routes } = await bootStation({
			auth: manager,
			stationConfig: { requireAuth: false },
		});
		// No login surface mounted.
		expect(
			routes.find((r) => r.method === "get" && r.path === "/admin/login"),
		).toBeUndefined();
		// List route reachable without a token.
		const list = routes.find(
			(r) => r.method === "get" && r.path === "/admin/users",
		);
		if (!list) throw new Error("unreachable");
		const { ctx, res } = buildCtx({});
		await list.handler(ctx);
		expect(res.contentType).toBe("text/html; charset=utf-8");
		expect(res.body).toContain("<table>");
	});

	it("GET /admin/login when already authenticated → redirect to /admin (skip the form)", async () => {
		const { manager } = buildFakeAuth({});
		const { routes } = await bootStation({ auth: manager });
		const loginGet = routes.find(
			(r) => r.method === "get" && r.path === "/admin/login",
		);
		if (!loginGet) throw new Error("unreachable");
		const { ctx, res } = buildCtx({
			cookies: { station_auth: "TOKEN_OK" },
		});
		await loginGet.handler(ctx);
		expect(res.status).toBe(302);
		expect(res.location).toBe("/admin");
	});
});
