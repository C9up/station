/**
 * `GET /admin/<slug>/:id` — detail view (columns only in 54.2).
 *
 * Relations are deferred — see story spec AC17 Spec Deviations. Every
 * dynamic value flows through `escapeHtml()`; URL components through
 * `encodeURIComponent()`.
 */

import type { ColumnMetadata } from "@c9up/atlas";
import type { Resource } from "../types.js";
import { escapeHtml, safeHtml } from "./escape.js";
import { renderLayout } from "./layout.js";

export interface ShowPageInput {
	resource: Resource;
	row: Record<string, unknown>;
	columns: ReadonlyArray<ColumnMetadata>;
	pkColumn: string;
}

export function renderShowPage(input: ShowPageInput): string {
	const { resource, row, columns, pkColumn } = input;
	const id = String(row[pkColumn] ?? "");
	const slug = encodeURIComponent(resource.name);
	const heading = `${escapeHtml(resource.label)} #${escapeHtml(id)}`;
	const dl = columns
		.map(
			(c) =>
				`<dt>${escapeHtml(c.propertyKey)}</dt><dd>${escapeHtml(row[c.propertyKey])}</dd>`,
		)
		.join("");
	const backLink = `<a class="st-backlink" href="/admin/${slug}">← Back to ${escapeHtml(resource.label)}</a>`;
	return renderLayout({
		title: `${resource.label} #${id}`,
		bodyHtml: safeHtml(`<h1>${heading}</h1><dl>${dl}</dl>${backLink}`),
	});
}
