import { describe, expect, it } from "vitest";

import { defineResource } from "../../src/defineResource.js";
import { ResourceRegistry } from "../../src/ResourceRegistry.js";

describe("ResourceRegistry", () => {
	it("registers + reads back resources by slug", () => {
		class User {}
		const registry = new ResourceRegistry();
		const userResource = defineResource({ entity: User });
		registry.register(userResource);
		expect(registry.get("users")).toBe(userResource);
		expect(registry.has("users")).toBe(true);
		expect(registry.count()).toBe(1);
	});

	it("returns undefined on `get` miss", () => {
		const registry = new ResourceRegistry();
		expect(registry.get("ghosts")).toBeUndefined();
		expect(registry.has("ghosts")).toBe(false);
	});

	it("getOrThrow returns the resource when present", () => {
		class User {}
		const registry = new ResourceRegistry();
		const userResource = defineResource({ entity: User });
		registry.register(userResource);
		expect(registry.getOrThrow("users")).toBe(userResource);
	});

	it("getOrThrow includes the requested name in the miss message", () => {
		const registry = new ResourceRegistry();
		expect(() => registry.getOrThrow("ghosts")).toThrow(
			/no resource named 'ghosts'/,
		);
	});

	it("rejects duplicate registration with the previous entity's class name in the message", () => {
		class User {}
		class Account {}
		const registry = new ResourceRegistry();
		registry.register(defineResource({ entity: User }));
		const conflicting = defineResource({ entity: Account, name: "users" });
		expect(() => registry.register(conflicting)).toThrow(
			/duplicate resource name 'users'.+already registered for User/,
		);
	});

	it("`all()` returns a frozen snapshot in insertion order", () => {
		class User {}
		class BlogPost {}
		class Comment {}
		const registry = new ResourceRegistry();
		const user = defineResource({ entity: User });
		const post = defineResource({ entity: BlogPost });
		const comment = defineResource({ entity: Comment });
		registry.register(user);
		registry.register(post);
		registry.register(comment);

		const all = registry.all();
		expect(all).toEqual([user, post, comment]);
		expect(Object.isFrozen(all)).toBe(true);
	});

	it("`all()` reflects mutations between calls (snapshot semantics, not live view)", () => {
		class User {}
		class BlogPost {}
		const registry = new ResourceRegistry();
		registry.register(defineResource({ entity: User }));
		const first = registry.all();
		registry.register(defineResource({ entity: BlogPost }));
		const second = registry.all();
		expect(first).toHaveLength(1);
		expect(second).toHaveLength(2);
	});
});
