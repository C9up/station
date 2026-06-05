import type { ColumnMetadata } from "@c9up/atlas";
import { describe, expect, it } from "vitest";
import { defineResource } from "../../src/defineResource.js";
import { renderShowPage } from "../../src/views/show.js";

const userResource = defineResource({ entity: class User {} });

function cols(...keys: string[]): ColumnMetadata[] {
	return keys.map((propertyKey) => ({ propertyKey }));
}

describe("station > views > renderShowPage", () => {
	it("renders one <dt>/<dd> per column from the row data", () => {
		const html = renderShowPage({
			resource: userResource,
			row: { id: 7, name: "Alice", age: 30 },
			pkColumn: "id",
			columns: cols("id", "name", "age"),
		});
		expect(html).toContain("<dt>id</dt><dd>7</dd>");
		expect(html).toContain("<dt>name</dt><dd>Alice</dd>");
		expect(html).toContain("<dt>age</dt><dd>30</dd>");
	});

	it("XSS regression: escapes attribute-injection attempts inside cell values", () => {
		const html = renderShowPage({
			resource: userResource,
			row: { id: 1, bio: '<img src=x onerror="alert(1)">' },
			pkColumn: "id",
			columns: cols("id", "bio"),
		});
		expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
		expect(html).not.toContain('<img src=x onerror="alert(1)">');
	});

	it("back-link URL-encodes the resource slug (single canonical href)", () => {
		const html = renderShowPage({
			resource: userResource,
			row: { id: 1 },
			pkColumn: "id",
			columns: cols("id"),
		});
		expect(html).toContain('href="/admin/users"');
		expect(html).toContain("← Back to Users");
	});
});
