/**
 * Shared in-process harness for the provider suites added after the epic 72
 * audit: boots `StationProvider` against a captured router, a generic
 * in-memory table, an optional warden-shaped `"auth"` fake and an optional
 * `station` config block, then hands back the captured handlers.
 */
import { defineResource } from "../../src/defineResource.js";
import { ResourceRegistry } from "../../src/ResourceRegistry.js";
import StationProvider, {
	type StationAppContext,
	type StationConfig,
} from "../../src/StationProvider.js";
import { bypassTypeCheck } from "./bypass-type-check.js";
import { makeInkerRenderer } from "./inker-renderer.js";

export interface CookieCall {
	name: string;
	value?: string;
	options?: Record<string, unknown>;
}

export class ResponseRecorder {
	status?: number;
	contentType?: string;
	body?: string;
	location?: string;
	headers = new Map<string, string>();
	cookies: CookieCall[] = [];
	cleared: CookieCall[] = [];

	get fns(): Record<string, unknown> {
		return {
			status: (code: number) => {
				this.status = code;
				return this;
			},
			type: (value: string) => {
				this.contentType = value;
				return this;
			},
			send: (body: string) => {
				this.body = body;
				return this;
			},
			header: (name: string, value: string) => {
				this.headers.set(name.toLowerCase(), value);
				if (name.toLowerCase() === "location") this.location = value;
				return this;
			},
			redirect: (url: string) => {
				this.status = 302;
				this.location = url;
				return this;
			},
			json: (data: unknown) => {
				this.body = JSON.stringify(data);
				this.contentType = "application/json";
				return this;
			},
			cookie: (
				name: string,
				value: string,
				options?: Record<string, unknown>,
			) => {
				this.cookies.push({ name, value, options });
				return this;
			},
			clearCookie: (name: string, options?: Record<string, unknown>) => {
				this.cleared.push({ name, options });
				return this;
			},
		};
	}
}

export interface HttpContextLike {
	request: Record<string, unknown>;
	response: Record<string, unknown>;
	params: Record<string, string>;
	auth?: { user?: { id: unknown; [key: string]: unknown }; roles?: string[] };
	store?: { get(key: string): unknown };
	session?: Record<string, unknown>;
}

export interface CtxOptions {
	query?: Record<string, string>;
	params?: Record<string, string>;
	body?: Record<string, unknown>;
	headers?: Record<string, string>;
	cookies?: Record<string, string>;
	/** Defaults to `true`: these suites test other gates than CSRF. */
	csrfProtected?: boolean;
	/** Preset `ctx.auth.user` (only meaningful without an `"auth"` binding). */
	user?: { id: unknown; [key: string]: unknown };
	ip?: string;
	host?: string;
	/** What `request.secure()` answers (HTTPS). */
	secure?: boolean;
	url?: string;
}

export function buildCtx(opts: CtxOptions = {}): {
	ctx: HttpContextLike;
	res: ResponseRecorder;
} {
	const res = new ResponseRecorder();
	const headers: Record<string, string> = {};
	for (const [k, v] of Object.entries(opts.headers ?? {}))
		headers[k.toLowerCase()] = v;
	if (opts.host !== undefined) headers.host = opts.host;
	const cookies = opts.cookies ?? {};
	const body = opts.body ?? {};
	const request: Record<string, unknown> = {
		qs: () => opts.query ?? {},
		body: () => body,
		header: (name: string) => headers[name.toLowerCase()],
		cookie: (name: string) => cookies[name],
		csrfProtected: opts.csrfProtected ?? true,
		url: () => opts.url ?? "/admin",
		host: () => headers.host ?? null,
		id: () => headers["x-request-id"],
		secure: () => opts.secure === true,
		protocol: () => (opts.secure === true ? "https" : "http"),
	};
	if (opts.ip !== undefined) {
		const ip = opts.ip;
		request.ip = () => ip;
	}
	const ctx: HttpContextLike = {
		request,
		response: res.fns,
		params: opts.params ?? {},
		auth: opts.user === undefined ? undefined : { user: opts.user },
	};
	return { ctx, res };
}

