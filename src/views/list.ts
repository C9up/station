/**
 * `GET /admin/<slug>` — paginated list view.
 *
 * Pure `(input) => ListViewModel` builder. It precomputes everything the
 * inker `{{ }}` grammar cannot express — `encodeURIComponent` on URL
 * components (inker only HTML-escapes), the pager-collapse shape, the
 * caption bounds, and each row flattened to pre-stringified `cells` — and
 * hands it to `templates/list.inker`, which iterates and interpolates.
 * inker owns the HTML-escaping (the retired `escape.ts` no longer runs here).
 */

import type { ColumnMetadata } from "@c9up/atlas";
import type { Resource } from "../types.js";

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

/** A pager step (prev / next) — an anchor unless it is the edge (disabled). */
export interface ListPagerStep {
	href: string;
	disabled: boolean;
}

/** A numbered pager slot, or an ellipsis gap when `isEllipsis`. */
export interface ListPagerPage {
	n: number;
	href: string;
	isCurrent: boolean;
	isEllipsis: boolean;
}

/** A single data row: pre-stringified cells + the precomputed Show href. */
export interface ListRow {
	cells: string[];
	showHref: string;
}

// A `type` alias (not `interface`) so the view-model carries an implicit
// index signature and stays assignable to the renderer's
// `Readonly<Record<string, unknown>>` data param without a cast.
export type ListViewModel = {
	title: string;
	heading: string;
	labelLower: string;
	empty: boolean;
	columns: string[];
	rows: ListRow[];
	pager: {
		prev: ListPagerStep;
		next: ListPagerStep;
		pages: ListPagerPage[];
	};
	caption: { show: boolean; start: number; end: number; total: number };
};

export function buildListViewModel(input: ListPageInput): ListViewModel {
	const { resource, rows, columns, pkColumn, page, perPage, total, lastPage } =
		input;
	const slug = encodeURIComponent(resource.name);
	const columnKeys = columns.map((c) => c.propertyKey);
	return {
		title: resource.label,
		heading: resource.label,
		labelLower: resource.label.toLowerCase(),
		empty: rows.length === 0,
		columns: columnKeys,
		rows: rows.map((row) => ({
			cells: columns.map((c) => stringifyCell(row[c.propertyKey])),
			showHref: `/admin/${slug}/${encodeURIComponent(String(row[pkColumn] ?? ""))}`,
		})),
		pager: buildPager(slug, page, perPage, lastPage),
		caption: buildCaption(page, perPage, total),
	};
}

/** Match the retired escaper's `null | undefined` → `""` behaviour. */
function stringifyCell(value: unknown): string {
	return value === null || value === undefined ? "" : String(value);
}

function buildPager(
	slug: string,
	page: number,
	perPage: number,
	lastPage: number,
): ListViewModel["pager"] {
	const pp = encodeURIComponent(String(perPage));
	const href = (n: number): string => `/admin/${slug}?page=${n}&perPage=${pp}`;
	return {
		prev: { href: page > 1 ? href(page - 1) : "", disabled: page <= 1 },
		next: {
			href: page < lastPage ? href(page + 1) : "",
			disabled: page >= lastPage,
		},
		pages: buildPageNumbers(slug, page, lastPage, pp),
	};
}

function buildPageNumbers(
	slug: string,
	page: number,
	lastPage: number,
	pp: string,
): ListPagerPage[] {
	const href = (n: number): string => `/admin/${slug}?page=${n}&perPage=${pp}`;
	const numbered = (n: number): ListPagerPage => ({
		n,
		href: href(n),
		isCurrent: n === page,
		isEllipsis: false,
	});
	const ellipsis: ListPagerPage = {
		n: 0,
		href: "",
		isCurrent: false,
		isEllipsis: true,
	};
	if (lastPage <= 7) {
		const parts: ListPagerPage[] = [];
		for (let i = 1; i <= lastPage; i++) parts.push(numbered(i));
		return parts;
	}
	// Collapsed shape: 1 … current-1, current, current+1 … lastPage
	const parts: ListPagerPage[] = [numbered(1)];
	const start = Math.max(2, page - 1);
	const end = Math.min(lastPage - 1, page + 1);
	if (start > 2) parts.push(ellipsis);
	for (let i = start; i <= end; i++) parts.push(numbered(i));
	if (end < lastPage - 1) parts.push(ellipsis);
	parts.push(numbered(lastPage));
	return parts;
}

function buildCaption(
	page: number,
	perPage: number,
	total: number,
): ListViewModel["caption"] {
	if (total === 0) return { show: false, start: 0, end: 0, total };
	return {
		show: true,
		start: (page - 1) * perPage + 1,
		end: Math.min(page * perPage, total),
		total,
	};
}
