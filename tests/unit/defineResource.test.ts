import { describe, expect, it } from "vitest";

import { defineResource } from "../../src/defineResource.js";
import {
	RESOURCE_ACTIONS,
	type ResourceAction,
	type ResourceOptions,
} from "../../src/types.js";
import { bypassTypeCheck } from "../__helpers__/bypass-type-check.js";

describe("defineResource", () => {
	it("derives defaults from a single-word entity name", () => {
		class User {}
		const resource = defineResource({ entity: User });
		expect(resource.name).toBe("users");
		expect(resource.label).toBe("Users");
		expect(resource.actions).toEqual([
			"list",
			"show",
			"create",
			"edit",
			"destroy",
		]);
		expect(resource.entity).toBe(User);
	});

	it("derives kebab-plural defaults from PascalCase entity names", () => {
		class BlogPost {}
		const resource = defineResource({ entity: BlogPost });
		expect(resource.name).toBe("blog-posts");
		expect(resource.label).toBe("Blog Posts");
	});

	it("uses the irregular plural table", () => {
		class Person {}
		const resource = defineResource({ entity: Person });
		expect(resource.name).toBe("people");
		expect(resource.label).toBe("People");
	});

	it("accepts a custom kebab-case name override", () => {
		class User {}
		const resource = defineResource({ entity: User, name: "team-members" });
		expect(resource.name).toBe("team-members");
	});

	it("rejects a non-kebab-case name override", () => {
		class User {}
		expect(() => defineResource({ entity: User, name: "My-Users" })).toThrow(
			/name.+must be lowercase kebab-case.+'My-Users'/,
		);
	});

	it("rejects an empty name override", () => {
		class User {}
		expect(() => defineResource({ entity: User, name: "" })).toThrow(
			/name.+must be lowercase kebab-case.+''/,
		);
	});

	it("accepts a subset of actions", () => {
		class User {}
		const resource = defineResource({
			entity: User,
			actions: ["list", "show"],
		});
		expect(resource.actions).toEqual(["list", "show"]);
		expect(resource.actions).not.toContain("create");
		expect(resource.actions).not.toContain("edit");
		expect(resource.actions).not.toContain("destroy");
	});

	it("returns actions in canonical order regardless of declaration order", () => {
		class User {}
		const resource = defineResource({
			entity: User,
			actions: ["destroy", "list"],
		});
		expect(resource.actions).toEqual(["list", "destroy"]);
	});

	it("rejects an empty actions array", () => {
		class User {}
		expect(() => defineResource({ entity: User, actions: [] })).toThrow(
			/actions.+must contain at least one action/,
		);
	});

	it("rejects an unknown action with the typo'd token in the message", () => {
		class User {}
		const badActions = bypassTypeCheck<ReadonlyArray<ResourceAction>>(["ist"]);
		expect(() => defineResource({ entity: User, actions: badActions })).toThrow(
			/unknown action 'ist'/,
		);
	});

	it("rejects a non-class entity with TypeError", () => {
		const badOptions = bypassTypeCheck<ResourceOptions<unknown>>({
			entity: "User",
		});
		expect(() => defineResource(badOptions)).toThrow(TypeError);
	});

	it("returns a frozen object with a frozen actions array", () => {
		class User {}
		const resource = defineResource({ entity: User });
		expect(Object.isFrozen(resource)).toBe(true);
		expect(Object.isFrozen(resource.actions)).toBe(true);
	});

	it("rejects an anonymous class (empty entity name)", () => {
		const Anon = (() => class {})();
		expect(() => defineResource({ entity: Anon })).toThrow(
			/'entity' class has no name \(anonymous class\); pass 'name:' explicitly/,
		);
	});

	it("rejects derived slugs that violate NAME_PATTERN ($Foo, _Bar, Café)", () => {
		class $Foo {}
		class _Bar {}
		const Cafe = class Café {};
		expect(() => defineResource({ entity: $Foo })).toThrow(
			/produces invalid slug '\$foos'.+pass 'name:' explicitly/,
		);
		expect(() => defineResource({ entity: _Bar })).toThrow(
			/produces invalid slug '_bars'.+pass 'name:' explicitly/,
		);
		expect(() => defineResource({ entity: Cafe })).toThrow(
			/produces invalid slug 'cafés'.+pass 'name:' explicitly/,
		);
	});

	it("rejects derived slugs from bound functions (space in name)", () => {
		class User {}
		const Bound = User.bind(null);
		expect(() => defineResource({ entity: Bound })).toThrow(
			/produces invalid slug.+pass 'name:' explicitly/,
		);
	});

	it("accepts an explicit 'name:' override that bypasses the derived-slug guard", () => {
		class $Foo {}
		const resource = defineResource({ entity: $Foo, name: "foos" });
		expect(resource.name).toBe("foos");
	});

	it("RESOURCE_ACTIONS is frozen at runtime (type/runtime parity)", () => {
		expect(Object.isFrozen(RESOURCE_ACTIONS)).toBe(true);
	});

	it("no longer accepts or exposes a 'policies' table (54.4 callback API removed in 56.5)", () => {
		class User {}
		// The 54.4 `defineResource({ policies })` callback table is removed
		// (AC4 / D3). The type no longer permits `policies`; a stray key is
		// structurally dropped and the returned Resource carries no
		// `policies` property — authorization lives in Warden now.
		const resource = defineResource(
			bypassTypeCheck<ResourceOptions<unknown>>({
				entity: User,
				policies: { create: () => false },
			}),
		);
		expect("policies" in resource).toBe(false);
	});

	it("rejects name overrides with trailing or adjacent hyphens", () => {
		class User {}
		expect(() => defineResource({ entity: User, name: "users-" })).toThrow(
			/must be lowercase kebab-case.+'users-'/,
		);
		expect(() => defineResource({ entity: User, name: "a--b" })).toThrow(
			/must be lowercase kebab-case.+'a--b'/,
		);
	});
});
