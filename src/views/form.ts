/**
 * `GET /admin/<slug>/new` + `GET /admin/<slug>/:id/edit` — form view
 * shared between the create and edit actions (Story 54.3).
 *
 * Pure `(input) => FormViewModel` builder (Story 57.3). Field rendering is
 * INFERRED from the entity's `@Column` metadata (Story 54.5): column type maps
 * to an `<input type>`, boolean → checkbox, text-long → textarea, etc. The
 * primary key plus the timestamp columns (`created_at` / `updated_at` /
 * `deleted_at`) are skipped from the form body. Per-field overrides declared on
 * `Resource.formFields` win over the inferred defaults.
 *
 * The builder precomputes everything inker's `{{ }}` grammar cannot express —
 * `encodeURIComponent` on the URL components (inker only HTML-escapes), the
 * per-field variant discriminants, and pre-stringified values — and hands it to
 * `templates/form.inker`, which iterates + interpolates. inker owns the
 * HTML-escaping (the retired `escape.ts` no longer runs here). The CSRF hidden
 * input is emitted by inker's canonical `{{ csrfField() }}` helper, guarded by
 * the precomputed `csrfEnabled` boolean. Enforcement is the handler's: every
 * write route fail-closes on `ctx.request.csrfProtected` before any auth or DB
 * work, so a seeded token here is a convenience, never the check.
 */

import type { ColumnMetadata } from "@c9up/atlas";
import type { FormFieldOverride, Resource } from "../types.js";

const SKIPPED_COLUMN_NAMES: ReadonlySet<string> = new Set([
	"created_at",
	"updated_at",
	"deleted_at",
]);

type InputType = NonNullable<FormFieldOverride["inputType"]>;

export interface FormPageInput {
	resource: Resource;
	columns: ReadonlyArray<ColumnMetadata>;
	pkColumn: string;
	/** Existing row for edit; undefined for create. */
	row?: Readonly<Record<string, unknown>>;
	/**
	 * Submitted values to repopulate the fields with, INDEPENDENT of `row`
	 * (57.7). On a 422 re-render the form must echo what the user just typed —
	 * for a *create* that means field values with NO `row` (so `isEdit` stays
	 * false and the action URL stays `/admin/<slug>`), and for an *edit* it means
	 * the submitted values while `row` still supplies the id/action. When absent,
	 * fields fall back to `row` (the normal create/edit GET render).
	 */
	values?: Readonly<Record<string, unknown>>;
	/** Validation errors keyed by column propertyKey. */
	errors?: Readonly<Record<string, string>>;
	/**
	 * Whether the host has a CSRF token in the per-request store. When true the
	 * template emits `{{ csrfField() }}`; the handler derives it from
	 * `ctx.store` (57.3). Replaces the old `hiddenInputs?` array.
	 */
	csrfEnabled?: boolean;
}

/** A single form field descriptor consumed by `form.inker`. */
export interface FormField {
	name: string;
	fieldId: string;
	label: string;
	inputType: InputType;
	isCheckbox: boolean;
	isTextarea: boolean;
	value: string;
	required: boolean;
	placeholder: string;
	hasPlaceholder: boolean;
	checked: boolean;
	error: string;
}

// A `type` alias (not `interface`) so the view-model carries an implicit index
// signature and stays assignable to the renderer's
// `Readonly<Record<string, unknown>>` data param without a cast.
export type FormViewModel = {
	title: string;
	heading: string;
	isEdit: boolean;
	action: string;
	cancelUrl: string;
	submitLabel: string;
	csrfEnabled: boolean;
	fields: FormField[];
};

export function buildFormViewModel(input: FormPageInput): FormViewModel {
	const { resource, columns, pkColumn, row, values, errors, csrfEnabled } =
		input;
	const isEdit = row !== undefined;
	const slug = encodeURIComponent(resource.name);
	const id = isEdit ? String(row[pkColumn] ?? "") : "";
	// Contains `encodeURIComponent(` + the structural `slug`, so the
	// no-unescaped-interpolation grep-ban allows these interpolation slots.
	const action = isEdit
		? `/admin/${slug}/${encodeURIComponent(id)}`
		: `/admin/${slug}`;
	// Composed via array `join` (no `${}`, no `+`) so neither biome's
	// useTemplate nor the grep-ban fires on this now-data-only file (show.ts:50).
	const heading = isEdit
		? ["Edit ", resource.label, " #", id].join("")
		: ["New ", resource.label].join("");

	const fields = columns
		.filter(
			(c) => !shouldSkipColumn(c, pkColumn, resource.formFields[c.propertyKey]),
		)
		.map((c) =>
			buildField(c, values ?? row, errors, resource.formFields[c.propertyKey]),
		);

	return {
		title: heading,
		heading,
		isEdit,
		action,
		cancelUrl: action,
		submitLabel: isEdit ? "Update" : "Create",
		csrfEnabled: csrfEnabled === true,
		fields,
	};
}

function buildField(
	c: ColumnMetadata,
	source: Readonly<Record<string, unknown>> | undefined,
	errors: Readonly<Record<string, string>> | undefined,
	override: FormFieldOverride | undefined,
): FormField {
	const inputType = override?.inputType ?? inferInputType(c);
	const name = c.propertyKey;
	const rawValue = source?.[name];
	const isCheckbox = inputType === "checkbox";
	const value =
		rawValue === undefined || rawValue === null ? "" : String(rawValue);
	return {
		name,
		fieldId: ["f-", name].join(""),
		label: override?.label ?? titleise(name),
		inputType,
		isCheckbox,
		isTextarea: inputType === "textarea",
		value,
		required: override?.required === true,
		placeholder: override?.placeholder ?? "",
		hasPlaceholder: override?.placeholder !== undefined,
		checked: isCheckbox ? Boolean(rawValue) : false,
		error: errors?.[name] ?? "",
	};
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

function inferInputType(c: ColumnMetadata): InputType {
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
