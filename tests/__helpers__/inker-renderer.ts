/**
 * Test stand-in for the host's shared inker renderer — the `"inker"` container
 * alias `InkerProvider` binds in production. Backed by a REAL `@c9up/inker`
 * `Templates` engine, so tests exercise real named-disk mounting +
 * `station::template` resolution + auto-escaping. The production renderer adds
 * an AsyncLocalStorage ctx for the canonical helpers (t/csrfField/url/asset);
 * Station's 404 uses none, so this stand-in ignores the ctx.
 *
 * Station mounts its own `templates/` as the `station` disk at `start()`, so
 * the default root here is never rendered from — it only has to be a valid
 * directory for the `Templates` constructor (the package's own `templates/`).
 *
 * Lives in `tests/` (not `src/`), so importing `@c9up/inker` here does NOT
 * violate the `no-inker-static-import` guard, which scans `src/` only.
 */
import { fileURLToPath } from "node:url";
import { Templates } from "@c9up/inker";

const DEFAULT_ROOT = fileURLToPath(
	new URL("../../templates/", import.meta.url),
);

export interface InkerRendererStub {
	mount(diskName: string, dir: string): void;
	renderToString(
		ctx: object,
		name: string,
		data: Readonly<Record<string, unknown>>,
	): Promise<string>;
}

export function makeInkerRenderer(): InkerRendererStub {
	const templates = new Templates({ root: DEFAULT_ROOT, cacheMode: "never" });
	return {
		mount(diskName, dir) {
			templates.mount(diskName, dir);
		},
		renderToString(_ctx, name, data) {
			return templates.render(name, data);
		},
	};
}
