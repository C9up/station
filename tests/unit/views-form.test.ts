import type { ColumnMetadata } from "@c9up/atlas";
import { describe, expect, it } from "vitest";
import { defineResource } from "../../src/defineResource.js";
import { buildFormViewModel, type FormField } from "../../src/views/form.js";

const userResource = defineResource({ entity: class User {} });

function cols(
	...specs: Array<{ propertyKey: string; type?: string }>
): ColumnMetadata[] {
	return specs.map((s) => ({ propertyKey: s.propertyKey, type: s.type }));
}

function field(fields: FormField[], name: string): FormField | undefined {
	return fields.find((f) => f.name === name);
}

describe("station > views > buildFormViewModel (create)", () => {
	it("targets /admin/<slug>, is not an edit, and skips the primary key", () => {
		const vm = buildFormViewModel({
			resource: userResource,
			columns: cols({ propertyKey: "id" }, { propertyKey: "name" }),
			pkColumn: "id",
		});
		expect(vm.isEdit).toBe(false);
		expect(vm.action).toBe("/admin/users");
		expect(vm.cancelUrl).toBe("/admin/users");
		expect(vm.submitLabel).toBe("Create");
		expect(vm.heading).toBe("New Users");
		// Primary key is hidden from the form body.
		expect(field(vm.fields, "id")).toBeUndefined();
		expect(field(vm.fields, "name")).toBeDefined();
	});

	it("infers the <input type> from column metadata (Story 54.5)", () => {
		const vm = buildFormViewModel({
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
		expect(field(vm.fields, "name")?.inputType).toBe("text");
		expect(field(vm.fields, "age")?.inputType).toBe("number");
		const isAdmin = field(vm.fields, "isAdmin");
		expect(isAdmin?.inputType).toBe("checkbox");
		expect(isAdmin?.isCheckbox).toBe(true);
		const bio = field(vm.fields, "bio");
		expect(bio?.inputType).toBe("textarea");
		expect(bio?.isTextarea).toBe(true);
		expect(field(vm.fields, "publishedAt")?.inputType).toBe("datetime-local");
		// Property name heuristic: `email` → type="email"
		expect(field(vm.fields, "email")?.inputType).toBe("email");
	});

	it("skips created_at / updated_at / deleted_at by convention", () => {
		const vm = buildFormViewModel({
			resource: userResource,
			columns: cols(
				{ propertyKey: "name" },
				{ propertyKey: "createdAt", type: "datetime" },
				{ propertyKey: "updatedAt", type: "datetime" },
				{ propertyKey: "deletedAt", type: "datetime" },
			),
			pkColumn: "id",
		});
		expect(vm.fields.map((f) => f.name)).toEqual(["name"]);
	});

	it("honours per-field overrides (formFields): label, placeholder, hidden", () => {
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
		const vm = buildFormViewModel({
			resource,
			columns: cols(
				{ propertyKey: "name" },
				{ propertyKey: "bio" },
				{ propertyKey: "ssn" },
			),
			pkColumn: "id",
		});
		const bio = field(vm.fields, "bio");
		expect(bio?.label).toBe("Biography");
		expect(bio?.placeholder).toBe("Tell us…");
		expect(bio?.hasPlaceholder).toBe(true);
		expect(bio?.isTextarea).toBe(true);
		// `hidden: true` drops the field entirely.
		expect(field(vm.fields, "ssn")).toBeUndefined();
		// A field without an override placeholder is flagged absent.
		expect(field(vm.fields, "name")?.hasPlaceholder).toBe(false);
	});

	it("marks required fields and derives a stable field id", () => {
		const resource = defineResource({
			entity: class User {},
			formFields: { name: { required: true } },
		});
		const vm = buildFormViewModel({
			resource,
			columns: cols({ propertyKey: "name" }),
			pkColumn: "id",
		});
		const name = field(vm.fields, "name");
		expect(name?.required).toBe(true);
		expect(name?.fieldId).toBe("f-name");
	});

	it("defaults csrfEnabled to false and reflects the flag when passed", () => {
		const base = {
			resource: userResource,
			columns: cols({ propertyKey: "name" }),
			pkColumn: "id",
		};
		expect(buildFormViewModel(base).csrfEnabled).toBe(false);
		expect(buildFormViewModel({ ...base, csrfEnabled: true }).csrfEnabled).toBe(
			true,
		);
	});
});

describe("station > views > buildFormViewModel (edit)", () => {
	it("targets /admin/<slug>/:id, flags isEdit, and pre-fills row values", () => {
		const vm = buildFormViewModel({
			resource: userResource,
			columns: cols({ propertyKey: "name" }, { propertyKey: "age" }),
			pkColumn: "id",
			row: { id: 7, name: "Alice", age: 30 },
		});
		expect(vm.isEdit).toBe(true);
		expect(vm.action).toBe("/admin/users/7");
		expect(vm.submitLabel).toBe("Update");
		expect(vm.heading).toBe("Edit Users #7");
		expect(field(vm.fields, "name")?.value).toBe("Alice");
		expect(field(vm.fields, "age")?.value).toBe("30");
	});

	it("URL-encodes the row id in the precomputed action", () => {
		const vm = buildFormViewModel({
			resource: userResource,
			columns: cols({ propertyKey: "name" }),
			pkColumn: "id",
			row: { id: "a/b c", name: "x" },
		});
		expect(vm.action).toBe("/admin/users/a%2Fb%20c");
	});

	it("pre-stringifies null/undefined field values to the empty string", () => {
		const vm = buildFormViewModel({
			resource: userResource,
			columns: cols({ propertyKey: "name" }, { propertyKey: "nickname" }),
			pkColumn: "id",
			row: { id: 1, name: null },
		});
		expect(field(vm.fields, "name")?.value).toBe("");
		expect(field(vm.fields, "nickname")?.value).toBe("");
	});

	it("checks a boolean field when the row value is truthy", () => {
		const resource = defineResource({
			entity: class User {},
			formFields: { active: { inputType: "checkbox" } },
		});
		const on = buildFormViewModel({
			resource,
			columns: cols({ propertyKey: "active" }),
			pkColumn: "id",
			row: { id: 1, active: true },
		});
		expect(field(on.fields, "active")?.checked).toBe(true);
		const off = buildFormViewModel({
			resource,
			columns: cols({ propertyKey: "active" }),
			pkColumn: "id",
			row: { id: 1, active: false },
		});
		expect(field(off.fields, "active")?.checked).toBe(false);
	});

	it("carries the raw field value unescaped (inker owns HTML-escaping)", () => {
		const vm = buildFormViewModel({
			resource: userResource,
			columns: cols({ propertyKey: "name" }),
			pkColumn: "id",
			row: { id: 1, name: '"><script>alert(1)</script>' },
		});
		// The builder is now pure data: escaping happens in the template's
		// `{{ }}` (proven in views-form-login-inker.test.ts), so the raw
		// payload is expected here.
		expect(field(vm.fields, "name")?.value).toBe('"><script>alert(1)</script>');
	});

	it("maps supplied per-field errors onto the field, empty string otherwise", () => {
		const vm = buildFormViewModel({
			resource: userResource,
			columns: cols({ propertyKey: "name" }, { propertyKey: "age" }),
			pkColumn: "id",
			row: { id: 1, name: "x", age: 1 },
			errors: { name: "Required" },
		});
		expect(field(vm.fields, "name")?.error).toBe("Required");
		expect(field(vm.fields, "age")?.error).toBe("");
	});
});
