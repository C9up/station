import type { ColumnMetadata } from "@c9up/atlas";
import { describe, expect, it } from "vitest";
import { defineResource } from "../../src/defineResource.js";
import { buildShowViewModel } from "../../src/views/show.js";

const userResource = defineResource({ entity: class User {} });

function cols(...keys: string[]): ColumnMetadata[] {
	return keys.map((propertyKey) => ({ propertyKey }));
}

describe("station > views > buildShowViewModel", () => {
	it("flattens columns × row into pre-stringified <dt>/<dd> fields", () => {
		const vm = buildShowViewModel({
			resource: userResource,
			row: { id: 7, name: "Alice", age: 30 },
			pkColumn: "id",
			columns: cols("id", "name", "age"),
		});
		expect(vm.fields).toEqual([
			{ label: "id", value: "7" },
			{ label: "name", value: "Alice" },
			{ label: "age", value: "30" },
		]);
	});

	it("maps null/undefined field values to the empty string", () => {
		const vm = buildShowViewModel({
			resource: userResource,
			row: { id: 1, bio: null },
			pkColumn: "id",
			columns: cols("id", "bio"),
		});
		expect(vm.fields).toEqual([
			{ label: "id", value: "1" },
			{ label: "bio", value: "" },
		]);
	});

	it("composes the heading as '{label} #{id}' and an encoded back-link", () => {
		const vm = buildShowViewModel({
			resource: userResource,
			row: { id: 7 },
			pkColumn: "id",
			columns: cols("id"),
		});
		expect(vm.heading).toBe("Users #7");
		expect(vm.title).toBe("Users #7");
		expect(vm.backHref).toBe("/admin/users");
		expect(vm.backLabel).toBe("Users");
	});
});
