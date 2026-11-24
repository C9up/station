/**
 * The writable-body pipeline the provider's create and edit handlers run: the
 * `@c9up/rune` schema derived from an entity's column metadata, and the body
 * validation against it. Internal: no `exports` entry of the package reaches
 * this module.
 */

import type { ColumnMetadata } from "@c9up/atlas";
import { isFrameworkManaged } from "./columns.js";
import type { Resource } from "./types.js";

// ── @c9up/rune structural surface (57.7) ───────────────────────────────────
// Station consumes rune EXACTLY like atlas: a tolerant dynamic
// `import("@c9up/rune")` (never a static value import — banned by
// `tests/unit/no-rune-static-import.test.ts`). The runtime object is typed by
// these LOCAL structural interfaces (like `AtlasModule` / `StationRepository`),
// so Station couples to rune's *shape*, not its generic types — zero
// `import ... from "@c9up/rune"`, `import type` included, keeps the schema
// derivation tsc-safe and fully decoupled.

/** A rune `RuleChain` — only the builders the derivation calls. */
interface RuneRuleChain {
	optional(): RuneRuleChain;
	nullable(): RuneRuleChain;
	parse(fn: (value: unknown) => unknown): RuneRuleChain;
}

/** rune's `rules` factory — the constructors Station maps columns to. */
interface RuneRules {
	string(): RuneRuleChain;
	number(): RuneRuleChain;
	boolean(): RuneRuleChain;
	/** Type-free chain — a structural (`json`/`jsonb`) column that must accept objects/arrays. */
	any(): RuneRuleChain;
}

/** A single rune `ValidationError`. */
export interface RuneValidationError {
	field: string;
	rule: string;
	message: string;
	index?: number;
	meta?: Record<string, unknown>;
}

/** Result of `schema.validateResult()` — synchronous, never throws. */
type RuneValidationResult =
	| {
			valid: true;
			errors: ReadonlyArray<RuneValidationError>;
			data: Record<string, unknown>;
	  }
	| {
			valid: false;
			errors: ReadonlyArray<RuneValidationError>;
			data?: undefined;
	  };

/**
 * A built rune schema — only the result-based check is consumed.
 *
 * `validateResult`, NOT `validate`: rune reserves `validate()` for the
 * contract (async, throwing). Reading `.valid` off a Promise gives `undefined`,
 * so keeping the old name would have made every admin write fail closed with an
 * empty error list.
 */
export interface RuneSchema {
	validateResult(data: unknown): RuneValidationResult;
}

/** Lazy-imported `@c9up/rune` value surface (mirror `AtlasModule`). */
export interface RuneModule {
	schema(fields: Record<string, RuneRuleChain>): RuneSchema;
	rules: RuneRules;
}

/**
 * Column `type` strings mapped to a numeric rune rule (mirrors form.ts input
 * inference). `bigint` is deliberately EXCLUDED: coercing it through `Number()`
 * silently loses precision above `Number.MAX_SAFE_INTEGER`, so a bigint column
 * validates as a string (its exact submitted digits reach atlas intact).
 */
const NUMBER_COLUMN_TYPES: ReadonlySet<string> = new Set(["integer", "number"]);

/**
 * Structural column `type` strings — validated with `rules.any()` so a JSON/XHR
 * client can submit an object/array (a `rules.string()` would reject it, a
 * regression vs. the pre-57.7 pass-through `filterWritableBody`).
 */
const JSON_COLUMN_TYPES: ReadonlySet<string> = new Set(["json", "jsonb"]);

/**
 * True when at least one resource mounts a write action that maps a request
 * body onto columns (create / edit). `destroy` needs no body validation. This
 * is the AC7 predicate: it decides whether `@c9up/rune` is REQUIRED at boot.
 */
export function resourcesNeedValidation(
	resources: ReadonlyArray<Resource>,
): boolean {
	return resources.some(
		(r) => r.actions.includes("create") || r.actions.includes("edit"),
	);
}

/**
 * Derive a `@c9up/rune` validation schema (57.7) from an entity's writable
 * column metadata — the structural replacement for the hand-rolled
 * `filterWritableBody`. The mass-assignment guarantee is now INHERENT:
 * `schema.validateResult()` returns only the keys of the editable columns it
 * was given, so any other body key — an unknown one, a column outside the
 * allow-list, the PK, a timestamp — is dropped automatically.
 *
 * Excluded, exactly as the old guard did: the primary key, framework-managed
 * timestamps (both the Lucid-style `autoManaged` flag AND the `created_at /
 * updated_at / deleted_at` name convention) — plus, new in 57.7, relations and
 * the soft-delete column (`excludedProps`). Metadata is read column-by-column,
 * NEVER `in` on an instance (`@Column() declare` makes `in` always false —
 * mirror `BaseRepository.#hydrate`).
 *
 * Per-column rule mapping tolerates the form-post wire shape, where every
 * value arrives as a string: booleans `.parse(isCheckedValue)`, numbers
 * `.parse` string→Number (NaN falls through to a type error), everything else
 * `rules.string()`. The explicit `.parse` is deliberate even though rune now
 * coerces both itself — a checkbox posts the values IT chooses (`isCheckedValue`
 * is the column's own truthy spelling), which is a wider set than any
 * general-purpose coercion should accept. `.parse`/`.optional`/`.nullable`
 * force rune's TS path, so no native `.node` is touched.
 *
 * Returns the built schema plus the set of boolean columns — the handler
 * default-fills an ABSENT boolean key to `false` before validating (an
 * unchecked checkbox submits nothing; this preserves the old edit-clears-box
 * behaviour). `columns` is the editable allow-list; framework-owned columns
 * are dropped here too, so no caller can make them writable. `updateSchema`
 * differs only for `writeOnly` columns, which an edit may leave out.
 */
