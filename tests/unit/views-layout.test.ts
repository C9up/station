import { describe, expect, it } from "vitest";
import { safeHtml } from "../../src/views/escape.js";
import { renderLayout, STATION_INLINE_CSS } from "../../src/views/layout.js";

describe("station > views > renderLayout", () => {
	it("HTML-escapes the title (prevents XSS via <title>)", () => {
		const html = renderLayout({
			title: "<script>alert(1)</script>",
			bodyHtml: safeHtml(""),
		});
		expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt; · Station");
		expect(html).not.toContain("<script>alert(1)</script>");
	});

	it("injects the SafeHtml body raw (callers own the inside-escape contract)", () => {
		const html = renderLayout({
			title: "Users",
			// Body already escaped by the caller; the layout MUST splice it in
			// verbatim, otherwise list/show would have to be re-escaped here.
			bodyHtml: safeHtml(
				"<table><tr><td>&lt;already escaped&gt;</td></tr></table>",
			),
		});
		expect(html).toContain(
			"<table><tr><td>&lt;already escaped&gt;</td></tr></table>",
		);
	});

	it("embeds the inline stylesheet so the page renders without an asset round-trip", () => {
		const html = renderLayout({ title: "x", bodyHtml: safeHtml("") });
		expect(html).toContain("<style>");
		expect(html).toContain(STATION_INLINE_CSS);
		// No external stylesheet link — story 54.2 ships zero assets.
		expect(html).not.toContain('<link rel="stylesheet"');
	});

	it("emits a complete document (doctype + lang + viewport + UTF-8)", () => {
		const html = renderLayout({ title: "x", bodyHtml: safeHtml("") });
		expect(html.startsWith("<!doctype html>")).toBe(true);
		expect(html).toContain('<html lang="en">');
		expect(html).toContain('<meta charset="utf-8">');
		expect(html).toContain(
			'<meta name="viewport" content="width=device-width,initial-scale=1">',
		);
	});
});
