/**
 * An admin panel with no authorisation is full CRUD on every registered
 * resource for anyone who can reach the route. Mounting one is a decision, and
 * in production it has to be written down rather than fallen into — the same
 * bet bay makes about losing a job on a Redis without LMOVE.
 */
import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

const original = process.env.NODE_ENV;

afterEach(() => {
	process.env.NODE_ENV = original;
	vi.restoreAllMocks();
});

/** A host with a view engine, a db and a router — but no `auth` binding. */
function appWithoutWarden(stationConfig: StationConfig): StationAppContext {
	const bindings = new Map<unknown, () => unknown>();
	const cache = new Map<unknown, unknown>();
	bindings.set("db", () => ({
		execute: async () => ({ rowsAffected: 0 }),
		query: async () => [],
	}));
	bindings.set("inker", () => makeInkerRenderer());
	bindings.set("router", () => ({
		get: () => ({}),
		post: () => ({}),
		put: () => ({}),
		delete: () => ({}),
	}));
	return {
		container: {
			singleton(token: unknown, factory: () => unknown) {
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
		config: { get: <T>() => bypassTypeCheck<T>(stationConfig) },
	};
}

async function mount(stationConfig: StationConfig): Promise<void> {
	const app = appWithoutWarden(stationConfig);
	const provider = new StationProvider(app);
	provider.register();
	await provider.boot();
	const registry =
		await app.container.resolve<ResourceRegistry>(ResourceRegistry);
	registry.register(defineResource({ entity: User }));
	await provider.start();
}

describe("station > an admin with no auth binding", () => {
	let warn: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		// The warning is emitted once per process; each test needs its own turn.
		resetStationProviderFlags();
		warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	});

	it("refuses to mount in production", async () => {
		process.env.NODE_ENV = "production";

		await expect(mount({})).rejects.toThrow(/NO authorisation in production/);
	});

	it("refuses under the spellings people actually set", async () => {
		// `NODE_ENV=prod` is ordinary in a Dockerfile; read verbatim it answers
		// "not production", which would take the guard off.
		process.env.NODE_ENV = "prod";

		await expect(mount({})).rejects.toThrow(/NO authorisation in production/);
	});

	it("mounts in production when the deployment asked for it", async () => {
		process.env.NODE_ENV = "production";

		// `requireAuth: false` written down IS the asking.
		await expect(mount({ requireAuth: false })).resolves.toBeUndefined();
	});

	it("names production in the warning when it was asked for", async () => {
		process.env.NODE_ENV = "production";

		await mount({ requireAuth: false });

		// Agreeing once in a config file is not the same as being reminded, in
		// the logs of an incident, that this is how the process was running.
		const said = warn.mock.calls.flat().join(" ");
		expect(said).toContain("PRODUCTION");
		expect(said).toContain("requireAuth: false");
	});

	it("still mounts and warns outside production", async () => {
		process.env.NODE_ENV = "development";

		await expect(mount({})).resolves.toBeUndefined();
		expect(warn.mock.calls.flat().join(" ")).toContain("mounted without auth");
	});
});