function toSnake(key: string): string {
	return key.replace(/([A-Z])/g, "_$1").toLowerCase();
}

/**
 * A single in-memory table driven by the SQL atlas's `BaseRepository` emits.
 * Rows are stored under their DB (snake_case) column names, as a driver
 * would return them.
 */
export function buildTableDb(seed: ReadonlyArray<Record<string, unknown>>) {
	const rows = new Map<number, Record<string, unknown>>();
	let nextId = 1;
	for (const r of seed) {
		const id = Number(r.id);
		rows.set(id, { ...r });
		nextId = Math.max(nextId, id + 1);
	}
	const statements: Array<{ sql: string; params: unknown[] }> = [];

	function idParam(params: unknown[]): number {
		return Number(params[params.length - 1]);
	}

	function execute(sql: string, params: unknown[]): { rowsAffected: number } {
		statements.push({ sql, params });
		if (/^\s*UPDATE/i.test(sql)) {
			const setMatch = sql.match(/SET\s+(.+?)\s+WHERE/i);
			const row = rows.get(idParam(params));
			if (!setMatch || row === undefined) return { rowsAffected: 0 };
			const cols = (setMatch[1] ?? "")
				.split(",")
				.map((s) => (s.trim().split(/\s*=\s*/)[0] ?? "").replace(/"/g, ""));
			cols.forEach((col, i) => {
				row[col] = params[i];
			});
			return { rowsAffected: 1 };
		}
		if (/^\s*DELETE/i.test(sql)) {
			rows.delete(idParam(params));
			return { rowsAffected: 1 };
		}
		return { rowsAffected: 0 };
	}

	function query(sql: string, params: unknown[]): unknown[] {
		statements.push({ sql, params });
		if (sql.includes("COUNT(*)")) {
			return [{ __scalar__: rows.size, count: rows.size }];
		}
		if (/INSERT[\s\S]+RETURNING/i.test(sql)) {
			const colMatch = sql.match(/\(([^)]+)\)\s*VALUES/i);
			const row: Record<string, unknown> = {};
			const cols = (colMatch?.[1] ?? "")
				.split(",")
				.map((c) => c.trim().replace(/"/g, ""));
			cols.forEach((c, i) => {
				row[c] = params[i];
			});
			const id = nextId++;
			row.id = id;
			rows.set(id, row);
			return [row];
		}
		if (/WHERE\s+"?id"?\s*=\s*\?/i.test(sql)) {
			const row = rows.get(Number(params[0]));
			return row ? [{ ...row }] : [];
		}
		return [...rows.values()].map((r) => ({ ...r }));
	}

	return {
		rows,
		statements,
		db: {
			execute: (sql: string, params: unknown[] = []) =>
				Promise.resolve(execute(sql, params)),
			query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
				return Promise.resolve(bypassTypeCheck<T[]>(query(sql, params)));
			},
		},
		snake: toSnake,
	};
}

export interface FakeAuthOptions {
	/** Permissions granted; omitted ⇒ every permission is granted. */
	permissions?: ReadonlyArray<string>;
	user?: { id: unknown; [key: string]: unknown };
	validToken?: string;
	credentials?: { email: string; password: string };
	/** Expose a default strategy with `revoke(token)` (JwtStrategy shape). */
	revocable?: boolean;
}

export function buildFakeAuth(opts: FakeAuthOptions = {}) {
	const validTokens = new Set([opts.validToken ?? "TOKEN_OK"]);
	const user = opts.user ?? { id: 1, roles: ["admin"] };
	const credentials = opts.credentials ?? {
		email: "admin@example.com",
		password: "hunter2",
	};
	const grantAll = opts.permissions === undefined;
	const granted = new Set(opts.permissions ?? []);
	const asked: string[] = [];
	const calls = { authenticate: 0, revoke: [] as string[] };
	let issued = 0;
	const strategy = {
		revoke(token: string): Promise<boolean> {
			calls.revoke.push(token);
			return Promise.resolve(validTokens.delete(token));
		},
	};
	const manager: Record<string, unknown> = {
		authenticate(creds: Record<string, unknown>) {
			calls.authenticate++;
			if (
				creds.email === credentials.email &&
				creds.password === credentials.password
			) {
				issued++;
				const token = ["ISSUED", String(issued)].join("_");
				validTokens.add(token);
				return Promise.resolve({
					authenticated: true,
					user: { ...user, token },
				});
			}
			return Promise.resolve({
				authenticated: false,
				error: "Invalid credentials",
			});
		},
		verify(token: string) {
			if (validTokens.has(token)) {
				return Promise.resolve({ authenticated: true, user });
			}
			return Promise.resolve({ authenticated: false, error: "Invalid token" });
		},
		hasPermission(_u: unknown, permission: string) {
			asked.push(permission);
			return Promise.resolve(grantAll || granted.has(permission));
		},
		hasRole(u: { roles?: unknown }, role: string) {
			const roles = Array.isArray(u.roles) ? u.roles : [];
			return Promise.resolve(roles.includes(role));
		},
	};
	if (opts.revocable === true) {
		manager.getStrategy = () => strategy;
	}
	return { manager, asked, calls, validTokens };
}

export interface CapturedRoute {
	method: "get" | "post" | "put" | "delete";
	path: string;
	handler: (ctx: HttpContextLike) => Promise<void> | void;
	middleware: string[];
}

export async function bootStation(opts: {
	db: unknown;
	resources: ReadonlyArray<Parameters<typeof defineResource>[0]>;
	auth?: unknown;
	config?: StationConfig;
}): Promise<{
	routes: CapturedRoute[];
	find(method: CapturedRoute["method"], path: string): CapturedRoute;
}> {
	const routes: CapturedRoute[] = [];
	const capture =
		(method: CapturedRoute["method"]) =>
		(path: string, handler: CapturedRoute["handler"]): unknown => {
			const route: CapturedRoute = { method, path, handler, middleware: [] };
			routes.push(route);
			return {
				middleware(...names: string[]) {
					route.middleware.push(...names);
					return this;
				},
			};
		};
	const router = {
		get: capture("get"),
		post: capture("post"),
		put: capture("put"),
		delete: capture("delete"),
	};
	const bindings = new Map<unknown, () => unknown>();
	const cache = new Map<unknown, unknown>();
	bindings.set("db", () => opts.db);
	bindings.set("router", () => router);
	bindings.set("inker", () => makeInkerRenderer());
	if (opts.auth !== undefined) {
		const auth = opts.auth;
		bindings.set("auth", () => auth);
	}
	const app: StationAppContext = {
		container: {
			singleton(token, factory) {
				bindings.set(token, factory);
			},
			async resolve<T>(token: unknown): Promise<T> {
				if (cache.has(token)) return bypassTypeCheck<T>(cache.get(token));
				const factory = bindings.get(token);
				if (!factory) throw new Error(`not registered: ${String(token)}`);
				const value = await factory();
				cache.set(token, value);
				return bypassTypeCheck<T>(value);
			},
			has: (token) => cache.has(token) || bindings.has(token),
		},
		config: {
			get<T>(key: string): T | undefined {
				return key === "station" && opts.config !== undefined
					? bypassTypeCheck<T>(opts.config)
					: undefined;
			},
		},
	};
	const provider = new StationProvider(app);
	provider.register();
	await provider.boot();
	const registry =
		await app.container.resolve<ResourceRegistry>(ResourceRegistry);
	for (const r of opts.resources) registry.register(defineResource(r));
	await provider.start();
	return {
		routes,
		find(method, path) {
			const r = routes.find((x) => x.method === method && x.path === path);
			if (r === undefined) throw new Error(`no ${method} ${path}`);
			return r;
		},
	};
}
