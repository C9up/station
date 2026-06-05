/**
 * Station-branded 404 for `GET /admin/<slug>/:id` where the row doesn't
 * exist. NOT used for unknown slugs (those fall through to Ream's
 * default 404 — see story spec D6).
 */

import type { Resource } from "../../types.js";
import { escapeHtml, safeHtml } from "../escape.js";
import { renderLayout } from "../layout.js";

export interface NotFoundPageInput {
	resource: Resource;
	id: string;
}

export function renderNotFoundPage(input: NotFoundPageInput): string {
	const { resource, id } = input;
	const slug = encodeURIComponent(resource.name);
	const body =
		`<h1>404 Not Found</h1>` +
		`<p>No ${escapeHtml(resource.label.toLowerCase())} with ID <code>${escapeHtml(id)}</code>.</p>` +
		`<a class="st-backlink" href="/admin/${slug}">← Back to ${escapeHtml(resource.label)}</a>`;
	return renderLayout({
		title: "Not Found",
		bodyHtml: safeHtml(body),
	});
}
