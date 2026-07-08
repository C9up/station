/**
 * Story 57.3 — the form (new/edit) + login views rendered through the inker
 * seam. The retired hand-rolled `renderFormPage` / `renderLoginPage` are gone;
 * the handlers now build a pure view-model and hand it to `station::form` /
 * `station::login`. These tests drive the REAL `@c9up/inker` engine (the same
 * `makeInkerRenderer()` stand-in the roundtrip test binds) against the built
 * view-models, proving:
 *   - the external HTML contract the surface test asserts (form method/action,
 *     st-field/st-form/st-form-actions/st-cancel classes, `_method=PUT` on edit,
 *     the three per-field input shapes, login email/password + `role="alert"`);
 *   - inker's `{{ }}` auto-escaping replaces the retired `escapeHtml` on the
 *     security path (hostile field / error values, AC5);
 *   - both CSRF paths (AC4): a seeded token renders `{{ csrfField() }}` as the
 *     `_csrf` hidden input; an absent token guards the helper off with no throw.
 */
import { fileURLToPath } from "node:url";
import type { ColumnMetadata } from "@c9up/atlas";
import { describe, expect, it } from "vitest";
import { defineResource } from "../../src/defineResource.js";
import { buildFormViewModel } from "../../src/views/form.js";
import { buildLoginViewModel } from "../../src/views/login.js";
import { makeInkerRenderer } from "../__helpers__/inker-renderer.js";

const TEMPLATES_ROOT = fileURLToPath(
	new URL("../../templates/", import.meta.url),
);
const userResource = defineResource({ entity: class User {} });

function cols(
	...specs: Array<{ propertyKey: string; type?: string }>
): ColumnMetadata[] {
	return specs.map((s) => ({ propertyKey: s.propertyKey, type: s.type }));
}

function renderer() {
	const r = makeInkerRenderer();
	r.mount("station", TEMPLATES_ROOT);
	return r;
}

const csrfStore = {
	store: new Map<string, unknown>([["csrfToken", "tok123"]]),
};

describe("station > integration > 57.3 inker-rendered form", () => {
	it("create: composes the layout shell + POST form, no _method, no CSRF", async () => {
		const vm = buildFormViewModel({
			resource: userResource,
			columns: cols({ propertyKey: "id" }, { propertyKey: "name" }),
			pkColumn: "id",
		});
		const html = await renderer().renderToString({}, "station::form", vm);

		expect(html).toContain("<!doctype html>");
		expect(html).toContain("<title>New Users · Station</title>");
		expect(html).toContain("<h1>New Users</h1>");
		expect(html).toContain(
			'<form class="st-form" method="POST" action="/admin/users">',
		);
		expect(html).not.toContain('name="_method"');
		expect(html).not.toContain('name="_csrf"');
		// The primary key is not rendered as a field.
		expect(html).not.toMatch(/<input[^>]+name="id"/);
		expect(html).toContain(
			'<div class="st-field"><label for="f-name">Name</label>',
		);
		expect(html).toContain(
			'<input id="f-name" type="text" name="name" value="">',
		);
		expect(html).toContain(
			'<div class="st-form-actions"><button type="submit">Create</button><a class="st-cancel" href="/admin/users">Cancel</a></div>',
		);
	});

	it("create: renders the three input variants with the load-bearing attribute order", async () => {
		const resource = defineResource({
			entity: class User {},
			formFields: {
				email: { required: true, placeholder: "you@example.com" },
				active: { inputType: "checkbox" },
			},
		});
		const vm = buildFormViewModel({
			resource,
			columns: cols(
				{ propertyKey: "email", type: "string" },
				{ propertyKey: "bio", type: "text" },
				{ propertyKey: "active", type: "boolean" },
			),
			pkColumn: "id",
		});
		const html = await renderer().renderToString({}, "station::form", vm);

		// default input: id, type, name, value, required, placeholder (in order).
		expect(html).toContain(
			'<input id="f-email" type="email" name="email" value="" required placeholder="you@example.com">',
		);
		// textarea: no type; value as inner text.
		expect(html).toContain('<textarea id="f-bio" name="bio"></textarea>');
		// checkbox: value="1", no required/placeholder.
		expect(html).toContain(
			'<input id="f-active" type="checkbox" name="active" value="1">',
		);
	});

	it("edit: renders _method=PUT, pre-fills the value, targets the id route", async () => {
		const vm = buildFormViewModel({
			resource: userResource,
			columns: cols({ propertyKey: "name" }),
			pkColumn: "id",
			row: { id: 7, name: "Alice" },
		});
		const html = await renderer().renderToString({}, "station::form", vm);

		expect(html).toContain("<h1>Edit Users #7</h1>");
		expect(html).toContain(
			'<form class="st-form" method="POST" action="/admin/users/7">',
		);
		expect(html).toContain('<input type="hidden" name="_method" value="PUT">');
		expect(html).toContain('value="Alice"');
		expect(html).toContain('<button type="submit">Update</button>');
	});

	it("edit: checks a truthy boolean field", async () => {
		const resource = defineResource({
			entity: class User {},
			formFields: { active: { inputType: "checkbox" } },
		});
		const vm = buildFormViewModel({
			resource,
			columns: cols({ propertyKey: "active" }),
			pkColumn: "id",
			row: { id: 1, active: true },
		});
		const html = await renderer().renderToString({}, "station::form", vm);
		expect(html).toContain(
			'<input id="f-active" type="checkbox" name="active" value="1" checked>',
		);
	});

	it("edit: inker `{{ }}` escapes an attribute-injection field value (AC5)", async () => {
		const vm = buildFormViewModel({
			resource: userResource,
			columns: cols({ propertyKey: "name" }),
			pkColumn: "id",
			row: { id: 1, name: '"><script>alert(1)</script>' },
		});
		const html = await renderer().renderToString({}, "station::form", vm);
		expect(html).not.toContain("<script>alert(1)</script>");
		expect(html).toContain("&quot;&gt;&lt;script&gt;");
	});

	it("renders a per-field error slot only when an error is present", async () => {
		const vm = buildFormViewModel({
			resource: userResource,
			columns: cols({ propertyKey: "name" }, { propertyKey: "age" }),
			pkColumn: "id",
			row: { id: 1, name: "x", age: 1 },
			errors: { name: "Required" },
		});
		const html = await renderer().renderToString({}, "station::form", vm);
		expect(html).toContain('<p class="st-field-error">Required</p>');
		// Only one field carries an error slot.
		expect(html.match(/st-field-error/g) ?? []).toHaveLength(1);
	});

	it("CSRF present: emits the `_csrf` hidden input via csrfField() (AC4)", async () => {
		const vm = buildFormViewModel({
			resource: userResource,
			columns: cols({ propertyKey: "name" }),
			pkColumn: "id",
			csrfEnabled: true,
		});
		const html = await renderer().renderToString(
			csrfStore,
			"station::form",
			vm,
		);
		expect(html).toContain('<input type="hidden" name="_csrf" value="tok123">');
	});

	it("CSRF absent: guards csrfField() off, page still renders (no throw)", async () => {
		const vm = buildFormViewModel({
			resource: userResource,
			columns: cols({ propertyKey: "name" }),
			pkColumn: "id",
			csrfEnabled: false,
		});
		const html = await renderer().renderToString({}, "station::form", vm);
		expect(html).not.toContain('name="_csrf"');
		expect(html).toContain("<h1>New Users</h1>");
	});
});

