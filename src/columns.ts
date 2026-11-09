/**
 * Which columns each admin view shows and which ones a write may touch.
 *
 * Two rules keep secrets out of the admin by default:
 *  - a column the model hides from serialization (`serializeAs: null`, the
 *    marker `toJSON` honours) or whose name says it holds a secret is neither
 *    rendered nor writable unless the resource names it explicitly;
 *  - the writable set is an allow-list: `editable` when the resource declares
 *    one, otherwise every non-secret, non-framework column the form shows.
 */

import type { ColumnMetadata } from "@c9up/atlas";
import type { Resource } from "./types.js";

/** Column names that hold credentials — hidden, never flashed, never echoed. */
export const SENSITIVE_KEY_RE = /password|passwd|secret|token|apikey/i;

const TIMESTAMP_PROPERTY_KEYS: ReadonlySet<string> = new Set([
	"createdAt",
	"updatedAt",
	"deletedAt",
]);
const TIMESTAMP_COLUMN_NAMES: ReadonlySet<string> = new Set([
	"created_at",
	"updated_at",
	"deleted_at",
]);

export function isSecretColumn(c: ColumnMetadata): boolean {
	return c.serializeAs === null || SENSITIVE_KEY_RE.test(c.propertyKey);
}

/**
 * Columns the framework owns: the primary key, managed timestamps (flagged
 * `autoCreate`/`autoUpdate` or named by convention), relations and the
 * soft-delete column. Never writable from a request body.
 */
export function isFrameworkManaged(
	c: ColumnMetadata,
	pkColumn: string,
	autoManaged: ReadonlySet<string>,
	excludedProps: ReadonlySet<string>,
): boolean {
	if (c.propertyKey === pkColumn) return true;
	if (autoManaged.has(c.propertyKey)) return true;
	if (TIMESTAMP_PROPERTY_KEYS.has(c.propertyKey)) return true;
	const snake = c.propertyKey.replace(/([A-Z])/g, "_$1").toLowerCase();
	if (TIMESTAMP_COLUMN_NAMES.has(snake)) return true;
	return excludedProps.has(c.propertyKey);
}

function byName(
	columns: ReadonlyArray<ColumnMetadata>,
	names: ReadonlyArray<string>,
	resource: Resource,
	option: string,
): ColumnMetadata[] {
	return names.map((name) => {
		const column = columns.find((c) => c.propertyKey === name);
		if (column === undefined) {
			throw new Error(
				`[station] defineResource '${resource.name}': ${option} names '${name}', which is not a column of ${resource.entity.name}.`,
			);
		}
		return column;
	});
}

/**
 * The columns a list or show view renders: the declared allow-list in its
 * order, or every non-secret column.
 */
export function viewColumns(
	columns: ReadonlyArray<ColumnMetadata>,
	allow: ReadonlyArray<string> | undefined,
	resource: Resource,
	option: string,
): ReadonlyArray<ColumnMetadata> {
	if (allow !== undefined) return byName(columns, allow, resource, option);
	return columns.filter((c) => !isSecretColumn(c));
}

/**
 * The columns a create/edit body may set, which are also the form's fields.
 * An explicit `editable` naming a framework-owned or form-hidden column is a
 * contradiction and fails at mount rather than being silently trimmed.
 */
export function editableColumns(
	columns: ReadonlyArray<ColumnMetadata>,
	resource: Resource,
	pkColumn: string,
	autoManaged: ReadonlySet<string>,
	excludedProps: ReadonlySet<string>,
): ReadonlyArray<ColumnMetadata> {
	if (resource.editable !== undefined) {
		const picked = byName(columns, resource.editable, resource, "editable");
		for (const c of picked) {
			if (isFrameworkManaged(c, pkColumn, autoManaged, excludedProps)) {
				throw new Error(
					`[station] defineResource '${resource.name}': editable names '${c.propertyKey}', which the framework manages (primary key, timestamp, relation or soft-delete column).`,
				);
			}
			if (resource.formFields[c.propertyKey]?.hidden === true) {
				throw new Error(
					`[station] defineResource '${resource.name}': editable names '${c.propertyKey}', which formFields hides.`,
				);
			}
		}
		return picked;
	}
	return columns.filter(
		(c) =>
			!isFrameworkManaged(c, pkColumn, autoManaged, excludedProps) &&
			!isSecretColumn(c) &&
			resource.formFields[c.propertyKey]?.hidden !== true,
	);
}

/**
 * Editable columns whose stored value is never sent back to the browser: the
 * form renders them empty and an empty submission leaves them unchanged.
 */
export function writeOnlyKeys(
	editable: ReadonlyArray<ColumnMetadata>,
	resource: Resource,
): ReadonlySet<string> {
	return new Set(
		editable
			.filter(
				(c) =>
					isSecretColumn(c) ||
					resource.formFields[c.propertyKey]?.inputType === "password",
			)
			.map((c) => c.propertyKey),
	);
}
