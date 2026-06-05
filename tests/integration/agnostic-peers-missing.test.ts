/**
 * Story 54.8 — agnostic package boot.
 *
 * StationProvider must boot cleanly when ANY of its three peers is
 * missing — `@c9up/ream` (router), `@c9up/atlas` (ORM), or
 * `@c9up/warden` (auth). Each peer is declared optional via
 * `peerDependenciesMeta`, so the package contract is that a host
 * installing Station alone does NOT have to install the others
 * (memory `project_package_extraction`).
 *
 * Coverage approach:
 *   - Unit-level: `_isModuleNotFound` recognises BOTH the ESM
 *     `ERR_MODULE_NOT_FOUND` and the CJS `MODULE_NOT_FOUND` codes —
 *     this is the predicate that branches start() between "silent
 *     return (degraded host)" vs "throw (real bug)".
 *   - Observable: warden absent (no `auth` binding in container) →
 *     start() mounts CRUD routes in legacy-open mode AND emits the
 *     boot-time warn-once.
 *   - Observable: registry empty → start() returns before touching
 *     any peer, so a degraded host with no resources never trips
 *     atlas / router resolution.
 *   - Observable: `requireAuth: false` config → no login routes,
 *     no warden lookup, no `auth` container resolution attempted.
 *
 * We intentionally do NOT use `vi.doMock` to fake the dynamic
 * `import("@c9up/atlas")` failure: vitest's mock graph cannot
 * simulate `ERR_MODULE_NOT_FOUND` from a factory (factories that
 * throw produce a generic `[vitest] There was an error when mocking`
 * wrapper, not the code-bearing error the predicate matches). The
 * exported `_isModuleNotFound` covers that branch with a real
 * Node-shaped error.
 */
import "reflect-metadata";
import { beforeEach, describe, expect, it } from "vitest";
import { defineResource } from "../../src/defineResource.js";
import { ResourceRegistry } from "../../src/ResourceRegistry.js";
import StationProvider, {
	_isModuleNotFound,
	_resetStationProviderFlags,
	type StationAppContext,
	type StationConfig,
} from "../../src/StationProvider.js";
import { bypassTypeCheck } from "../__helpers__/bypass-type-check.js";
import { User } from "../fixtures/User.js";

function makeError(code: string, message: string): Error & { code: string } {
	const err = new Error(message) as Error & { code: string };
	err.code = code;
	return err;
}

function buildApp(opts: {
	db?: unknown;
	auth?: unknown;
	stationConfig?: StationConfig;
}): StationAppContext {
	const bindings = new Map<unknown, () => unknown>();
	const cache = new Map<unknown, unknown>();
	if (opts.db !== undefined) bindings.set("db", () => opts.db);
	if (opts.auth !== undefined) bindings.set("auth", () => opts.auth);
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
			get<T>(key: string): T | undefined {
				if (key === "station" && opts.stationConfig !== undefined) {
					return bypassTypeCheck<T>(opts.stationConfig);
				}
				return undefined;
			},
		},
	};
}

function buildMinimalDb() {
	return {
		execute() {
			return Promise.resolve({ rowsAffected: 0 });
		},
		query<T>(): Promise<T[]> {
			return Promise.resolve([]);
		},
	};
}

async function captureRoutes(): Promise<{
	calls: string[];
	finish: () => void;
}> {
	const calls: string[] = [];
	const routerMod = bypassTypeCheck<{
		_setRouter: (router: unknown) => void;
	}>(await import("@c9up/ream/services/router"));
	routerMod._setRouter(
		bypassTypeCheck({
			get: (p: string) => {
				calls.push(`GET ${p}`);
				return {};
			},
			post: (p: string) => {
				calls.push(`POST ${p}`);
				return {};
			},
			put: (p: string) => {
				calls.push(`PUT ${p}`);
				return {};
			},
			delete: (p: string) => {
				calls.push(`DELETE ${p}`);
				return {};
			},
		}),
	);
	return {
		calls,
		finish: () => {
			/* router stays mounted — vitest resets between tests */
		},
	};
}