export function deriveWritableSchema(
	columns: ReadonlyArray<ColumnMetadata>,
	pkColumn: string,
	autoManaged: ReadonlySet<string>,
	excludedProps: ReadonlySet<string>,
	rune: RuneModule,
	writeOnly: ReadonlySet<string> = new Set(),
): {
	schema: RuneSchema;
	updateSchema: RuneSchema;
	booleanKeys: ReadonlySet<string>;
} {
	const fields: Record<string, RuneRuleChain> = {};
	const updateFields: Record<string, RuneRuleChain> = {};
	const booleanKeys = new Set<string>();
	for (const c of columns) {
		if (isFrameworkManaged(c, pkColumn, autoManaged, excludedProps)) continue;
		const type = (c.type ?? "").toString().toLowerCase();
		if (type === "boolean") {
			// Checkbox: the handler pre-fills an absent key to `false`, so every
			// boolean is always present here → required, no `.optional()`.
			booleanKeys.add(c.propertyKey);
			fields[c.propertyKey] = rune.rules.boolean().parse(isCheckedValue);
			updateFields[c.propertyKey] = rune.rules.boolean().parse(isCheckedValue);
			continue;
		}
		fields[c.propertyKey] = columnChain(c, type, rune, false);
		updateFields[c.propertyKey] = columnChain(
			c,
			type,
			rune,
			writeOnly.has(c.propertyKey),
		);
	}
	return {
		schema: rune.schema(fields),
		updateSchema: rune.schema(updateFields),
		booleanKeys,
	};
}

/**
 * The rule for one non-boolean column. A column is required iff the model
 * declares neither nullability nor a default — unless `keepable`: an edit may
 * omit a write-only column to keep its stored value. DB-side defaults
 * (serial, `DEFAULT`) are invisible to metadata (documented residual
 * limitation); the PK, the common serial case, is never editable.
 */
function columnChain(
	c: ColumnMetadata,
	type: string,
	rune: RuneModule,
	keepable: boolean,
): RuneRuleChain {
	const required = !keepable && c.nullable !== true && c.default === undefined;
	let chain: RuneRuleChain = NUMBER_COLUMN_TYPES.has(type)
		? rune.rules.number().parse(parseNumeric)
		: JSON_COLUMN_TYPES.has(type)
			? rune.rules.any()
			: rune.rules.string();
	if (!required) {
		chain = chain.optional();
		if (c.nullable === true) chain = chain.nullable();
	}
	return chain;
}

/**
 * Validate a request body against a derived schema (57.7). Default-fills any
 * ABSENT boolean column to `false` first (unchecked checkbox = no submission),
 * preserving the old `filterWritableBody` checkbox semantics, then runs rune's
 * synchronous, never-throwing `validateResult()`. On success `result.data` holds only
 * declared-column keys (mass-assignment inherent). A blank `writeOnly` value counts as not
 * submitted: the form never pre-fills those, so blank means "unchanged".
 */
export function validateWritableBody(
	schema: RuneSchema,
	booleanKeys: ReadonlySet<string>,
	body: unknown,
	writeOnly: ReadonlySet<string> = new Set(),
): RuneValidationResult {
	// A payload that is not an object (a JSON array, a scalar, null) goes to
	// rune as it is, so the failure is reported on the root rather than as
	// per-field errors against an empty object standing in for it.
	if (!isPlainRecord(body)) return schema.validateResult(body);
	const input: Record<string, unknown> = { ...body };
	for (const key of writeOnly) {
		if (input[key] === "") delete input[key];
	}
	for (const key of booleanKeys) {
		if (!(key in input)) input[key] = false;
	}
	return schema.validateResult(input);
}

/**
 * Form-post number coercion: string→Number, NaN falls through to a type error.
 * `null`/`undefined` pass through untouched so rune's optional/nullable handling
 * applies (never `Number(null) === 0`), and a blank/whitespace-only string —
 * a cleared optional field — becomes `null` (treated as absent) rather than a
 * fabricated `0`.
 */
function parseNumeric(value: unknown): unknown {
	if (value === null || value === undefined) return value;
	if (typeof value === "string") {
		const trimmed = value.trim();
		if (trimmed === "") return null;
		const n = Number(trimmed);
		return Number.isNaN(n) ? value : n;
	}
	const n = Number(value);
	return Number.isNaN(n) ? value : n;
}

/**
 * A checkbox/boolean field is true only for its checked submissions. Duplicate
 * keys (a hidden `0` companion + the checkbox `1`) arrive as an array — the box
 * is checked if ANY submitted value is a checked token (the checkbox wins).
 */
function isCheckedValue(value: unknown): boolean {
	if (Array.isArray(value)) return value.some(isCheckedValue);
	return value === true || value === "1" || value === "on" || value === "true";
}

/** An object that is neither null nor an array. */
export function isPlainRecord(
	value: unknown,
): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
