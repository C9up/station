/**
 * Story 57.2 — the list + show views rendered through the inker seam.
 *
 * The retired hand-rolled `renderListPage` / `renderShowPage` are gone; the
 * handlers now build a pure view-model and hand it to `station::list` /
 * `station::show`. These tests drive the REAL `@c9up/inker` engine (the same
 * `makeInkerRenderer()` stand-in the roundtrip test binds) against the built
 * view-models, proving:
 *   - the external HTML contract the integration test asserts (table/pager/
 *     caption structure, contiguous `<dt>/<dd>`) is preserved;
 *   - inker's `{{ }}` auto-escaping replaces the retired `escapeHtml` on the
 *     security path (hostile cell + attribute-injection values, AC5);
 *   - the pager `&` is HTML-escaped to `&amp;` by inker (AC3).
 */
import { fileURLToPath } from "node:url";
import type { ColumnMetadata } from "@c9up/atlas";
import { describe, expect, it } from "vitest";
import { defineResource } from "../../src/defineResource.js";
import { buildListViewModel } from "../../src/views/list.js";
import { buildShowViewModel } from "../../src/views/show.js";
import { makeInkerRenderer } from "../__helpers__/inker-renderer.js";

const TEMPLATES_ROOT = fileURLToPath(
	new URL("../../templates/", import.meta.url),
);
const userResource = defineResource({ entity: class User {} });

function cols(...keys: string[]): ColumnMetadata[] {
	return keys.map((propertyKey) => ({ propertyKey }));
}

function renderer() {
	const r = makeInkerRenderer();
	r.mount("station", TEMPLATES_ROOT);
	return r;
}

describe("station > integration > 57.2 inker-rendered list/show", () => {
	it("list: composes the layout shell + table/pager/caption contract", async () => {
		const vm = buildListViewModel({
			resource: userResource,
			rows: [{ id: 1, name: "Alice" }],
			columns: cols("id", "name"),
			pkColumn: "id",
			page: 1,
			perPage: 25,
			total: 50,
			lastPage: 2,
		});
		const html = await renderer().renderToString({}, "station::list", vm);

		expect(html).toContain("<!doctype html>");
		expect(html).toContain("<title>Users · Station</title>");
		expect(html).toContain("<h1>Users</h1>");
		expect(html).toContain("<table>");
		expect(html).toContain("<th>id</th>");
		expect(html).toContain("<th>name</th>");
		// Trailing empty Show-column header.
		expect(html).toContain("<th></th></tr></thead>");
		expect(html).toContain('<td><a href="/admin/users/1">Show</a></td>');
		expect(html).toContain("Showing 1–25 of 50");
		// AC3 — inker escapes the pager `&` to `&amp;`.
		expect(html).toContain('href="/admin/users?page=2&amp;perPage=25"');
	});

	it("list: renders the empty state without a table", async () => {
		const vm = buildListViewModel({
			resource: userResource,
			rows: [],
			columns: cols("id", "name"),
			pkColumn: "id",
			page: 1,
			perPage: 25,
			total: 0,
			lastPage: 1,
		});
		const html = await renderer().renderToString({}, "station::list", vm);
		expect(html).toContain('<p class="st-empty">No users yet.</p>');
		expect(html).not.toContain("<table>");
	});

	it("list: renders the collapsed pager with ellipses for many pages", async () => {
		const vm = buildListViewModel({
			resource: userResource,
			rows: [{ id: 1, name: "Alice" }],
			columns: cols("id", "name"),
			pkColumn: "id",
			page: 5,
			perPage: 25,
			total: 500,
			lastPage: 20,
		});
		const html = await renderer().renderToString({}, "station::list", vm);

		// Collapsed shape: 1 … 4 [5] 6 … 20 — two ellipsis gaps, current as <strong>.
		const ellipses = html.match(/<span class="st-ellipsis">…<\/span>/g) ?? [];
		expect(ellipses).toHaveLength(2);
		expect(html).toContain("<strong>5</strong>");
		expect(html).toContain(
			'<a href="/admin/users?page=1&amp;perPage=25">1</a>',
		);
		expect(html).toContain(
			'<a href="/admin/users?page=4&amp;perPage=25">4</a>',
		);
		expect(html).toContain(
			'<a href="/admin/users?page=6&amp;perPage=25">6</a>',
		);
		expect(html).toContain(
			'<a href="/admin/users?page=20&amp;perPage=25">20</a>',
		);
		// The current page is emitted as <strong>, never also as a link.
		expect(html).not.toContain(
			'<a href="/admin/users?page=5&amp;perPage=25">5</a>',
		);
	});

	it("list: inker `{{ }}` escapes a hostile cell value (AC5)", async () => {
		const vm = buildListViewModel({
			resource: userResource,
			rows: [{ id: 1, name: "<script>alert(1)</script>" }],
			columns: cols("id", "name"),
			pkColumn: "id",
			page: 1,
			perPage: 25,
			total: 1,
			lastPage: 1,
		});
		const html = await renderer().renderToString({}, "station::list", vm);
		expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
		expect(html).not.toContain("<script>alert(1)</script>");
	});

	it("show: renders contiguous <dt>/<dd> pairs + encoded back-link", async () => {
		const vm = buildShowViewModel({
			resource: userResource,
			row: { id: 7, name: "Alice", age: 30 },
			pkColumn: "id",
			columns: cols("id", "name", "age"),
		});
		const html = await renderer().renderToString({}, "station::show", vm);
		expect(html).toContain("<h1>Users #7</h1>");
		expect(html).toContain("<dt>id</dt><dd>7</dd>");
		expect(html).toContain("<dt>name</dt><dd>Alice</dd>");
		expect(html).toContain("<dt>age</dt><dd>30</dd>");
		expect(html).toContain(
			'<a class="st-backlink" href="/admin/users">← Back to Users</a>',
		);
	});

	it("show: inker `{{ }}` escapes an attribute-injection value (AC5)", async () => {
		const vm = buildShowViewModel({
			resource: userResource,
			row: { id: 1, bio: '<img src=x onerror="alert(1)">' },
			pkColumn: "id",
			columns: cols("id", "bio"),
		});
		const html = await renderer().renderToString({}, "station::show", vm);
		expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
		expect(html).not.toContain('<img src=x onerror="alert(1)">');
	});
});
