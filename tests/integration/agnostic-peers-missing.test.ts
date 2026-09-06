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
 *   - Unit-level: `isModuleNotFound` recognises BOTH the ESM
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
 * exported `isModuleNotFound` covers that branch with a real
 * Node-shaped error.
 */
import "reflect-metadata";
import { beforeEach, describe, expect, it } from "vitest";
import { defineResource } from "../../src/defineResource.js";
import { ResourceRegistry } from "../../src/ResourceRegistry.js";
import StationProvider, {
	isModuleNotFound,
	resetStationProviderFlags,
	resourcesNeedValidation,
	type StationAppContext,
	type StationConfig,
} from "../../src/StationProvider.js";
import { bypassTypeCheck } from "../__helpers__/bypass-type-check.js";
import { makeInkerRenderer } from "../__helpers__/inker-renderer.js";
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
	// 57.1 — bind the shared inker renderer by default (Station hard-requires a
	// view engine once an admin surface exists). The inker-missing test opts out.
	bindInker?: boolean;
}): StationAppContext {
	const bindings = new Map<unknown, () => unknown>();
	const cache = new Map<unknown, unknown>();
	if (opts.db !== undefined) bindings.set("db", () => opts.db);
	if (opts.auth !== undefined) bindings.set("auth", () => opts.auth);
	if (opts.bindInker !== false) {
		bindings.set("inker", () => makeInkerRenderer());
	}
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

function captureRoutes(app: StationAppContext): { calls: string[] } {
	const calls: string[] = [];
	const fakeRouter = {
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
	};
	// The provider resolves the host router from the container under `'router'`
	// (as Ignitor registers it) — NOT via a `@c9up/ream` import.
	app.container.singleton("router", () => fakeRouter);
	return { calls };
}

describe("station > integration > 54.8 agnostic peer-missing boot", () => {
	beforeEach(() => {
		resetStationProviderFlags();
	});

	describe("isModuleNotFound predicate (degraded-host vs real-bug branch)", () => {
		it("recognises ESM ERR_MODULE_NOT_FOUND", () => {
			expect(
				isModuleNotFound(
					makeError("ERR_MODULE_NOT_FOUND", "Cannot find module '@c9up/atlas'"),
				),
			).toBe(true);
		});

		it("recognises CJS MODULE_NOT_FOUND fallback", () => {
			expect(
				isModuleNotFound(
					makeError("MODULE_NOT_FOUND", "Cannot find module '@c9up/atlas'"),
				),
			).toBe(true);
		});

		it("rejects any other error code → real bug propagates", () => {
			expect(
				isModuleNotFound(makeError("ERR_INVALID_ARG_TYPE", "bad arg")),
			).toBe(false);
			expect(isModuleNotFound(new Error("plain error w/o code"))).toBe(false);
		});

		it("rejects non-error inputs (null / undefined / string / number)", () => {
			expect(isModuleNotFound(null)).toBe(false);
			expect(isModuleNotFound(undefined)).toBe(false);
			expect(isModuleNotFound("ERR_MODULE_NOT_FOUND")).toBe(false);
			expect(isModuleNotFound(42)).toBe(false);
			expect(isModuleNotFound({})).toBe(false);
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
					await app.container.resolve<ResourceRegistry>(ResourceRegistry);
				registry.register(defineResource({ entity: User }));

				const { calls } = captureRoutes(app);
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
			app.container.resolve = <T>(token: unknown): Promise<T> => {
				resolveCalls.push(token);
				return originalResolve<T>(token);
			};

			const provider = new StationProvider(app);
			provider.register();
			await provider.boot();
			const registry =
				await originalResolve<ResourceRegistry>(ResourceRegistry);
			registry.register(defineResource({ entity: User }));

			// Reset the recorder to capture only start()'s lookups.
			resolveCalls = [];
			const { calls } = captureRoutes(app);
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
					async resolve<T>(token: unknown): Promise<T> {
						if (token === "db") dbResolved = true;
						if (token === "station" || token === ResourceRegistry) {
							return bypassTypeCheck<T>(new ResourceRegistry());
						}
						throw new Error(`not registered: ${String(token)}`);
					},
					has: () => false,
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

	describe("inker missing (view engine is a HARD render requirement, D2)", () => {
		// Story 57.1: unlike warden (absence → open dev-preview), a missing view
		// engine when an admin surface exists is a misconfiguration. Station
		// consumes inker via the `"inker"` container alias (AdonisJS package-views
		// pattern), so "missing" is simply an unbound `"inker"` — driven through
		// the REAL start() gate with `bindInker: false`.
		it('resources registered + no `"inker"` bound ⇒ start() throws the register-inker error', async () => {
			const app = buildApp({ db: buildMinimalDb(), bindInker: false });
			const provider = new StationProvider(app);
			provider.register();
			await provider.boot();
			(
				await app.container.resolve<ResourceRegistry>(ResourceRegistry)
			).register(defineResource({ entity: User }));
			captureRoutes(app);

			await expect(provider.start()).rejects.toThrow(/register @c9up\/inker/);
		});

		it('resources registered + `"inker"` resolves to a non-conforming value ⇒ start() throws the not-usable error, and the runtime guard is what rejected it (57.1 review)', async () => {
			const app = buildApp({ db: buildMinimalDb(), bindInker: false });
			// A registered-but-half-wired binding: `has("inker")` is true, but the
			// resolved value lacks `renderToString`. Must fail loud at boot with the
			// actionable "not usable" error, NOT a raw TypeError at `renderer.mount`.
			app.container.singleton("inker", () => ({ mount() {} }));
			const provider = new StationProvider(app);
			provider.register();
			await provider.boot();
			(
				await app.container.resolve<ResourceRegistry>(ResourceRegistry)
			).register(defineResource({ entity: User }));
			captureRoutes(app);

			const err: unknown = await provider.start().then(
				() => {
					throw new Error("expected start() to reject");
				},
				(e) => e,
			);
			if (!(err instanceof Error)) {
				throw new Error("expected start() to reject with an Error");
			}
			expect(err.message).toMatch(/not usable/);
			// The chained cause proves the `isInkerViewRenderer` guard is what
			// rejected the half-wired binding (missing renderToString) — not an
			// unrelated resolve failure, and not a raw TypeError surfacing later
			// at `renderer.mount`.
			if (!(err.cause instanceof Error)) {
				throw new Error("expected a chained cause Error from the guard");
			}
			expect(err.cause.message).toMatch(/not a usable view renderer/);
		});

		it("mounts a resource declared AFTER start(), the way a preload declares one", async () => {
			// The defect this closes: the provider read a snapshot of the registry
			// in `start()` and gave up when it was empty. Providers start BEFORE
			// preloads run, and a preload is where the documentation says to write
			// `station.register(...)` — so an application that followed the docs
			// got no admin at all, and nothing said why.
			const app = buildApp({ db: buildMinimalDb() });
			const provider = new StationProvider(app);
			provider.register();
			await provider.boot();
			const { calls } = captureRoutes(app);

			await provider.start();
			// Nothing yet — no resource has been declared.
			expect(calls).toEqual([]);

			// What a preload writes, after every provider has started.
			const registry =
				await app.container.resolve<ResourceRegistry>(ResourceRegistry);
			registry.register(defineResource({ entity: User, actions: ["list"] }));

			// Mounted on the spot: the shell and the resource's own routes.
			expect(calls).toContain("GET /admin");
			expect(calls).toContain("GET /admin/users");
		});

		it("empty registry ⇒ start() returns early, inker never required", async () => {
			const app = buildApp({ db: buildMinimalDb(), bindInker: false });
			const provider = new StationProvider(app);
			provider.register();
			await provider.boot();
			// no registry.register() — zero resources
			captureRoutes(app);

			await expect(provider.start()).resolves.toBeUndefined();
		});
	});

	describe("rune required for write admins (57.7, AC7 fail-closed decision)", () => {
		// rune is consumed via the SAME tolerant dynamic import as atlas, so its
		// ABSENCE cannot be simulated through start() inside vitest (see this
		// file's header — the dynamic-import-not-found path isn't reproducible).
		// The boot decision "is rune REQUIRED?" is therefore isolated in the pure
		// `resourcesNeedValidation` predicate and pinned directly here — mirroring
		// how the atlas-absent branch is covered by `isModuleNotFound`. start()
		// throws the loud install-@c9up/rune error iff this predicate is true and
		// the dynamic import returned null.
		it("a write-capable resource (create/edit) requires rune", () => {
			const write = defineResource({ entity: User }); // defaults include create+edit
			expect(resourcesNeedValidation([write])).toBe(true);
		});

		it("a read-only resource (list/show) does NOT require rune", () => {
			const readOnly = defineResource({
				entity: User,
				actions: ["list", "show"],
			});
			expect(resourcesNeedValidation([readOnly])).toBe(false);
		});

		it("destroy-only does NOT require rune (no request body maps onto columns)", () => {
			const destroyOnly = defineResource({
				entity: User,
				actions: ["list", "destroy"],
			});
			expect(resourcesNeedValidation([destroyOnly])).toBe(false);
		});

		it("no resources ⇒ rune not required", () => {
			expect(resourcesNeedValidation([])).toBe(false);
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

			const { calls } = captureRoutes(app);
			await provider.start();
			expect(calls).toHaveLength(0);
		});
	});
});
