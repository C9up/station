import type { ColumnMetadata } from "@c9up/atlas";
import { describe, expect, it } from "vitest";
import { defineResource } from "../../src/defineResource.js";
import { renderFormPage } from "../../src/views/form.js";

const userResource = defineResource({ entity: class User {} });

function cols(
	...specs: Array<{ propertyKey: string; type?: string }>
): ColumnMetadata[] {
	return specs.map((s) => ({ propertyKey: s.propertyKey, type: s.type }));
}

describe("station > views > renderFormPage (create)", () => {
	it("renders a POST form pointing at /admin/<slug> and omits PUT override", () => {
		const html = renderFormPage({
			resource: userResource,
			columns: cols({ propertyKey: "id" }, { propertyKey: "name" }),
			pkColumn: "id",
		});
		expect(html).toContain('method="POST"');
		expect(html).toContain('action="/admin/users"');
		expect(html).not.toContain('value="PUT"');
		expect(html).toContain('name="name"');
		// Primary key is hidden from the form body.
		expect(html).not.toMatch(/<input[^>]+name="id"/);
	});

	it("infers <input type> from column metadata (Story 54.5)", () => {
		const html = renderFormPage({
			resource: userResource,
			columns: cols(
				{ propertyKey: "name", type: "string" },
				{ propertyKey: "age", type: "integer" },
				{ propertyKey: "isAdmin", type: "boolean" },
				{ propertyKey: "bio", type: "text" },
				{ propertyKey: "publishedAt", type: "datetime" },
				{ propertyKey: "email" },
			),
			pkColumn: "id",
		});
		expect(html).toMatch(/<input[^>]+type="text"[^>]+name="name"/);
		expect(html).toMatch(/<input[^>]+type="number"[^>]+name="age"/);
		expect(html).toMatch(/<input[^>]+type="checkbox"[^>]+name="isAdmin"/);
		expect(html).toMatch(/<textarea[^>]+name="bio"/);
		expect(html).toMatch(
			/<input[^>]+type="datetime-local"[^>]+name="publishedAt"/,
		);
		// Property name heuristic: `email` → type="email"
		expect(html).toMatch(/<input[^>]+type="email"[^>]+name="email"/);
	});

	it("skips created_at / updated_at / deleted_at by convention", () => {
		const html = renderFormPage({
			resource: userResource,
			columns: cols(
				{ propertyKey: "name" },
				{ propertyKey: "createdAt", type: "datetime" },
				{ propertyKey: "updatedAt", type: "datetime" },
				{ propertyKey: "deletedAt", type: "datetime" },
			),
			pkColumn: "id",
		});
		expect(html).toContain('name="name"');
		expect(html).not.toMatch(/name="createdAt"/);
		expect(html).not.toMatch(/name="updatedAt"/);
		expect(html).not.toMatch(/name="deletedAt"/);
	});

	it("honours per-field overrides (formFields)", () => {
		const resource = defineResource({
			entity: class User {},
			formFields: {
				bio: {
					inputType: "textarea",
					label: "Biography",
					placeholder: "Tell us…",
				},
				ssn: { hidden: true },
			},
		});
		const html = renderFormPage({
			resource,
			columns: cols(
				{ propertyKey: "name" },
				{ propertyKey: "bio" },
				{ propertyKey: "ssn" },
			),
			pkColumn: "id",
		});
		expect(html).toContain("Biography");
		expect(html).toContain('placeholder="Tell us…"');
		expect(html).toMatch(/<textarea[^>]+name="bio"/);
		expect(html).not.toMatch(/name="ssn"/);
	});
});

describe("station > views > renderFormPage (edit)", () => {
	it("renders a POST form with _method=PUT and pre-fills values from the row", () => {
		const html = renderFormPage({
			resource: userResource,
			columns: cols({ propertyKey: "name" }, { propertyKey: "age" }),
			pkColumn: "id",
			row: { id: 7, name: "Alice", age: 30 },
		});
		expect(html).toContain('action="/admin/users/7"');
		expect(html).toContain('<input type="hidden" name="_method" value="PUT">');
		expect(html).toContain('value="Alice"');
		expect(html).toContain('value="30"');
	});

	it("XSS regression: escapes attribute-injection attempts in row values", () => {
		const html = renderFormPage({
			resource: userResource,
			columns: cols({ propertyKey: "name" }),
			pkColumn: "id",
			row: { id: 1, name: '"><script>alert(1)</script>' },
		});
		expect(html).not.toContain("<script>");
		expect(html).toContain("&quot;");
	});
});
