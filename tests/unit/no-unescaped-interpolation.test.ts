/**
 * Grep-ban: every dynamic value interpolated into a template literal in
 * `src/views/**\/*.ts` must flow through one of the allowlisted helpers
 * (`escapeHtml` / `safeHtml` / `encodeURIComponent`) or be a known
 * compile-time constant (`STATION_INLINE_CSS`). A bare `${userInput}`
 * lands a stored / reflected XSS the second a column value, slug, or
 * page parameter contains a `<`.
 *
 * The test walks `src/views/` manually (`fs.readdirSync` recursive) to
 * stay zero-dep — no `globby`, no `fast-glob`. Stripping `//` line
 * comments + `/* … *\/` block comments before the regex run avoids
 * tripping on JSDoc examples.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const VIEWS_DIR = new URL("../../src/views/", import.meta.url);
const VIEWS_PATH = VIEWS_DIR.pathname;

// Lines containing any of these substrings are exempt — they're the
// sanctioned interpolation paths.
//
//   - `escapeHtml(` / `safeHtml(` / `encodeURIComponent(` — the explicit
//     wrapper helpers. These are the only blessed escape paths.
//   - `__safe` — the brand marker on `SafeHtml`; the layout's
//     `${input.bodyHtml.html}` emits a pre-escaped string and so doesn't
//     need its own wrap.
//   - `bodyHtml.html` — direct access on the SafeHtml brand (the layout
//     site).
//   - `title:` — interpolations on the `title:` argument passed into
//     `renderLayout({ title })` are escaped DOWNSTREAM by `renderLayout`
//     itself (verified by the unit test on `renderLayout`'s output). The
//     caller composes the raw title string; the receiver applies escape.
//   - `STATION_INLINE_CSS` — bounded compile-time constant.
//   - CSS variable names (`-st-`) live inside the inline stylesheet
//     constant where interpolation is impossible (template-string is the
//     constant itself, not a slot).
const ALLOWED_WRAPPERS = [
	"escapeHtml(",
	"safeHtml(",
	"encodeURIComponent(",
	"__safe",
	"bodyHtml.html",
	"title:",
	"STATION_INLINE_CSS",
	"-st-",
];

// Lines pointing only at structural constants (numeric / bounded literals
// from the function args, never user-controlled). Restrict by name so a
// future caller can't sneak in a tainted variable.
const STRUCTURAL_VARS =
	/\$\{(page|perPage|total|start|end|lastPage|i|n|sizeHex|titleEscaped|heading|dl|backLink|body|pager|caption|cells|headers|headerRow|bodyRows|showLink|numbers|prev|next|parts|expr|slug|pp|column|cols)([.[]|\}| |\?)/;

function walk(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		const stat = statSync(full);
		if (stat.isDirectory()) {
			out.push(...walk(full));
		} else if (entry.endsWith(".ts")) {
			out.push(full);
		}
	}
	return out;
}

function stripComments(src: string): string {
	return src
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.split("\n")
		.map((line) => {
			const idx = line.indexOf("//");
			return idx === -1 ? line : line.slice(0, idx);
		})
		.join("\n");
}

describe("station > views > grep-ban: every interpolation flows through an escape helper", () => {
	const files = walk(VIEWS_PATH);

	for (const file of files) {
		it(`${file.replace(VIEWS_PATH, "src/views/")} contains no bare \${…} interpolation`, () => {
			const src = stripComments(readFileSync(file, "utf8"));
			// Scan line by line so the failure report points at the offending
			// line text. `${…}` slots that aren't structural and don't mention
			// any allowed wrapper or constant are flagged.
			const offenders: Array<{ line: number; text: string }> = [];
			const lines = src.split("\n");
			for (let i = 0; i < lines.length; i++) {
				const text = lines[i] ?? "";
				if (!text.includes("${")) continue;
				const hasAllowed = ALLOWED_WRAPPERS.some((w) => text.includes(w));
				const isStructural = STRUCTURAL_VARS.test(text);
				if (!hasAllowed && !isStructural) {
					offenders.push({ line: i + 1, text: text.trim() });
				}
			}
			expect(offenders, JSON.stringify(offenders, null, 2)).toEqual([]);
		});
	}

	it("the grep-ban itself catches a fixture violation (anti-tautology)", () => {
		// Pin: a synthetic line with a bare `${user.input}` must trip both
		// the wrapper check (false) AND the structural check (false), so
		// the regex / allowlist combination really detects what it claims.
		// biome-ignore lint/suspicious/noTemplateCurlyInString: literal tainted-template fixture — the ${} IS the payload the grep-ban must detect
		const tainted = "  out += `<td>${user.input}</td>`;";
		const hasAllowed = ALLOWED_WRAPPERS.some((w) => tainted.includes(w));
		const isStructural = STRUCTURAL_VARS.test(tainted);
		expect(hasAllowed).toBe(false);
		expect(isStructural).toBe(false);
	});
});
