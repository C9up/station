/**
 * Test stand-in for the host's shared inker renderer — the `"inker"` container
 * alias `InkerProvider` binds in production. Backed by a REAL `@c9up/inker`
 * `Templates` engine, so tests exercise real named-disk mounting +
 * `station::template` resolution + auto-escaping.
 *
 * Since 57.3 it also registers the canonical `csrfField()` helper and threads
 * the per-request ctx `store` through an `AsyncLocalStorage` — mirroring
 * `InkerProvider` (buildCanonicalHelpers + `InkerRenderer.renderToString`'s
 * `als.run(ctx, …)`). This is MANDATORY: inker resolves helpers at PARSE time,
 * so `form.inker`/`login.inker` would raise `E_INKER_UNKNOWN_HELPER` even on the
 * `csrfEnabled=false` branch if `csrfField` were absent. The helper reads
 * `ctx.store.get("csrfToken")` and throws when the token is missing, exactly
 * like the production helper (`InkerProvider.ts:499-510`).
 *
 * Station mounts its own `templates/` as the `station` disk at `start()`, so
 * the default root here is never rendered from — it only has to be a valid
 * directory for the `Templates` constructor (the package's own `templates/`).
 *
 * Lives in `tests/` (not `src/`), so importing `@c9up/inker` here does NOT
 * violate the `no-inker-static-import` guard, which scans `src/` only.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { fileURLToPath } from "node:url";
import { type HelperFn, SafeString, Templates } from "@c9up/inker";

const DEFAULT_ROOT = fileURLToPath(
	new URL("../../templates/", import.meta.url),
);

/** The per-request ctx threaded through als so `csrfField()` reaches the token. */
interface RenderCtx {
	store?: { get(key: string): unknown };
}

export interface InkerRendererStub {
	mount(diskName: string, dir: string): void;
	renderToString(
		ctx: RenderCtx,
		name: string,
		data: Readonly<Record<string, unknown>>,
	): Promise<string>;
}

/** Mirror InkerProvider's attribute-context escaping of the token. */
function escapeAttr(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;")
		.replace(/`/g, "&#96;");
}

export function makeInkerRenderer(): InkerRendererStub {
	const als = new AsyncLocalStorage<RenderCtx>();
	const helpers = new Map<string, HelperFn>();
	helpers.set("csrfField", (): SafeString => {
		const token = als.getStore()?.store?.get("csrfToken");
		if (typeof token !== "string" || token.length === 0) {
			throw new Error(
				"[inker] csrfField() requires the @c9up/blackhole middleware with csrf enabled (csrfToken not found in ctx.store).",
			);
		}
		return new SafeString(
			`<input type="hidden" name="_csrf" value="${escapeAttr(token)}">`,
		);
	});
	const templates = new Templates({
		root: DEFAULT_ROOT,
		cacheMode: "never",
		helpers,
	});
	return {
		mount(diskName, dir) {
			templates.mount(diskName, dir);
		},
		renderToString(ctx, name, data) {
			return als.run(ctx, () => templates.render(name, data));
		},
	};
}