describe("station > integration > 54.8 agnostic peer-missing boot", () => {
	beforeEach(() => {
		_resetStationProviderFlags();
	});

	describe("_isModuleNotFound predicate (degraded-host vs real-bug branch)", () => {
		it("recognises ESM ERR_MODULE_NOT_FOUND", () => {
			expect(
				_isModuleNotFound(
					makeError("ERR_MODULE_NOT_FOUND", "Cannot find module '@c9up/atlas'"),
				),
			).toBe(true);
		});

		it("recognises CJS MODULE_NOT_FOUND fallback", () => {
			expect(
				_isModuleNotFound(
					makeError("MODULE_NOT_FOUND", "Cannot find module '@c9up/atlas'"),
				),
			).toBe(true);
		});

		it("rejects any other error code → real bug propagates", () => {
			expect(
				_isModuleNotFound(makeError("ERR_INVALID_ARG_TYPE", "bad arg")),
			).toBe(false);
			expect(_isModuleNotFound(new Error("plain error w/o code"))).toBe(false);
		});

		it("rejects non-error inputs (null / undefined / string / number)", () => {
			expect(_isModuleNotFound(null)).toBe(false);
			expect(_isModuleNotFound(undefined)).toBe(false);
			expect(_isModuleNotFound("ERR_MODULE_NOT_FOUND")).toBe(false);
			expect(_isModuleNotFound(42)).toBe(false);
			expect(_isModuleNotFound({})).toBe(false);
		});
	});

	describe("warden missing (no 'auth' binding)", () => {
		it("mounts CRUD in open mode + emits boot-time warn-once", async () => {
			const warnSpy: unknown[][] = [];
			const original = console.warn;
			console.warn = (...args: unknown[]) => {
				warnSpy.push(args);
			};
			try {
				const app = buildApp({ db: buildMinimalDb() });
				const provider = new StationProvider(app);
				provider.register();
				await provider.boot();
				const registry =
					app.container.resolve<ResourceRegistry>(ResourceRegistry);
				registry.register(defineResource({ entity: User }));

				const { calls } = await captureRoutes();
				await provider.start();

				// CRUD routes mounted.
				expect(calls).toContain("GET /admin/users");
				expect(calls).toContain("GET /admin/users/new");
				// Login surface NOT mounted (no warden).
				expect(calls.some((r) => r.includes("/admin/login"))).toBe(false);
				expect(calls.some((r) => r.includes("/admin/logout"))).toBe(false);

				// Boot-time warn-once tells operators auth is off.
				const authWarn = warnSpy.find(
					(args) =>
						typeof args[0] === "string" &&
						args[0].includes("Admin routes mounted without auth"),
				);
				expect(authWarn).toBeDefined();
			} finally {
				console.warn = original;
			}
		});

		it("requireAuth: false in config → no warden lookup attempted (no 'auth' resolve)", async () => {
			let resolveCalls: unknown[] = [];
			const app = buildApp({
				db: buildMinimalDb(),
				stationConfig: { requireAuth: false },
			});
			// Wrap resolve to record what was asked for.
			const originalResolve = app.container.resolve.bind(app.container);
			app.container.resolve = <T>(token: unknown): T => {
				resolveCalls.push(token);
				return originalResolve<T>(token);
			};

			const provider = new StationProvider(app);
			provider.register();
			await provider.boot();
			const registry = originalResolve<ResourceRegistry>(ResourceRegistry);
			registry.register(defineResource({ entity: User }));

			// Reset the recorder to capture only start()'s lookups.
			resolveCalls = [];
			const { calls } = await captureRoutes();
			await provider.start();

			// CRUD mounted.
			expect(calls).toContain("GET /admin/users");
			// No login surface.
			expect(calls.some((r) => r.includes("/admin/login"))).toBe(false);
			// `auth` was never asked for — Station respected the opt-out.
			expect(resolveCalls).not.toContain("auth");
		});
	});

	describe("registry empty (no resources)", () => {
		it("start() returns before resolving 'db' or any peer (cheapest degraded path)", async () => {
			let dbResolved = false;
			const app: StationAppContext = {
				container: {
					singleton: () => {},
					resolve<T>(token: unknown): T {
						if (token === "db") dbResolved = true;
						if (token === "station" || token === ResourceRegistry) {
							return bypassTypeCheck<T>(new ResourceRegistry());
						}
						throw new Error(`not registered: ${String(token)}`);
					},
				},
				config: {
					get<T>(): T | undefined {
						return undefined;
					},
				},
			};
			const provider = new StationProvider(app);
			await provider.boot();
			await expect(provider.start()).resolves.toBeUndefined();
			expect(dbResolved).toBe(false);
		});
	});

	describe("warden bound, no resources → login surface still skipped (no resources = no admin surface)", () => {
		it("doesn't mount login routes either when there are zero resources", async () => {
			const app = buildApp({
				db: buildMinimalDb(),
				auth: {
					authenticate: () =>
						Promise.resolve({ authenticated: false, error: "x" }),
					verify: () => Promise.resolve({ authenticated: false, error: "x" }),
				},
			});
			const provider = new StationProvider(app);
			provider.register();
			await provider.boot();
			// no registry.register() — registry stays empty

			const { calls } = await captureRoutes();
			await provider.start();
			expect(calls).toHaveLength(0);
		});
	});
});