describe("station > integration > 57.3 inker-rendered login", () => {
	it("renders the sign-in form with email + password fields", async () => {
		const vm = buildLoginViewModel({});
		const html = await renderer().renderToString({}, "station::login", vm);

		expect(html).toContain("<title>Sign in · Station</title>");
		expect(html).toContain("<h1>Sign in</h1>");
		expect(html).toContain(
			'<form class="st-form" method="POST" action="/admin/login">',
		);
		expect(html).toContain(
			'<input id="f-email" type="email" name="email" value="" required autocomplete="email" autofocus>',
		);
		expect(html).toContain(
			'<input id="f-password" type="password" name="password" required autocomplete="current-password">',
		);
		expect(html).toContain('<button type="submit">Sign in</button>');
		// No error block when none supplied.
		expect(html).not.toContain('class="st-form-error"');
	});

	it("pre-fills the email and honours a custom action", async () => {
		const vm = buildLoginViewModel({
			email: "admin@example.com",
			action: "/custom/login",
		});
		const html = await renderer().renderToString({}, "station::login", vm);
		expect(html).toContain('value="admin@example.com"');
		expect(html).toContain('action="/custom/login"');
	});

	it("renders the page-level error with role=alert and escapes it (AC5)", async () => {
		const vm = buildLoginViewModel({ error: "<script>x</script>" });
		const html = await renderer().renderToString({}, "station::login", vm);
		expect(html).toContain(
			'<p class="st-form-error" role="alert">&lt;script&gt;x&lt;/script&gt;</p>',
		);
		expect(html).not.toContain("<script>x</script>");
	});

	it("CSRF present: emits the `_csrf` hidden input via csrfField() (AC4)", async () => {
		const vm = buildLoginViewModel({ csrfEnabled: true });
		const html = await renderer().renderToString(
			csrfStore,
			"station::login",
			vm,
		);
		expect(html).toContain('<input type="hidden" name="_csrf" value="tok123">');
	});

	it("CSRF absent: guards csrfField() off, page still renders (no throw)", async () => {
		const vm = buildLoginViewModel({ csrfEnabled: false });
		const html = await renderer().renderToString({}, "station::login", vm);
		expect(html).not.toContain('name="_csrf"');
		expect(html).toContain("<h1>Sign in</h1>");
	});
});
