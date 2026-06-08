/**
 * `GET /admin/<slug>/new` + `GET /admin/<slug>/:id/edit` — form view
 * shared between the create and edit actions (Story 54.3).
 *
 * Field rendering is INFERRED from the entity's `@Column` metadata
 * (Story 54.5): column type maps to an `<input type>`, boolean →
 * checkbox, text-long → textarea, etc. The primary key and any
 * timestamp columns (`created_at` / `updated_at` / `deleted_at`) are
 * skipped from the form body. Per-field overrides declared on
 * `Resource.formFields` win over the inferred defaults.
 *
 * Every dynamic value flows through `escapeHtml()` so a malicious
 * column value rendered into an edit form cannot smuggle markup. The
 * lint sweep at `tests/unit/no-unescaped-interpolation.test.ts`
 * enforces the convention.
 */

import type { ColumnMetadata } from "@c9up/atlas";
import type { FormFieldOverride, Resource } from "../types.js";
import { escapeHtml, safeHtml } from "./escape.js";
import { renderLayout } from "./layout.js";

const SKIPPED_COLUMN_NAMES: ReadonlySet<string> = new Set([
	"created_at",
	"updated_at",
	"deleted_at",
]);

export interface FormPageInput {
	resource: Resource;
	columns: ReadonlyArray<ColumnMetadata>;
	pkColumn: string;
	/** Existing row for edit; undefined for create. */
	row?: Readonly<Record<string, unknown>>;
	/** Validation errors keyed by column propertyKey. */
	errors?: Readonly<Record<string, string>>;
	/** Caller-controlled hidden inputs (e.g. CSRF token). */
	hiddenInputs?: ReadonlyArray<{ name: string; value: string }>;
}

export function renderFormPage(input: FormPageInput): string {
	const { resource, columns, pkColumn, row, errors, hiddenInputs } = input;
	const isEdit = row !== undefined;
	const slug = encodeURIComponent(resource.name);
	const id = isEdit ? String(row[pkColumn] ?? "") : "";
	const action = isEdit
		? `/admin/${slug}/${encodeURIComponent(id)}`
		: `/admin/${slug}`;
	const methodOverride = isEdit
		? `<input type="hidden" name="_method" value="PUT">`
		: "";
	const heading = isEdit
		? `Edit ${escapeHtml(resource.label)} #${escapeHtml(id)}`
		: `New ${escapeHtml(resource.label)}`;

	const hiddens = (hiddenInputs ?? [])
		.map(
			(h) =>
				`<input type="hidden" name="${escapeHtml(h.name)}" value="${escapeHtml(h.value)}">`,
		)
		.join("");

	const fieldHtml = columns
		.filter(
			(c) => !shouldSkipColumn(c, pkColumn, resource.formFields[c.propertyKey]),
		)
		.map((c) => renderField(c, row, errors, resource.formFields[c.propertyKey]))
		.join("");

	const submitLabel = isEdit ? "Update" : "Create";
	const cancelUrl = isEdit
		? `/admin/${slug}/${encodeURIComponent(id)}`
		: `/admin/${slug}`;

	const body =
		`<h1>${heading}</h1>` +
		`<form class="st-form" method="POST" action="${escapeHtml(action)}">` +
		methodOverride +
		hiddens +
		fieldHtml +
		`<div class="st-form-actions">` +
		`<button type="submit">${escapeHtml(submitLabel)}</button>` +
		`<a class="st-cancel" href="${escapeHtml(cancelUrl)}">Cancel</a>` +
		`</div>` +
		`</form>`;

	return renderLayout({
		title: isEdit ? `Edit ${resource.label} #${id}` : `New ${resource.label}`,
		bodyHtml: safeHtml(body),
	});
}

function shouldSkipColumn(
	c: ColumnMetadata,
	pkColumn: string,
	override: FormFieldOverride | undefined,
): boolean {
	if (override?.hidden === true) return true;
	// Atlas's ColumnMetadata exposes the property key (camelCase). The
	// pkColumn passed by the provider is also camelCase (it comes from
	// `atlas.getPrimaryKey(entity)`), so the comparison is direct.
	// snake_case fallbacks live in SKIPPED_COLUMN_NAMES below for the
	// timestamps convention.
	if (c.propertyKey === pkColumn) return true;
	const snake = c.propertyKey.replace(/([A-Z])/g, "_$1").toLowerCase();
	if (SKIPPED_COLUMN_NAMES.has(snake)) return true;
	if (SKIPPED_COLUMN_NAMES.has(c.propertyKey)) return true;
	return false;
}

function renderField(
	c: ColumnMetadata,
	row: Readonly<Record<string, unknown>> | undefined,
	errors: Readonly<Record<string, string>> | undefined,
	override: FormFieldOverride | undefined,
): string {
	const inputType = override?.inputType ?? inferInputType(c);
	const labelText = override?.label ?? titleise(c.propertyKey);
	const required = override?.required === true ? " required" : "";
	const placeholder =
		override?.placeholder !== undefined
			? ` placeholder="${escapeHtml(override.placeholder)}"`
			: "";
	const name = c.propertyKey;
	const fieldId = `f-${escapeHtml(name)}`;
	const rawValue = row?.[name];
	const errorMsg = errors?.[name];
	const errorHtml =
		errorMsg !== undefined
			? `<p class="st-field-error">${escapeHtml(errorMsg)}</p>`
			: "";

	const input = renderInput(
		inputType,
		fieldId,
		name,
		rawValue,
		required,
		placeholder,
	);

	return (
		`<div class="st-field">` +
		`<label for="${escapeHtml(fieldId)}">${escapeHtml(labelText)}</label>` +
		input +
		errorHtml +
		`</div>`
	);
}

/** Render the `<input>` / `<textarea>` element for a field by input type. */
function renderInput(
	inputType: FormFieldOverride["inputType"],
	fieldId: string,
	name: string,
	rawValue: unknown,
	required: string,
	placeholder: string,
): string {
	if (inputType === "checkbox") {
		const checked = rawValue ? " checked" : "";
		return `<input id="${escapeHtml(fieldId)}" type="checkbox" name="${escapeHtml(name)}" value="1"${checked}>`;
	}
	const value =
		rawValue === undefined || rawValue === null ? "" : String(rawValue);
	if (inputType === "textarea") {
		return `<textarea id="${escapeHtml(fieldId)}" name="${escapeHtml(name)}"${required}${placeholder}>${escapeHtml(value)}</textarea>`;
	}
	return `<input id="${escapeHtml(fieldId)}" type="${escapeHtml(inputType)}" name="${escapeHtml(name)}" value="${escapeHtml(value)}"${required}${placeholder}>`;
}

function inferInputType(c: ColumnMetadata): FormFieldOverride["inputType"] {
	const type = (c.type ?? "").toString().toLowerCase();
	if (type === "boolean") return "checkbox";
	if (type === "integer" || type === "bigint" || type === "number") {
		return "number";
	}
	if (type === "date") return "date";
	if (type === "datetime" || type === "timestamp") return "datetime-local";
	if (type === "text" || type === "longtext") return "textarea";
	const name = c.propertyKey.toLowerCase();
	if (name.includes("email")) return "email";
	if (name.includes("password")) return "password";
	return "text";
}

function titleise(propertyKey: string): string {
	// camelCase → "Camel Case"
	const spaced = propertyKey.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
	return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
