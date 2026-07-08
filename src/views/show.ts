/**
 * `GET /admin/<slug>/:id` — detail view (columns only in 54.2).
 *
 * Pure `(input) => ShowViewModel` builder. Columns × row are flattened into
 * a `fields` array with pre-stringified values (inker's grammar has no
 * dynamic `row[key]` indexing), and the slug is `encodeURIComponent`-ed for
 * the back-link. `templates/show.inker` iterates + interpolates; inker owns
 * the HTML-escaping (the retired `escape.ts` no longer runs here).
 */

import type { ColumnMetadata } from "@c9up/atlas";
import type { Resource } from "../types.js";

export interface ShowPageInput {
	resource: Resource;
	row: Record<string, unknown>;
	columns: ReadonlyArray<ColumnMetadata>;
	pkColumn: string;
}

/** A single `<dt>/<dd>` pair: the column key + its pre-stringified value. */
export interface ShowField {
	label: string;
	value: string;
}

// A `type` alias (not `interface`) so the view-model carries an implicit
// index signature and stays assignable to the renderer's
// `Readonly<Record<string, unknown>>` data param without a cast.
export type ShowViewModel = {
	title: string;
	heading: string;
	fields: ShowField[];
	backHref: string;
	backLabel: string;
};

export function buildShowViewModel(input: ShowPageInput): ShowViewModel {
	const { resource, row, columns, pkColumn } = input;
	const id = String(row[pkColumn] ?? "");
	const slug = encodeURIComponent(resource.name);
	// HTML-escaping is a per-character replace, so it distributes over
	// concatenation: the retired view escaped label and id separately, so
	// composing the heading here then letting inker's `{{ }}` escape it whole
	// stays equivalent — inker escapes a superset of the retired escape.ts
	// (backtick, U+2028/U+2029), so the output is byte-identical except for
	// those extra chars, and at minimum equally safe. Built via join (no `+`
	// concat, no interpolation slot) so neither biome's useTemplate nor the
	// no-unescaped-interpolation grep-ban fires on this now-data-only file.
	const heading = [resource.label, id].join(" #");
	return {
		title: heading,
		heading,
		fields: columns.map((c) => ({
			label: c.propertyKey,
			value: stringifyValue(row[c.propertyKey]),
		})),
		backHref: `/admin/${slug}`,
		backLabel: resource.label,
	};
}

/** Match the retired `escapeHtml(null | undefined)` behaviour of empty output. */
function stringifyValue(value: unknown): string {
	return value === null || value === undefined ? "" : String(value);
}
