/**
 * Uniform-consumption guard (Story 57.7, AC6): Station consumes `@c9up/rune`
 * the SAME way it consumes `@c9up/atlas` — a tolerant dynamic
 * `import("@c9up/rune")` whose module-not-found degrades to null (and, for a
 * write-capable admin, fails LOUD at boot). rune has no container alias, so —
 * unlike the warden/inker guards, which ban BOTH static and dynamic imports —
 * this guard bans ONLY the static VALUE form `import … from "@c9up/rune"`, while
 * allowing:
 *   - `import type … from "@c9up/rune"` (compile-erased, no runtime coupling), and
 *   - the tolerant dynamic `import("@c9up/rune")` (the sanctioned seam).
 *
 * A static value import would make the optional peer mandatory at module load
 * and break the degraded-host path. This walks `src/` (zero-dep recursive
 * readdir, mirroring `no-warden-static-import.test.ts`) and strips comments so
 * the JSDoc mentions of `@c9up/rune` don't trip the scan.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC_DIR = new URL("../../src/", import.meta.url);
const SRC_PATH = SRC_DIR.pathname;

// Any `from "@c9up/rune[/sub]"` — matches BOTH `import { schema }` and
// `import type { RuleChain }` (the `import type` case is filtered out below).
const RUNE_FROM = /\bfrom\s+["']@c9up\/rune(\/[^"']*)?["']/;
// A type-only import — allowed (compile-erased).
const RUNE_TYPE_ONLY = /\bimport\s+type\b/;

function walk(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) {
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

/** A static VALUE import of rune — the ONLY banned form. */
function isStaticValueImport(line: string): boolean {
	return RUNE_FROM.test(line) && !RUNE_TYPE_ONLY.test(line);
}

describe("station > consumes @c9up/rune via a tolerant dynamic import, never a static value import", () => {
	const files = walk(SRC_PATH);

	it("walks a non-trivial src tree (sanity — the scan isn't a no-op)", () => {
		expect(files.length).toBeGreaterThan(3);
	});

	for (const file of files) {
		it(`${file.replace(SRC_PATH, "src/")} has no static value import of @c9up/rune`, () => {
			const src = stripComments(readFileSync(file, "utf8"));
			const offenders: Array<{ line: number; text: string }> = [];
			const lines = src.split("\n");
			for (let i = 0; i < lines.length; i++) {
				const text = lines[i] ?? "";
				if (isStaticValueImport(text)) {
					offenders.push({ line: i + 1, text: text.trim() });
				}
			}
			expect(offenders, JSON.stringify(offenders, null, 2)).toEqual([]);
		});
	}

	it("the guard bans the value import but allows `import type` + dynamic (anti-tautology)", () => {
		const staticValue = 'import { schema, rules } from "@c9up/rune";';
		const typeOnly = 'import type { RuleChain } from "@c9up/rune";';
		const dynamic = 'const m = await import("@c9up/rune");';
		const proseMention = " * the schema/rules surface from @c9up/rune";
		// Banned:
		expect(isStaticValueImport(staticValue)).toBe(true);
		// Allowed (the sanctioned atlas-style seam):
		expect(isStaticValueImport(typeOnly)).toBe(false);
		expect(isStaticValueImport(dynamic)).toBe(false);
		// A bare prose mention (no `from`/import) must NOT match.
		expect(isStaticValueImport(proseMention)).toBe(false);
	});
});
