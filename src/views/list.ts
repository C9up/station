/**
 * `GET /admin/<slug>` — paginated list view.
 *
 * Pure `(input) => string` renderer. Every dynamic value flows through
 * `escapeHtml()` or `encodeURIComponent()` (URL components). The
 * "interpolation must wrap" rule is grep-enforced by
 * `tests/unit/no-unescaped-interpolation.test.ts`.
 */

import type { ColumnMetadata } from "@c9up/atlas";
import type { Resource } from "../types.js";
import { escapeHtml, safeHtml } from "./escape.js";
import { renderLayout } from "./layout.js";

export interface ListPageInput {
	resource: Resource;
	rows: ReadonlyArray<Record<string, unknown>>;
	columns: ReadonlyArray<ColumnMetadata>;
	pkColumn: string;
	page: number;
	perPage: number;
	total: number;
	lastPage: number;
}

export function renderListPage(input: ListPageInput): string {
	const { resource, rows, columns, pkColumn, page, perPage, total, lastPage } =
		input;
	const slug = encodeURIComponent(resource.name);
	const body =
		rows.length === 0
			? renderEmptyState(resource)
			: renderTable(rows, columns, pkColumn, slug);
	const pager = renderPager(slug, page, perPage, lastPage);
	const caption = renderCaption(page, perPage, total);
	return renderLayout({
		title: resource.label,
		bodyHtml: safeHtml(
			`<h1>${escapeHtml(resource.label)}</h1>${body}${pager}${caption}`,
		),
	});
}

function renderEmptyState(resource: Resource): string {
	return `<p class="st-empty">No ${escapeHtml(resource.label.toLowerCase())} yet.</p>`;
}

function renderTable(
	rows: ReadonlyArray<Record<string, unknown>>,
	columns: ReadonlyArray<ColumnMetadata>,
	pkColumn: string,
	slug: string,
): string {
	const headers = columns
		.map((c) => `<th>${escapeHtml(c.propertyKey)}</th>`)
		.join("");
	const headerRow = `<thead><tr>${headers}<th></th></tr></thead>`;
	const bodyRows = rows
		.map((row) => {
			const cells = columns
				.map((c) => `<td>${escapeHtml(row[c.propertyKey])}</td>`)
				.join("");
			const id = String(row[pkColumn] ?? "");
			const showLink = `<td><a href="/admin/${slug}/${encodeURIComponent(id)}">Show</a></td>`;
			return `<tr>${cells}${showLink}</tr>`;
		})
		.join("");
	return `<table>${headerRow}<tbody>${bodyRows}</tbody></table>`;
}

function renderPager(
	slug: string,
	page: number,
	perPage: number,
	lastPage: number,
): string {
	const pp = encodeURIComponent(String(perPage));
	const prev =
		page > 1
			? `<a href="/admin/${slug}?page=${page - 1}&perPage=${pp}">« Prev</a>`
			: `<span class="st-disabled">« Prev</span>`;
	const next =
		page < lastPage
			? `<a href="/admin/${slug}?page=${page + 1}&perPage=${pp}">Next »</a>`
			: `<span class="st-disabled">Next »</span>`;
	const numbers = renderPageNumbers(slug, page, lastPage, pp);
	return `<div class="st-pager">${prev}${numbers}${next}</div>`;
}

function renderPageNumbers(
	slug: string,
	page: number,
	lastPage: number,
	pp: string,
): string {
	const link = (n: number): string =>
		n === page
			? `<strong>${n}</strong>`
			: `<a href="/admin/${slug}?page=${n}&perPage=${pp}">${n}</a>`;
	if (lastPage <= 7) {
		const parts: string[] = [];
		for (let i = 1; i <= lastPage; i++) parts.push(link(i));
		return parts.join("");
	}
	// Collapsed shape: 1 … current-1, current, current+1 … lastPage
	const parts: string[] = [link(1)];
	const start = Math.max(2, page - 1);
	const end = Math.min(lastPage - 1, page + 1);
	if (start > 2) parts.push(`<span class="st-ellipsis">…</span>`);
	for (let i = start; i <= end; i++) parts.push(link(i));
	if (end < lastPage - 1) parts.push(`<span class="st-ellipsis">…</span>`);
	parts.push(link(lastPage));
	return parts.join("");
}

function renderCaption(page: number, perPage: number, total: number): string {
	if (total === 0) return "";
	const start = (page - 1) * perPage + 1;
	const end = Math.min(page * perPage, total);
	return `<p class="st-caption">Showing ${start}–${end} of ${total}</p>`;
}
