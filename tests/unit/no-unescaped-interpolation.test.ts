/**
 * Grep-ban over the rendered admin templates: no raw `{{{ expr }}}`
 * interpolation in `templates/**\/*.inker`.
 *
 * inker's double-brace `{{ }}` auto-escapes; the triple-brace `{{{ }}}`
 * is a raw HTML pass-through (`InterpRaw`) — a stored / reflected XSS
 * the moment a column value, slug, or caption reaches it. Axis A of
 * Epic 57 moved every HTML slot out of `src/views/**\/*.ts` and into
 * the inker templates, so this `.inker` ban is the sole "inker owns
 * escaping" contract Station enforces. inker treats `{{` as an
 * interpolation open anywhere, so a literal `{{{` scan matches its
 * lexer exactly.
 *
 * The test walks `templates/` manually (`fs.readdirSync` recursive) to
 * stay zero-dep — no `globby`, no `fast-glob`.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const TEMPLATES_DIR = new URL("../../templates/", import.meta.url);
const TEMPLATES_PATH = TEMPLATES_DIR.pathname;

function walkInker(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) {
			out.push(...walkInker(full));
		} else if (entry.endsWith(".inker")) {
			out.push(full);
		}
	}
	return out;
}

describe("station > templates > grep-ban: no raw {{{ }}} inker interpolation", () => {
	const files = walkInker(TEMPLATES_PATH);

	// Guard against a vacuous green: if the templates ever move or the
	// directory is emptied, `files === []` generates zero per-file `it()`
	// and the sole XSS contract would pass while protecting nothing.
	it("finds at least one .inker template to scan", () => {
		expect(files.length).toBeGreaterThan(0);
	});

	for (const file of files) {
		it(`${file.replace(TEMPLATES_PATH, "templates/")} contains no {{{ raw }}} interpolation`, () => {
			const src = readFileSync(file, "utf8");
			const offenders: Array<{ line: number; text: string }> = [];
			const lines = src.split("\n");
			for (let i = 0; i < lines.length; i++) {
				const text = lines[i] ?? "";
				if (text.includes("{{{")) {
					offenders.push({ line: i + 1, text: text.trim() });
				}
			}
			expect(offenders, JSON.stringify(offenders, null, 2)).toEqual([]);
		});
	}

	it("the raw-interpolation ban catches a fixture violation (anti-tautology)", () => {
		// A raw slot with a tainted path must trip the `{{{` check.
		const tainted = "<td>{{{ user.input }}}</td>";
		expect(tainted.includes("{{{")).toBe(true);
	});
});
