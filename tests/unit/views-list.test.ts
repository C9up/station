import type { ColumnMetadata } from "@c9up/atlas";
import { describe, expect, it } from "vitest";
import { defineResource } from "../../src/defineResource.js";
import { renderListPage } from "../../src/views/list.js";

const userResource = defineResource({ entity: class User {} });

function cols(...keys: string[]): ColumnMetadata[] {
	return keys.map((propertyKey) => ({ propertyKey }));
}

describe("station > views > renderListPage", () => {
	it("emits one <th> per column plus a trailing Show column header", () => {
		const html = renderListPage({
			resource: userResource,
			rows: [{ id: 1, name: "Alice" }],
			columns: cols("id", "name"),
			page: 1,
			perPage: 25,
			total: 1,
			pkColumn: "id",
			lastPage: 1,
		});
		// Two declared columns → two named <th> + one empty trailing header.
		const thMatches = html.match(/<th>[^<]*<\/th>/g) ?? [];
		expect(thMatches).toHaveLength(3);
		expect(html).toContain("<th>id</th>");
		expect(html).toContain("<th>name</th>");
	});

	it("renders the empty-state paragraph when rows array is empty (no table)", () => {
		const html = renderListPage({
			resource: userResource,
			rows: [],
			columns: cols("id", "name"),
			page: 1,
			perPage: 25,
			total: 0,
			pkColumn: "id",
			lastPage: 1,
		});
		expect(html).toContain('<p class="st-empty">No users yet.</p>');
		expect(html).not.toContain("<table>");
	});

	it("pager: disables prev + next when lastPage = 1 (single-page result)", () => {
		const html = renderListPage({
			resource: userResource,
			rows: [{ id: 1 }],
			columns: cols("id"),
			page: 1,
			perPage: 25,
			total: 1,
			pkColumn: "id",
			lastPage: 1,
		});
		expect(html).toContain('<span class="st-disabled">« Prev</span>');
		expect(html).toContain('<span class="st-disabled">Next »</span>');
	});

	it("pager: renders prev + next as links when page is in the middle", () => {
		const html = renderListPage({
			resource: userResource,
			rows: [{ id: 1 }],
			columns: cols("id"),
			page: 2,
			perPage: 25,
			total: 125,
			pkColumn: "id",
			lastPage: 5,
		});
		expect(html).toContain('href="/admin/users?page=1&perPage=25">« Prev</a>');
		expect(html).toContain('href="/admin/users?page=3&perPage=25">Next »</a>');
		expect(html).toContain("<strong>2</strong>");
	});

	it("pager: collapses with ellipsis when lastPage > 7 (e.g. page=5 / lastPage=20 → 1 … 4 5 6 … 20)", () => {
		const html = renderListPage({
			resource: userResource,
			rows: [{ id: 1 }],
			columns: cols("id"),
			page: 5,
			perPage: 25,
			total: 500,
			pkColumn: "id",
			lastPage: 20,
		});
		// Numbers shown: 1, 4, 5, 6, 20. Two ellipses (count <span> tags,
		// not the class name — the inline CSS rule for `.st-ellipsis` would
		// otherwise inflate a `st-ellipsis` substring match by one).
		expect(html).toContain("…");
		const ellipsisCount = (html.match(/<span class="st-ellipsis">/g) ?? [])
			.length;
		expect(ellipsisCount).toBe(2);
		expect(html).toMatch(/>1<\/a>/);
		expect(html).toMatch(/>4<\/a>/);
		expect(html).toContain("<strong>5</strong>");
		expect(html).toMatch(/>6<\/a>/);
		expect(html).toMatch(/>20<\/a>/);
		// 7 must NOT appear as a numbered link (collapsed).
		expect(html).not.toMatch(/>7<\/a>/);
	});

	it("XSS regression: escapes script tags in cell values", () => {
		const html = renderListPage({
			resource: userResource,
			rows: [{ id: 1, name: "<script>alert(1)</script>" }],
			columns: cols("id", "name"),
			page: 1,
			perPage: 25,
			total: 1,
			pkColumn: "id",
			lastPage: 1,
		});
		expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
		expect(html).not.toContain("<script>alert(1)</script>");
	});

	it("URL-encodes the row id in the Show link (path-traversal / route-confusion safety)", () => {
		const html = renderListPage({
			resource: userResource,
			rows: [{ id: "a/b c" }],
			columns: cols("id"),
			page: 1,
			perPage: 25,
			total: 1,
			pkColumn: "id",
			lastPage: 1,
		});
		expect(html).toContain('href="/admin/users/a%2Fb%20c"');
	});

	it("caption: 'Showing N–M of total' reflects the page window", () => {
		const html = renderListPage({
			resource: userResource,
			rows: Array.from({ length: 25 }, (_, i) => ({ id: 25 + i + 1 })),
			columns: cols("id"),
			page: 2,
			perPage: 25,
			total: 53,
			pkColumn: "id",
			lastPage: 3,
		});
		expect(html).toContain("Showing 26–50 of 53");
	});
});
