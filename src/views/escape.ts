/**
 * HTML-escape helpers for Station's hand-rolled view layer.
 *
 * Every dynamic value interpolated into a `${…}` slot in a view template
 * MUST flow through `escapeHtml()`. The lint sweep at
 * `tests/unit/no-unescaped-interpolation.test.ts` enforces this on a
 * grep-pass over `src/views/**` so a missing wrap surfaces as a failing
 * test rather than a stored-XSS bug.
 *
 * `safeHtml()` is the escape hatch for pre-escaped fragments that views
 * compose (e.g., the rendered body the layout helper splices into its
 * shell). The branded shape (`{ readonly __safe: true; readonly html }`)
 * makes the boundary explicit and lets the lint sweep skip lines that
 * mention `__safe` as the only legitimate raw-HTML carrier.
 */

const ESCAPE_MAP: Readonly<Record<string, string>> = Object.freeze({
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
	'"': "&quot;",
	"'": "&#39;",
});

/** Escape a value for safe interpolation into HTML text or attribute content. */
export function escapeHtml(value: unknown): string {
	if (value === null || value === undefined) return "";
	const str = typeof value === "string" ? value : String(value);
	return str.replace(/[&<>"']/g, (ch) => ESCAPE_MAP[ch] ?? ch);
}

/**
 * Branded wrapper marking a string as already HTML-escaped (or
 * deliberately raw, e.g., the inline CSS block in the layout). The
 * lint sweep that bans bare `${…}` interpolations excludes lines
 * containing `__safe`.
 */
export interface SafeHtml {
	readonly __safe: true;
	readonly html: string;
}

/** Mark a string as pre-escaped / deliberately raw HTML. */
export function safeHtml(html: string): SafeHtml {
	return Object.freeze({ __safe: true as const, html });
}
