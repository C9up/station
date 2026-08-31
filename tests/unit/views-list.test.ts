import type { ColumnMetadata } from "@c9up/atlas";
import { describe, expect, it } from "vitest";
import { defineResource } from "../../src/defineResource.js";
import { buildListViewModel } from "../../src/views/list.js";

const userResource = defineResource({ entity: class User {} });

function cols(...keys: string[]): ColumnMetadata[] {
	return keys.map((propertyKey) => ({ propertyKey }));
}

describe("station > views > buildListViewModel", () => {
	it("maps columns and marks non-empty result sets", () => {
		const vm = buildListViewModel({
			resource: userResource,
			rows: [{ id: 1, name: "Alice" }],
			columns: cols("id", "name"),
			page: 1,
			perPage: 25,
			total: 1,
			pkColumn: "id",
			lastPage: 1,
		});
		expect(vm.columns).toEqual(["id", "name"]);
		expect(vm.empty).toBe(false);
		expect(vm.heading).toBe("Users");
		expect(vm.labelLower).toBe("users");
	});

	it("flags the empty state and lowercases the label", () => {
		const vm = buildListViewModel({
			resource: userResource,
			rows: [],
			columns: cols("id", "name"),
			page: 1,
			perPage: 25,
			total: 0,
			pkColumn: "id",
			lastPage: 1,
		});
		expect(vm.empty).toBe(true);
		expect(vm.labelLower).toBe("users");
		expect(vm.rows).toEqual([]);
	});

	it("pre-stringifies cells, mapping null/undefined to the empty string", () => {
		const vm = buildListViewModel({
			resource: userResource,
			rows: [{ id: 1, name: null, extra: undefined }],
			columns: cols("id", "name", "extra"),
			page: 1,
			perPage: 25,
			total: 1,
			pkColumn: "id",
			lastPage: 1,
		});
		expect(vm.rows[0]?.cells).toEqual(["1", "", ""]);
	});

	it("URL-encodes the row id in the precomputed Show href", () => {
		const vm = buildListViewModel({
			resource: userResource,
			rows: [{ id: "a/b c" }],
			columns: cols("id"),
			page: 1,
			perPage: 25,
			total: 1,
			pkColumn: "id",
			lastPage: 1,
		});
		expect(vm.rows[0]?.showHref).toBe("/admin/users/a%2Fb%20c");
	});

	it("pager: disables prev + next on a single-page result", () => {
		const vm = buildListViewModel({
			resource: userResource,
			rows: [{ id: 1 }],
			columns: cols("id"),
			page: 1,
			perPage: 25,
			total: 1,
			pkColumn: "id",
			lastPage: 1,
		});
		expect(vm.pager.prev.disabled).toBe(true);
		expect(vm.pager.next.disabled).toBe(true);
		expect(vm.pager.pages).toEqual([
			{
				n: 1,
				href: "/admin/users?page=1&perPage=25",
				isCurrent: true,
				isEllipsis: false,
			},
		]);
	});

	it("pager: prev/next become links in the middle of the range", () => {
		const vm = buildListViewModel({
			resource: userResource,
			rows: [{ id: 1 }],
			columns: cols("id"),
			page: 2,
			perPage: 25,
			total: 125,
			pkColumn: "id",
			lastPage: 5,
		});
		expect(vm.pager.prev).toEqual({
			href: "/admin/users?page=1&perPage=25",
			disabled: false,
		});
		expect(vm.pager.next).toEqual({
			href: "/admin/users?page=3&perPage=25",
			disabled: false,
		});
		expect(vm.pager.pages.find((p) => p.isCurrent)?.n).toBe(2);
	});

	it("pager: collapses with exactly two ellipses when lastPage > 7 (page=5 / lastPage=20 → 1 … 4 5 6 … 20)", () => {
		const vm = buildListViewModel({
			resource: userResource,
			rows: [{ id: 1 }],
			columns: cols("id"),
			page: 5,
			perPage: 25,
			total: 500,
			pkColumn: "id",
			lastPage: 20,
		});
		const ellipses = vm.pager.pages.filter((p) => p.isEllipsis);
		expect(ellipses).toHaveLength(2);
		const numbers = vm.pager.pages.filter((p) => !p.isEllipsis).map((p) => p.n);
		expect(numbers).toEqual([1, 4, 5, 6, 20]);
		expect(numbers).not.toContain(7);
		expect(vm.pager.pages.find((p) => p.isCurrent)?.n).toBe(5);
	});

	it("caption: reflects the page window and hides on an empty set", () => {
		const shown = buildListViewModel({
			resource: userResource,
			rows: Array.from({ length: 25 }, (_, i) => ({ id: 25 + i + 1 })),
			columns: cols("id"),
			page: 2,
			perPage: 25,
			total: 53,
			pkColumn: "id",
			lastPage: 3,
		});
		expect(shown.caption).toEqual({
			show: true,
			start: 26,
			end: 50,
			total: 53,
		});

		const hidden = buildListViewModel({
			resource: userResource,
			rows: [],
			columns: cols("id"),
			page: 1,
			perPage: 25,
			total: 0,
			pkColumn: "id",
			lastPage: 1,
		});
		expect(hidden.caption.show).toBe(false);
	});
});
