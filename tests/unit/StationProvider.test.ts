import "reflect-metadata";
import type { ColumnMetadata } from "@c9up/atlas";
import { rules, schema } from "@c9up/rune";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { defineResource } from "../../src/defineResource.js";
import { ResourceRegistry } from "../../src/ResourceRegistry.js";
import StationProvider, {
	deriveWritableSchema,
	resetStationProviderFlags,
	type StationAppContext,
	validateWritableBody,
} from "../../src/StationProvider.js";
import { getStation } from "../../src/services/main.js";
import { makeInkerRenderer } from "../__helpers__/inker-renderer.js";
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
	// 57.1 — bind the shared inker renderer (the `"inker"` alias). Harmless for
	// the empty-registry / non-Ream tests (they return before the view-engine
	// gate); required once start() proceeds past Phase 1 with a resource + router.
	bindings.set("inker", () => makeInkerRenderer());
	if (opts?.router !== undefined) {
		const router = opts.router;
		bindings.set("router", () => router);
	}
	const app: StationAppContext = {
		container: {
			singleton(token, factory) {
				bindings.set(token, factory as () => unknown);
			},
			async resolve<T>(token: unknown): Promise<T> {
				resolved.push(token);
				if (cache.has(token)) return cache.get(token) as T;
				const factory = bindings.get(token);
				if (!factory) throw new Error(`not registered: ${String(token)}`);
				const value = await factory();
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

	it("register() binds ResourceRegistry + 'station' alias, both pointing at the same singleton", async () => {
		const { app, bindings } = makeApp();
		new StationProvider(app).register();
		expect(bindings.has(ResourceRegistry)).toBe(true);
		expect(bindings.has("station")).toBe(true);
		const byClass =
			await app.container.resolve<ResourceRegistry>(ResourceRegistry);
		const byAlias = await app.container.resolve<ResourceRegistry>("station");
		expect(byClass).toBeInstanceOf(ResourceRegistry);
		expect(byAlias).toBe(byClass);
	});

	it("register() wires setStation so `services/main` resolves the same instance after boot()", async () => {
		const { app } = makeApp();
		const provider = new StationProvider(app);
		provider.register();
		await provider.boot();
		const direct =
			await app.container.resolve<ResourceRegistry>(ResourceRegistry);
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
		const registry =
			await app.container.resolve<ResourceRegistry>(ResourceRegistry);
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
		const registry =
			await app.container.resolve<ResourceRegistry>(ResourceRegistry);
		registry.register(defineResource({ entity: User }));

		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			await expect(provider.start()).resolves.toBeUndefined();
		} finally {
			warnSpy.mockRestore();
		}
	});
});

