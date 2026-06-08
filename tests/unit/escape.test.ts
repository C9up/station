import { describe, expect, it } from "vitest";
import { escapeHtml, safeHtml } from "../../src/views/escape.js";

describe("station > views > escapeHtml", () => {
	it("escapes the five HTML-sensitive characters", () => {
		expect(escapeHtml("&<>\"'")).toBe("&amp;&lt;&gt;&quot;&#39;");
	});

	it("returns an empty string for null and undefined (no `null` / `undefined` literal leak)", () => {
		expect(escapeHtml(null)).toBe("");
		expect(escapeHtml(undefined)).toBe("");
	});

	it("coerces non-string inputs via String() and escapes the result", () => {
		expect(escapeHtml(42)).toBe("42");
		expect(escapeHtml(true)).toBe("true");
		// `String(obj)` yields `[object Object]` — no special chars, but
		// proves the coercion path runs.
		expect(escapeHtml({})).toBe("[object Object]");
		// `Date` coercion — pins the `String(value)` branch (AC14). A
		// future change that swapped `String()` for `JSON.stringify()`
		// would silently break this case (Date.prototype.toJSON returns an
		// ISO string wrapped in quotes), so this assertion is the canary.
		const d = new Date(Date.UTC(2026, 0, 15, 12, 0, 0));
		expect(escapeHtml(d)).toBe(String(d));
	});

	it("does NOT double-escape (single pass via charset replace)", () => {
		// `escapeHtml('<')` → `&lt;`. Re-feeding that back must escape the
		// `&` again only — not re-interpret `&lt;` as a sequence.
		expect(escapeHtml(escapeHtml("<"))).toBe("&amp;lt;");
	});

	it("leaves benign content untouched", () => {
		expect(escapeHtml("hello world 42")).toBe("hello world 42");
	});
});

describe("station > views > safeHtml", () => {
	it("brands the wrapped string as pre-escaped and is frozen", () => {
		const wrapped = safeHtml("<p>already escaped</p>");
		expect(wrapped.__safe).toBe(true);
		expect(wrapped.html).toBe("<p>already escaped</p>");
		expect(Object.isFrozen(wrapped)).toBe(true);
	});
});
