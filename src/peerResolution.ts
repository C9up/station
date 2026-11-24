/**
 * How the provider tells an absent optional peer (`@c9up/atlas`,
 * `@c9up/rune`) from a broken one. Internal: no `exports` entry of the package
 * reaches this module.
 */

/** Node's ERR_MODULE_NOT_FOUND surfaces on an Error subclass with `code`. */
export function isModuleNotFound(err: unknown): boolean {
	if (err === null || typeof err !== "object" || !("code" in err)) return false;
	const { code } = err;
	return code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND";
}

/**
 * Is THIS package the one that is missing?
 *
 * The code alone does not say. `@c9up/atlas` installed but missing one of its
 * OWN dependencies raises the same `ERR_MODULE_NOT_FOUND`, and station read
 * that as "atlas is absent" and disabled the admin — silently, which is the
 * whole point of the degraded-host path and exactly wrong here: the peer IS
 * there and something inside it is broken, which the operator has to be told.
 *
 * Node distinguishes the two in the message it writes:
 *
 *   Cannot find package '@c9up/atlas' imported from …   ← the peer is absent
 *   Cannot find module '/…/node_modules/@c9up/atlas/…'  ← something inside it
 *
 * A bare-specifier miss names the PACKAGE; a miss inside an installed package
 * names a path. Anything that is not unmistakably the first is re-thrown.
 */
export function isPackageMissing(err: unknown, specifier: string): boolean {
	if (!isModuleNotFound(err)) return false;
	const message = err instanceof Error ? err.message : String(err);
	// The exact forms Node emits for a bare specifier that resolves to nothing.
	return (
		message.includes(`Cannot find package '${specifier}'`) ||
		message.includes(`Cannot find module '${specifier}'`) ||
		// The CJS wording, kept for a host that transpiles.
		message.includes(`Cannot find module "${specifier}"`)
	);
}
