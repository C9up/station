/**
 * Uniform-consumption guard (Story 57.1, AC1/D5): Station renders its admin
 * views through `@c9up/inker`, but — exactly like `@c9up/warden` — it consumes
 * the engine PURELY through the IoC container. Following the AdonisJS
 * package-views pattern, Station resolves the shared `"inker"` renderer the
 * host's `InkerProvider` binds, mounts its package `templates/` as a named
 * disk (`mount("station", dir)`), and renders `station::template`. It NEVER
 * imports `@c9up/inker` — neither a static `import … from "@c9up/inker"` nor a
 * dynamic `import("@c9up/inker")` — anywhere in `src/`.
 *
 * Banning BOTH forms (like `no-warden-static-import.test.ts`) is what keeps the
 * optional-peer contract honest: a host that registers no admin surface never
 * has to install inker, and Station never hard-loads it at module load. Any
 * import would make the peer mandatory at import time and diverge from how
 * ream/atlas/warden are consumed.
 *
 * Walks `src/` (zero-dep recursive readdir, mirroring
 * `no-unescaped-interpolation.test.ts`), strips comments so JSDoc mentions of
 * `@c9up/inker` don't trip the scan, and flags any static OR dynamic import.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC_DIR = new URL("../../src/", import.meta.url);
// fileURLToPath (not `.pathname`) so a checkout whose absolute path contains a
// space or reserved char decodes correctly — mirrors StationProvider's own use.
const SRC_PATH = fileURLToPath(SRC_DIR);

// Real import of the inker package — static `from "@c9up/inker[/sub]"` or
// dynamic `import("@c9up/inker[/sub]")`. Comments are stripped first, so prose
// mentions of the package name in JSDoc never match.
const INKER_STATIC_IMPORT = /\bfrom\s+["']@c9up\/inker(\/[^"']*)?["']/;
const INKER_DYNAMIC_IMPORT = /\bimport\s*\(\s*["']@c9up\/inker(\/[^"']*)?["']/;

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

describe("station > consumes @c9up/inker via the container, never an import", () => {
	const files = walk(SRC_PATH);

	it("walks a non-trivial src tree (sanity — the scan isn't a no-op)", () => {
		expect(files.length).toBeGreaterThan(3);
	});

	for (const file of files) {
		it(`${file.replace(SRC_PATH, "src/")} has no import of @c9up/inker`, () => {
			const src = stripComments(readFileSync(file, "utf8"));
			const offenders: Array<{ line: number; text: string }> = [];
			const lines = src.split("\n");
			for (let i = 0; i < lines.length; i++) {
				const text = lines[i] ?? "";
				if (INKER_STATIC_IMPORT.test(text) || INKER_DYNAMIC_IMPORT.test(text)) {
					offenders.push({ line: i + 1, text: text.trim() });
				}
			}
			expect(offenders, JSON.stringify(offenders, null, 2)).toEqual([]);
		});
	}

	it("the guard catches both static and dynamic fixtures (anti-tautology)", () => {
		const staticImport = 'import { Templates } from "@c9up/inker";';
		const dynamicImport = 'const m = await import("@c9up/inker/provider");';
		const proseMention =
			" * render through the shared renderer from @c9up/inker";
		expect(INKER_STATIC_IMPORT.test(staticImport)).toBe(true);
		expect(INKER_DYNAMIC_IMPORT.test(dynamicImport)).toBe(true);
		// A bare prose mention (no import/from keyword) must NOT match.
		expect(INKER_STATIC_IMPORT.test(proseMention)).toBe(false);
		expect(INKER_DYNAMIC_IMPORT.test(proseMention)).toBe(false);
	});
});