// 57.7 — the rune-derived writable schema replaces the hand-rolled
// filterWritableBody. These pin the coercion CRUX (Task 1 spike, formalised):
// rune does NOT coerce, so the derivation adds `.parse` for numbers/booleans,
// and the handler default-fills an absent checkbox to false. Uses the REAL
// @c9up/rune (tests may import it statically — the src-only static-import guard
// does not scan tests/).
describe("station > deriveWritableSchema + validateWritableBody (mass-assignment + coercion)", () => {
	const rune = { schema, rules };
	// id → PK (excluded); createdAt → timestamp (excluded); name → required
	// string; age → optional number; active → boolean checkbox.
	const columns: ColumnMetadata[] = [
		{ propertyKey: "id" },
		{ propertyKey: "name", type: "string" },
		{ propertyKey: "age", type: "integer", nullable: true },
		{ propertyKey: "active", type: "boolean" },
		{ propertyKey: "createdAt", type: "timestamp" },
	];
	const build = () =>
		deriveWritableSchema(columns, "id", new Set(), new Set(), rune);

	it("names the boolean columns (checkbox default-fill set)", () => {
		expect([...build().booleanKeys]).toEqual(["active"]);
	});

	it("clears a boolean to false when the checkbox is unchecked (absent)", () => {
		const { schema: s, booleanKeys } = build();
		const r = validateWritableBody(s, booleanKeys, { name: "x" });
		expect(r.valid).toBe(true);
		if (r.valid) {
			expect(r.data.name).toBe("x");
			expect(r.data.active).toBe(false);
			expect("age" in r.data).toBe(false);
		}
	});

	it("coerces a checked checkbox ('1') to a real boolean true", () => {
		const { schema: s, booleanKeys } = build();
		const r = validateWritableBody(s, booleanKeys, { name: "x", active: "1" });
		expect(r.valid).toBe(true);
		if (r.valid) expect(r.data.active).toBe(true);
	});

	it("coerces a numeric string '42' to the number 42", () => {
		const { schema: s, booleanKeys } = build();
		const r = validateWritableBody(s, booleanKeys, { name: "x", age: "42" });
		expect(r.valid).toBe(true);
		if (r.valid) expect(r.data.age).toBe(42);
	});

	it("rejects a non-numeric string for a number column (422 material)", () => {
		const { schema: s, booleanKeys } = build();
		const r = validateWritableBody(s, booleanKeys, { name: "x", age: "abc" });
		expect(r.valid).toBe(false);
		if (!r.valid) expect(r.errors.some((e) => e.field === "age")).toBe(true);
	});

	it("drops PK / timestamps / unknown keys (mass-assignment inherent)", () => {
		const { schema: s, booleanKeys } = build();
		const r = validateWritableBody(s, booleanKeys, {
			name: "x",
			id: 999,
			createdAt: "1970-01-01T00:00:00Z",
			role: "admin",
			passwordHash: "exfiltrate",
		});
		expect(r.valid).toBe(true);
		if (r.valid) {
			expect(r.data.name).toBe("x");
			expect("id" in r.data).toBe(false);
			expect("createdAt" in r.data).toBe(false);
			expect("role" in r.data).toBe(false);
			expect("passwordHash" in r.data).toBe(false);
		}
	});

	it("rejects when a required field is missing", () => {
		const { schema: s, booleanKeys } = build();
		const r = validateWritableBody(s, booleanKeys, { age: "1" });
		expect(r.valid).toBe(false);
		if (!r.valid) expect(r.errors.some((e) => e.field === "name")).toBe(true);
	});
});

// 57.7 code-review hardening — coercion edge cases the initial schema missed:
// blank/null numbers must not fabricate 0, bigint must not lose precision,
// json columns must accept objects, and a checkbox posted as an array (hidden
// "0" companion + checked "1") must read as true.
describe("station > deriveWritableSchema — review hardening (coercion edges)", () => {
	const rune = { schema, rules };
	const columns: ColumnMetadata[] = [
		{ propertyKey: "id" },
		{ propertyKey: "name", type: "string" },
		{ propertyKey: "age", type: "integer", nullable: true },
		{ propertyKey: "active", type: "boolean" },
		{ propertyKey: "big", type: "bigint", nullable: true },
		{ propertyKey: "meta", type: "json", nullable: true },
	];
	const build = () =>
		deriveWritableSchema(columns, "id", new Set(), new Set(), rune);

	it("a blank number field becomes null, never a fabricated 0 (P2)", () => {
		const { schema: s, booleanKeys } = build();
		const r = validateWritableBody(s, booleanKeys, { name: "x", age: "" });
		expect(r.valid).toBe(true);
		if (r.valid) expect(r.data.age ?? null).toBe(null);
	});

	it("an explicit null number stays null, never coerced to 0 (P2)", () => {
		const { schema: s, booleanKeys } = build();
		const r = validateWritableBody(s, booleanKeys, { name: "x", age: null });
		expect(r.valid).toBe(true);
		if (r.valid) expect(r.data.age).toBe(null);
	});

	it("a bigint column preserves its exact digits (no Number() precision loss) (P3)", () => {
		const { schema: s, booleanKeys } = build();
		const big = "9007199254740993"; // MAX_SAFE_INTEGER + 2
		const r = validateWritableBody(s, booleanKeys, { name: "x", big });
		expect(r.valid).toBe(true);
		if (r.valid) expect(r.data.big).toBe(big);
	});

	it("a json column accepts a structured object, not just a string (P5)", () => {
		const { schema: s, booleanKeys } = build();
		const meta = { role: "editor", tags: [1, 2] };
		const r = validateWritableBody(s, booleanKeys, { name: "x", meta });
		expect(r.valid).toBe(true);
		if (r.valid) expect(r.data.meta).toEqual(meta);
	});

	it("a checkbox posted as an array (hidden 0 + checked 1) reads as true (P6)", () => {
		const { schema: s, booleanKeys } = build();
		const r = validateWritableBody(s, booleanKeys, {
			name: "x",
			active: ["0", "1"],
		});
		expect(r.valid).toBe(true);
		if (r.valid) expect(r.data.active).toBe(true);
	});
});
