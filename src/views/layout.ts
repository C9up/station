/**
 * Layout shell shared by every Station page (list / show / 404 in this
 * story; create / edit will join later). Pure string output so consumers
 * can `response.send(html)` directly without bundler glue.
 *
 * Inline CSS lives here rather than `/_assets/station/*` because Story
 * 54.2 ships zero assets — the route mount that serves a separate
 * stylesheet lands in 54.7 alongside the Warden + login plumbing. The
 * size budget (~80 lines, ~3 KB) keeps the inline approach cheaper than
 * an extra round-trip per page until then.
 */

import { escapeHtml, type SafeHtml } from "./escape.js";

/** ~80 LOC inline stylesheet. Dependency-free; no PostCSS, no Tailwind. */
export const STATION_INLINE_CSS = `
:root {
  color-scheme: light dark;
  --st-fg: #1f2937;
  --st-fg-muted: #6b7280;
  --st-bg: #ffffff;
  --st-bg-alt: #f9fafb;
  --st-border: #e5e7eb;
  --st-accent: #2563eb;
  --st-accent-hover: #1d4ed8;
  --st-danger: #b91c1c;
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
@media (prefers-color-scheme: dark) {
  :root {
    --st-fg: #e5e7eb;
    --st-fg-muted: #9ca3af;
    --st-bg: #0f172a;
    --st-bg-alt: #1e293b;
    --st-border: #334155;
    --st-accent: #60a5fa;
    --st-accent-hover: #93c5fd;
  }
}
body { margin: 0; color: var(--st-fg); background: var(--st-bg); }
main { max-width: 64rem; margin: 0 auto; padding: 2rem 1.5rem; }
h1 { font-size: 1.75rem; margin: 0 0 1.5rem; }
a { color: var(--st-accent); text-decoration: none; }
a:hover { color: var(--st-accent-hover); text-decoration: underline; }
table { width: 100%; border-collapse: collapse; margin-bottom: 1.5rem; }
th, td {
  text-align: left;
  padding: 0.5rem 0.75rem;
  border-bottom: 1px solid var(--st-border);
  vertical-align: top;
}
th { background: var(--st-bg-alt); font-weight: 600; }
tbody tr:hover { background: var(--st-bg-alt); }
.st-empty { color: var(--st-fg-muted); font-style: italic; }
.st-pager { display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; margin-bottom: 0.75rem; }
.st-pager a, .st-pager span { padding: 0.25rem 0.5rem; border-radius: 0.25rem; }
.st-pager a { border: 1px solid var(--st-border); }
.st-pager strong { padding: 0.25rem 0.5rem; background: var(--st-accent); color: var(--st-bg); border-radius: 0.25rem; }
.st-pager .st-disabled { color: var(--st-fg-muted); border: 1px solid var(--st-border); }
.st-pager .st-ellipsis { color: var(--st-fg-muted); }
.st-caption { color: var(--st-fg-muted); font-size: 0.875rem; }
dl { display: grid; grid-template-columns: max-content 1fr; gap: 0.5rem 1.5rem; }
dt { font-weight: 600; color: var(--st-fg-muted); }
dd { margin: 0; }
.st-backlink { display: inline-block; margin-top: 1.5rem; }
`.trim();

/**
 * Render the outer HTML shell. `bodyHtml` is a `SafeHtml` brand to make
 * the trust boundary explicit: callers must escape every dynamic value
 * inside the body, then wrap the final string via `safeHtml()`.
 */
export function renderLayout(input: {
	title: string;
	bodyHtml: SafeHtml;
}): string {
	const titleEscaped = escapeHtml(input.title);
	return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${titleEscaped} · Station</title>
  <style>${STATION_INLINE_CSS}</style>
</head>
<body>
  <main>${input.bodyHtml.html}</main>
</body>
</html>`;
}
