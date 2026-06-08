/**
 * Uniform-consumption guard (Story 56.5, AC1): Station is one of Ream's
 * integration packages — it adds an admin surface and consumes
 * `@c9up/ream`, `@c9up/atlas`, and (56.5) `@c9up/warden`. It is NOT a
 * standalone leaf. What it MUST stay is uniform in HOW it consumes them:
 * through the IoC container (`container.resolve(...)`) + optional peers +
 * tolerant dynamic imports — never a static `import … from "@c9up/warden"`.
 *
 * That uniformity is what keeps the optional-peer / degraded-host path
 * working: a host without Warden wired runs the admin in dev-preview
 * open mode (same shape as a host without Atlas). A static warden import
 * would make the peer mandatory at module load and break that path —
 * and it would diverge from how ream/atlas are consumed.
 *
 * This walks `src/` (zero-dep recursive readdir, mirroring
 * `no-unescaped-interpolation.test.ts`), strips comments so the JSDoc
 * mentions of `@c9up/warden` don't trip the scan, and flags any real
 * static-or-dynamic import.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC_DIR = new URL("../../src/", import.meta.url);
const SRC_PATH = SRC_DIR.pathname;

// Real import of the warden package — static `from "@c9up/warden[/sub]"`
// or dynamic `import("@c9up/warden[/sub]")`. Comments are stripped first,
// so prose mentions of the package name in JSDoc never match.
const WARDEN_STATIC_IMPORT = /\bfrom\s+["']@c9up\/warden(\/[^"']*)?["']/;
const WARDEN_DYNAMIC_IMPORT =
	/\bimport\s*\(\s*["']@c9up\/warden(\/[^"']*)?["']/;

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

describe("station > consumes @c9up/warden via the container, never a static import", () => {
	const files = walk(SRC_PATH);

	it("walks a non-trivial src tree (sanity — the scan isn't a no-op)", () => {
		expect(files.length).toBeGreaterThan(3);
	});

	for (const file of files) {
		it(`${file.replace(SRC_PATH, "src/")} has no import of @c9up/warden`, () => {
			const src = stripComments(readFileSync(file, "utf8"));
			const offenders: Array<{ line: number; text: string }> = [];
			const lines = src.split("\n");
			for (let i = 0; i < lines.length; i++) {
				const text = lines[i] ?? "";
				if (
					WARDEN_STATIC_IMPORT.test(text) ||
					WARDEN_DYNAMIC_IMPORT.test(text)
				) {
					offenders.push({ line: i + 1, text: text.trim() });
				}
			}
			expect(offenders, JSON.stringify(offenders, null, 2)).toEqual([]);
		});
	}

	it("the guard catches a fixture violation (anti-tautology)", () => {
		const staticImport = 'import { AuthManager } from "@c9up/warden";';
		const dynamicImport = 'const m = await import("@c9up/warden/provider");';
		const proseMention = " * the AuthManager surface from @c9up/warden";
		expect(WARDEN_STATIC_IMPORT.test(staticImport)).toBe(true);
		expect(WARDEN_DYNAMIC_IMPORT.test(dynamicImport)).toBe(true);
		// A bare prose mention (no import/from keyword) must NOT match.
		expect(WARDEN_STATIC_IMPORT.test(proseMention)).toBe(false);
		expect(WARDEN_DYNAMIC_IMPORT.test(proseMention)).toBe(false);
	});
});
