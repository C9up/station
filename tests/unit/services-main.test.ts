import { beforeEach, describe, expect, it, vi } from "vitest";

import { defineResource } from "../../src/defineResource.js";
import { ResourceRegistry } from "../../src/ResourceRegistry.js";

type ServicesMain = typeof import("../../src/services/main.js");

async function loadFresh(): Promise<ServicesMain> {
	vi.resetModules();
	return import("../../src/services/main.js");
}

describe("services/main singleton", () => {
	beforeEach(() => {
		vi.resetModules();
	});

	it("throws on pre-bind access with the load-bearing substring", async () => {
		const mod = await loadFresh();
		expect(() => mod.default.count()).toThrow(
			/accessed before StationProvider\.boot\(\)/,
		);
	});

	it("returns undefined from `_getStation` before binding", async () => {
		const mod = await loadFresh();
		expect(mod._getStation()).toBeUndefined();
	});

	it("forwards method calls to the bound registry after `_setStation`", async () => {
		class User {}
		const mod = await loadFresh();
		const registry = new ResourceRegistry();
		mod._setStation(registry);
		const userResource = defineResource({ entity: User });
		mod.default.register(userResource);
		expect(registry.get("users")).toBe(userResource);
		expect(mod._getStation()).toBe(registry);
	});

	it("returns property values (non-function) through the proxy after binding", async () => {
		const mod = await loadFresh();
		const registry = new ResourceRegistry();
		mod._setStation(registry);
		expect(mod.default.count()).toBe(0);
	});

	it("binds methods so detached destructuring still works", async () => {
		class User {}
		const mod = await loadFresh();
		const registry = new ResourceRegistry();
		mod._setStation(registry);

		const { register } = mod.default;
		const userResource = defineResource({ entity: User });
		expect(() => {
			register(userResource);
		}).not.toThrow();
		expect(registry.get("users")).toBe(userResource);
	});
});
