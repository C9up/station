import "reflect-metadata";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { defineResource } from "../../src/defineResource.js";
import { ResourceRegistry } from "../../src/ResourceRegistry.js";
import StationProvider, {
	_resetStationProviderFlags,
	type StationAppContext,
} from "../../src/StationProvider.js";
import { _getStation } from "../../src/services/main.js";
import { User } from "../fixtures/User.js";

/**
 * Hand-rolled IoC container + config fake. The Ream container fulfils
 * the same duck-typed surface; using a local fake keeps the test free
 * of `@c9up/ream` and lets us assert binding calls directly.
 */
function makeApp(): {
	app: StationAppContext;
	resolved: unknown[];
	bindings: Map<unknown, () => unknown>;
} {
	const bindings = new Map<unknown, () => unknown>();
	const cache = new Map<unknown, unknown>();
	const resolved: unknown[] = [];
	// Stub `db` so phase 2 of `start()` (per-resource context build) finds
	// a connection. Phase 3 (route registration on the real Ream router
	// proxy) is what these tests actually exercise — the proxy throws
	// "Router accessed before initialization" because Ignitor never wired
	// `_setRouter`, and StationProvider must swallow that silently.
	bindings.set("db", () => ({}));
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
		_resetStationProviderFlags();
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

	it("register() wires _setStation so `services/main` resolves the same instance after boot()", async () => {
		const { app } = makeApp();
		const provider = new StationProvider(app);
		provider.register();
		await provider.boot();
		const direct = app.container.resolve<ResourceRegistry>(ResourceRegistry);
		expect(_getStation()).toBe(direct);
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
		const { app } = makeApp();
		const provider = new StationProvider(app);
		provider.register();
		await provider.boot();
		const registry = app.container.resolve<ResourceRegistry>(ResourceRegistry);
		registry.register(defineResource({ entity: User }));

		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			// Dynamic import of `@c9up/ream/services/router` will fail in the
			// test environment (no Ream host wired); the try/catch swallows
			// silently. The warn fires BEFORE the import attempt, so we still
			// observe it.
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

	it("start() tolerates non-Ream hosts (failed router import → no throw)", async () => {
		const { app } = makeApp();
		const provider = new StationProvider(app);
		provider.register();
		await provider.boot();
		const registry = app.container.resolve<ResourceRegistry>(ResourceRegistry);
		registry.register(defineResource({ entity: User }));

		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			// In the test environment, `@c9up/ream/services/router` import
			// throws (router proxy is uninitialised). Provider MUST swallow
			// silently — Station is supposed to ship publishable / agnostic.
			await expect(provider.start()).resolves.toBeUndefined();
		} finally {
			warnSpy.mockRestore();
		}
	});
});
