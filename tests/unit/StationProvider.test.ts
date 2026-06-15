import "reflect-metadata";
import type { ColumnMetadata } from "@c9up/atlas";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { defineResource } from "../../src/defineResource.js";
import { ResourceRegistry } from "../../src/ResourceRegistry.js";
import StationProvider, {
	filterWritableBody,
	resetStationProviderFlags,
	type StationAppContext,
} from "../../src/StationProvider.js";
import { getStation } from "../../src/services/main.js";
import { User } from "../fixtures/User.js";

/**
 * Hand-rolled IoC container + config fake. The Ream container fulfils
 * the same duck-typed surface; using a local fake keeps the test free
 * of `@c9up/ream` and lets us assert binding calls directly.
 */
/** No-op router fake — satisfies the slice `#registerAdminRoutes` calls. */
function makeNoopRouter(): unknown {
	const noop = () => undefined;
	return { get: noop, post: noop, put: noop, delete: noop };
}

function makeApp(opts?: { router?: unknown }): {
	app: StationAppContext;
	resolved: unknown[];
	bindings: Map<unknown, () => unknown>;
} {
	const bindings = new Map<unknown, () => unknown>();
	const cache = new Map<unknown, unknown>();
	const resolved: unknown[] = [];
	// Stub `db` so phase 2 of `start()` (per-resource context build) finds a
	// connection. The provider resolves the host router from the container under
	// the `'router'` token (as Ignitor registers it) — NOT via a `@c9up/ream`
	// import. Register one only when the test wants `start()` to proceed past
	// Phase 1; omit it to exercise the degraded "no router" (non-Ream) path.
	bindings.set("db", () => ({}));
	if (opts?.router !== undefined) {
		const router = opts.router;
		bindings.set("router", () => router);
	}
	const app: StationAppContext = {
		container: {
			singleton(token, factory) {
				bindings.set(token, factory as () => unknown);
			},
			resolve<T>(token: unknown): T {
				resolved.push(token);
				if (cache.has(token)) return cache.get(token) as T;
				const factory = bindings.get(token);
				if (!factory) throw new Error(`not registered: ${String(token)}`);
				const value = factory();
				cache.set(token, value);
				return value as T;
			},
			has(token: unknown): boolean {
				return cache.has(token) || bindings.has(token);
			},
		},
		config: {
			get<T>(_key: string): T | undefined {
				return undefined;
			},
		},
	};
	return { app, resolved, bindings };
}

describe("station > StationProvider > lifecycle", () => {
	beforeEach(() => {
		resetStationProviderFlags();
	});

	it("register() binds ResourceRegistry + 'station' alias, both pointing at the same singleton", () => {
		const { app, bindings } = makeApp();
		new StationProvider(app).register();
		expect(bindings.has(ResourceRegistry)).toBe(true);
		expect(bindings.has("station")).toBe(true);
		const byClass = app.container.resolve<ResourceRegistry>(ResourceRegistry);
		const byAlias = app.container.resolve<ResourceRegistry>("station");
		expect(byClass).toBeInstanceOf(ResourceRegistry);
		expect(byAlias).toBe(byClass);
	});

	it("register() wires setStation so `services/main` resolves the same instance after boot()", async () => {
		const { app } = makeApp();
		const provider = new StationProvider(app);
		provider.register();
		await provider.boot();
		const direct = app.container.resolve<ResourceRegistry>(ResourceRegistry);
		expect(getStation()).toBe(direct);
	});

	it("boot() force-resolves the registry exactly once even if nothing else touches it", async () => {
		const { app, resolved } = makeApp();
		const provider = new StationProvider(app);
		provider.register();
		await provider.boot();
		const resolveCalls = resolved.filter((t) => t === ResourceRegistry);
		expect(resolveCalls.length).toBe(1);
	});

	it("start() with zero registered resources is a fully silent no-op (no warn, no router-import attempt)", async () => {
		const { app } = makeApp();
		const provider = new StationProvider(app);
		provider.register();
		await provider.boot();

		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			await provider.start();
			expect(warnSpy).not.toHaveBeenCalled();
		} finally {
			warnSpy.mockRestore();
		}
	});

	it("start() with a registered resource emits the auth warn EXACTLY ONCE across multiple start() calls", async () => {
		const { app } = makeApp({ router: makeNoopRouter() });
		const provider = new StationProvider(app);
		provider.register();
		await provider.boot();
		const registry = app.container.resolve<ResourceRegistry>(ResourceRegistry);
		registry.register(defineResource({ entity: User }));

		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			// A router is registered in the container, so start() proceeds through
			// Phase 1b (#configureAuth) where the no-auth warn fires. The second
			// start() short-circuits via the `#started` guard — warn fires once.
			await provider.start();
			await provider.start();
			const warnCalls = warnSpy.mock.calls.filter((call) =>
				String(call[0]).includes("[station] Admin routes mounted without auth"),
			);
			expect(warnCalls.length).toBe(1);
		} finally {
			warnSpy.mockRestore();
		}
	});

	it("start() tolerates non-Ream hosts (no 'router' registered → no throw)", async () => {
		// No router registered in the container (`makeApp()` omits it) — the
		// non-Ream / not-wired host shape. #loadPeers returns null and start()
		// returns silently. Station ships publishable / agnostic.
		const { app } = makeApp();
		const provider = new StationProvider(app);
		provider.register();
		await provider.boot();
		const registry = app.container.resolve<ResourceRegistry>(ResourceRegistry);
		registry.register(defineResource({ entity: User }));

		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			await expect(provider.start()).resolves.toBeUndefined();
		} finally {
			warnSpy.mockRestore();
		}
	});
});

// Audit 2026-06-13: an unchecked checkbox submits nothing, so a boolean column
// could never be cleared to false on edit, and a checked box stored the raw "1".
describe("station > filterWritableBody — checkbox/boolean coercion", () => {
	const columns: ColumnMetadata[] = [
		{ propertyKey: "name", type: "string" },
		{ propertyKey: "active", type: "boolean" },
	];

	it("clears a boolean to false when the checkbox is unchecked (absent from body)", () => {
		const out = filterWritableBody({ name: "x" }, columns, "id", new Set());
		expect(out).toEqual({ name: "x", active: false });
	});

	it("coerces a checked checkbox ('1') to a real boolean true", () => {
		const out = filterWritableBody(
			{ name: "x", active: "1" },
			columns,
			"id",
			new Set(),
		);
		expect(out).toEqual({ name: "x", active: true });
	});
});
