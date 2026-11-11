/**
 * StationProvider — Ream provider that wires Station's `ResourceRegistry`
 * into the host container and mounts the list + show routes for every
 * registered resource.
 *
 * Story 54.7 EXTENDS this provider with Warden integration (login
 * surface + `/_assets/station/*` mount). The class shape and lifecycle
 * stay; only `start()` grows.
 *
 * Mirror of `packages/aurora/src/AuroraProvider.ts` — register binds a
 * singleton + sets the `services/main` proxy backing instance, start
 * dynamically imports BOTH `@c9up/ream/services/router` AND `@c9up/atlas`
 * inside try/catch so non-Ream hosts AND Station-without-Atlas consumers
 * are silently tolerated. Once both modules resolve, the per-resource
 * repository + column metadata is built ONCE (cached on the instance)
 * and re-used by every request, then route registration runs OUTSIDE
 * the catch — real bugs in route registration surface instead of being
 * swallowed.
 */

import "./augmentations.js";
import { fileURLToPath } from "node:url";
import type {
	BaseRepository as AtlasBaseRepository,
	ColumnMetadata,
	DatabaseConnection,
	DateColumnConfig,
} from "@c9up/atlas";
import {
	editableColumns,
	isFrameworkManaged,
	viewColumns,
	writeOnlyKeys,
} from "./columns.js";
import {
	loginKeys,
	MemoryLoginLimiter,
	type StationLoginLimiter,
	type StationLoginRateLimitConfig,
} from "./loginLimiter.js";
import { ResourceRegistry } from "./ResourceRegistry.js";
import { clearStation, getStation, setStation } from "./services/main.js";
import type {
	AuditEvent,
	Resource,
	ResourceAction,
	SecurityAuditEvent,
	SecurityAuditSink,
} from "./types.js";
import { inProduction, normalizeNodeEnv } from "./vendor/nodeEnv.js";
// note: AuditEvent + ResourceAction are used by the CRUD handlers below;
// the imports stay in one block for clarity.
import { buildFormViewModel } from "./views/form.js";
import { buildListViewModel } from "./views/list.js";
import { buildLoginViewModel } from "./views/login.js";
import { buildShowViewModel } from "./views/show.js";

/**
 * Duck-typed slice of the host's IoC container — Station MUST stay
 * publishable without importing `@c9up/ream` directly (memory
 * `project_package_extraction`). The Ream container fulfils this shape.
 */
interface StationContainer {
	singleton<T>(key: unknown, factory: () => T): void;
	resolve<T>(key: unknown): Promise<T>;
	has(key: unknown): boolean;
}

interface StationConfigStore {
	get<T>(key: string): T | undefined;
}

export interface StationAppContext {
	container: StationContainer;
	config: StationConfigStore;
}

/**
 * Minimal HTTP context used by the route handlers. Structurally
 * compatible with `@c9up/ream`'s HttpContext (request / response /
 * params) without forcing the import. `redirect` + `header` are BOTH
 * required — Ream's HttpContext exposes both, and the 302 fallback path
 * requires one of them to ship a real Location (refusing to silently
 * emit a Location-less redirect).
 */
interface StationHttpContext {
	request: {
		qs(): Record<string, string | undefined>;
		body?(): Promise<unknown> | unknown;
		header?(name: string): string | undefined;
		cookie?(name: string): string | undefined;
		/** The request path (ream's `url()` without the query string). */
		url?(): string;
		/** `X-Request-Id`, when the proxy or client set one (AdonisJS `id`). */
		id?(): string | undefined;
		/** Host with port: `Host`, or `X-Forwarded-Host` from a trusted proxy. */
		host?(): string | null;
		/** `http` or `https` (trusted-proxy aware in ream). */
		protocol?(): string;
		/** Client IP as the host resolved it (trusted-proxy aware in ream). */
		ip?(): string;
		/** Whether the request came over HTTPS (trusted-proxy aware in ream). */
		secure?(): boolean;
		/**
		 * `true` only when the host's `@c9up/blackhole` middleware enforced +
		 * validated CSRF for this request (a first-class ream `HttpContext`
		 * contract). Station fail-closes every admin write route on this — a
		 * seeded token is NOT proof of verification, so this is the ONLY signal
		 * trusted for enforcement.
		 */
		csrfProtected?: boolean;
	};
	response: {
		status(code: number): unknown;
		type(value: string): unknown;
		send(body: string): unknown;
		json(data: unknown): unknown;
		redirect(url: string): unknown;
		header(name: string, value: string): unknown;
		cookie?(
			name: string,
			value: string,
			options?: {
				httpOnly?: boolean;
				secure?: boolean;
				sameSite?: "Strict" | "Lax" | "None";
				maxAge?: number;
				path?: string;
			},
		): unknown;
		clearCookie?(name: string, options?: { path?: string }): unknown;
	};
	params: Record<string, string>;
	auth?: {
		user?: { id: unknown; [key: string]: unknown };
		roles?: string[];
	};
	/**
	 * Optional per-request keyed store. Station reads `csrfToken` here
	 * so the auto-generated form embeds a hidden CSRF input — matches
	 * the `csrfToken` convention the @c9up/blackhole middleware writes to.
	 * Hosts wiring a different CSRF strategy can write the token here
	 * under the same key and the form will pick it up.
	 */
	store?: {
		get(key: string): unknown;
		set?(key: string, value: unknown): void;
	};
	/**
	 * The request session, when the host registered ream's `SessionMiddleware`
	 * (`ctx.session`, AdonisJS parity). Station uses only the flash surface (57.7):
	 * on an invalid HTML write it flashes the old input + errors and redirects
	 * back to the form, which reads them back via `flashMessages`. Undefined
	 * when no session middleware ran — Station then falls back to an inline 422
	 * form re-render (no session ⇒ no flash round-trip possible).
	 */
	session?: {
		flash(key: string, value: unknown): void;
		flashAll(input: Record<string, unknown>): void;
		/**
		 * A store, not a method — the AdonisJS shape ream now matches. Only
		 * `all()` is needed here, so that is all the structural type asks for.
		 */
		flashMessages: { all(): Record<string, unknown> };
	};
}

interface StationRouter {
	get(
		path: string,
		handler: (ctx: StationHttpContext) => Promise<void> | void,
	): unknown;
	post(
		path: string,
		handler: (ctx: StationHttpContext) => Promise<void> | void,
	): unknown;
	put(
		path: string,
		handler: (ctx: StationHttpContext) => Promise<void> | void,
	): unknown;
	delete(
		path: string,
		handler: (ctx: StationHttpContext) => Promise<void> | void,
	): unknown;
}

/**
 * Atlas `BaseEntity` instances expose a `setProp(key, value)` helper
 * so Station can mutate columns without poking at internal dirty-
 * tracking state. The repository surface treats rows as indexed maps
 * (for view rendering + audit diff) AND as mutators (for update).
 */
interface StationEntity {
	[key: string]: unknown;
	setProp(key: string, value: unknown): void;
}

/** Minimum repository surface the CRUD handlers need from atlas. */
interface StationRepository {
	find(id: string | number | bigint): Promise<StationEntity | null>;
	query(): StationQuery;
	create(data: Record<string, unknown>): Promise<StationEntity>;
	save(entity: StationEntity): Promise<void>;
	delete(entity: StationEntity): Promise<void>;
}

interface StationQuery {
	orderBy(column: string, direction: "asc" | "desc"): StationQuery;
	exec(): Promise<Record<string, unknown>[]>;
	paginate(page: number, perPage: number): Promise<StationPaginator>;
}

/**
 * Minimal structural mirror of atlas's `Paginator` — only the surface the list
 * handler reads. Kept structural (like `StationQuery`/`StationRepository`) so
 * Station never couples to atlas's generic `Paginator<T>` value/type.
 */
interface StationPaginator {
	all(): Record<string, unknown>[];
	meta: {
		total: number;
		perPage: number;
		currentPage: number;
		lastPage: number;
		firstPage: number;
	};
}

/** Per-resource snapshot built once at `start()`, reused on every request. */
interface ResourceContext {
	repo: StationRepository;
	/** Every column — audit snapshots read these (secrets redacted there). */
	columns: ReadonlyArray<ColumnMetadata>;
	/** What the list page renders (bug 209: secrets excluded by default). */
	listColumns: ReadonlyArray<ColumnMetadata>;
	/** What the show page renders. */
	showColumns: ReadonlyArray<ColumnMetadata>;
	/** The editable allow-list — the form's fields and the schema's keys. */
	formColumns: ReadonlyArray<ColumnMetadata>;
	/** Editable columns never pre-filled; an empty submission keeps them. */
	writeOnly: ReadonlySet<string>;
	/** Columns whose values audit snapshots replace with "[redacted]". */
	redacted: ReadonlySet<string>;
	pkColumn: string;
	/** The primary key column's declared type, lower-cased ("" when untyped). */
	pkType: string;
	/**
	 * Property keys of framework-managed timestamp columns — those declared
	 * `@column.dateTime({ autoCreate })` / `{ autoUpdate }` (Lucid-style flag,
	 * NOT a name convention). BaseRepository owns these on INSERT/UPDATE, so
	 * the mass-assignment guard drops them regardless of their column name.
	 */
	autoManaged: ReadonlySet<string>;
	/**
	 * The `@c9up/rune` validation schema derived once (57.7) from the entity's
	 * writable column metadata — replaces the hand-rolled `filterWritableBody`.
	 * `validateResult()` both drops non-schema keys (the mass-assignment guarantee is
	 * now inherent — `result.data` holds only declared columns) AND type-checks
	 * each field. Built only when a write action is mounted (create/edit); a
	 * read-only resource leaves it `undefined`. `booleanKeys` names the checkbox
	 * columns the handler must default to `false` when their key is absent (an
	 * unchecked box submits nothing).
	 */
	writableSchema?: RuneSchema;
	/** Same keys, write-only columns optional: an edit may leave them as stored. */
	updateSchema?: RuneSchema;
	booleanKeys: ReadonlySet<string>;
}

/** Lazy-imported `@c9up/atlas` value surface. */
interface AtlasModule {
	BaseRepository: typeof AtlasBaseRepository;
	getColumnMetadata: (entity: unknown) => ReadonlyArray<ColumnMetadata>;
	getPrimaryKey: (entity: unknown) => string | undefined;
	getDateColumnConfig: (entity: unknown) => Record<string, DateColumnConfig>;
	/** Relation propertyKeys — excluded from the writable schema (never columns). */
	getRelationMetadata: (
		entity: unknown,
	) => ReadonlyArray<{ propertyKey: string }>;
	/** `@SoftDeletes()` present ⇒ the `deletedAt` column is framework-owned. */
	hasSoftDeletes: (entity: unknown) => boolean;
}

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
interface RuneValidationError {
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
interface RuneSchema {
	validateResult(data: unknown): RuneValidationResult;
}

/** Lazy-imported `@c9up/rune` value surface (mirror `AtlasModule`). */
interface RuneModule {
	schema(fields: Record<string, RuneRuleChain>): RuneSchema;
	rules: RuneRules;
}

/**
 * Minimal slice of the host's SHARED inker renderer — the `"inker"` container
 * alias `InkerProvider` binds. Station consumes inker EXACTLY the way it
 * consumes `@c9up/warden`: resolved through the container, never a static OR
 * dynamic `import "@c9up/inker"` in `src/` (57.1/D5). Following the AdonisJS
 * package-views pattern (Edge `edge.mount(name, dir)` + `namespace::template`),
 * Station mounts its package `templates/` as a named disk (`mount("station",
 * dir)`) on this shared renderer and renders `station::…`. `renderToString`'s
 * `ctx` carries the per-request store the inker helpers read: the form + login
 * views thread the real `ctx.store` (57.3/D3) so `{{ csrfField() }}` reaches the
 * token; the 404/list/show views call no helpers, so the store is inert there.
 */
interface InkerViewRenderer {
	mount(diskName: string, dir: string): void;
	renderToString(
		ctx: object,
		name: string,
		data: Readonly<Record<string, unknown>>,
	): Promise<string>;
}

/**
 * Runtime shape check for the resolved `"inker"` binding. `container.has("inker")`
 * only proves the token is registered — a null/partial/mis-registered value would
 * otherwise slip through `#resolveViewRenderer` and blow up as a raw `TypeError`
 * at `renderer.mount(...)` during boot, defeating the actionable fail-loud gate
 * (57.1 review). Guarding here turns a null/non-conforming binding into the same
 * clear "not usable" boot error, with the specific reason chained as `cause`.
 */
function isInkerViewRenderer(value: unknown): value is InkerViewRenderer {
	return (
		typeof value === "object" &&
		value !== null &&
		"mount" in value &&
		typeof value.mount === "function" &&
		"renderToString" in value &&
		typeof value.renderToString === "function"
	);
}

/**
 * Authorization scope (Epic 56). Declared LOCALLY — Station stays
 * agnostic of `@c9up/warden` and never imports its `Scope` type. The
 * shape mirrors warden's `Scope` (`"global" | { tenant }`) structurally
 * so a value crosses the duck-typed boundary without a cast. Station
 * gates at the implicit `"global"` scope in 56.5 (D6); the param exists
 * so a later story can thread a per-request tenant without touching call
 * sites.
 */
type StationScope = "global" | { readonly tenant: string };

/**
 * Authenticated user shape Station hands to the auth layer. Matches what
 * `ctx.auth.user` carries (and what Warden's `verify`/`authenticate`
 * return on `user`) — an `id` plus arbitrary claims. Kept structural so
 * Station never imports warden's `UserPayload`.
 */
interface StationAuthUser {
	id: unknown;
	[key: string]: unknown;
}

/**
 * Minimal `AuthManager` surface Station needs from `@c9up/warden`. The
 * full class exposes more (strategy registration, sign-token, password
 * hashing, etc.); Station needs the credentials-in / verify-token path
 * (54.7) plus the coarse authorization helpers (56.5): `hasPermission`
 * (per-action gate) and `hasRole` (the `requireRole` blanket gate), both
 * resolved through Warden's single `RightsResolver` (Epic 56). Consumed
 * duck-typed via the container `"auth"` alias — the SAME uniform pattern
 * Station uses for the rest of the Ream universe it integrates
 * (`@c9up/ream`, `@c9up/atlas`): resolve through the container, never a
 * static `import "@c9up/warden"`, so the optional-peer / degraded-host
 * path keeps working (D1).
 */
interface WardenAuthManager {
	authenticate(
		credentials: Record<string, unknown>,
		strategyName?: string,
	): Promise<{
		authenticated: boolean;
		// Warden's AuthResult has NO top-level `token` — JwtStrategy puts
		// the issued token on `user.token` (see warden AuthManager.ts +
		// JwtStrategy.authenticate). The session cookie is read from there.
		user?: { id: unknown; token?: string; [key: string]: unknown };
		/** Operator detail: may carry a thrown backend message, never shown. */
		error?: string;
		/** The strategy threw (a backend fault), as `verify()` reports it. */
		strategyCrash?: boolean;
	}>;
	verify(
		token: string,
		strategyName?: string,
	): Promise<{
		authenticated: boolean;
		user?: { id: unknown; [key: string]: unknown };
		error?: string;
		strategyCrash?: boolean;
	}>;
	/**
	 * Resolve whether `user` holds `permission` within `scope` (Epic 56,
	 * default `"global"`). Backed by the single `RightsResolver` —
	 * role→permission + ACL grants ONLY, never the token's `permissions`
	 * claim (warden D1). A missing `await` here yields a truthy Promise =
	 * silent ALLOW, so every call site MUST await.
	 */
	hasPermission(
		user: StationAuthUser,
		permission: string,
		scope?: StationScope,
	): Promise<boolean>;
	/**
	 * Resolve whether `user` holds `role` within `scope` (Epic 56,
	 * default `"global"`). Backed by the same resolver as `hasPermission`.
	 */
	hasRole(
		user: StationAuthUser,
		role: string,
		scope?: StationScope,
	): Promise<boolean>;
	/**
	 * The guard `verify(token)` uses when no name is given (warden's
	 * `getStrategy()`). Logout calls its `revoke(token)` when it has one —
	 * JwtStrategy does, backed by its jti blacklist.
	 */
	getStrategy?(name?: string): unknown;
}

/**
 * Config block read from `app.config.get<StationConfig>('station')`.
 * Every field is optional — the defaults match the 54.2 / 54.3 / 54.4
 * conventions so an app can leave the config out entirely.
 */
export interface StationConfig {
	/**
	 * When true (default `true` if `@c9up/warden` is installed),
	 * Station mounts a login surface at `/admin/login` and gates every
	 * other `/admin/*` route behind `auth.verify(token)`. Setting this
	 * to `false` keeps the old open-by-default behaviour from 54.2.
	 */
	requireAuth?: boolean;
	/**
	 * Role required to pass the auth gate, on top of {@link accessPermission}.
	 */
	requireRole?: string;
	/**
	 * Namespace of every admin permission: actions are gated behind
	 * `<prefix>.<resource>.<action>` (e.g. `station.users.edit`) and entry
	 * behind `<prefix>.access`. Defaults to `"station"`, so a grant the
	 * application made for its own features (`users.edit`) never opens the
	 * admin.
	 */
	permissionPrefix?: string;
	/**
	 * Permission every request must hold to enter `/admin/*`, checked before
	 * the per-action one. Defaults to `<permissionPrefix>.access`. `false`
	 * removes this gate (the per-action permissions still apply).
	 */
	accessPermission?: string | false;
	/**
	 * Where to redirect on a failed auth check. Defaults to
	 * `/admin/login`.
	 */
	loginPath?: string;
	/**
	 * Cookie name carrying the auth token. Defaults to `station_auth`
	 * to avoid colliding with app-level session cookies.
	 */
	cookieName?: string;
	/**
	 * `Secure` flag of the auth cookie. Defaults to on everywhere except a
	 * development/test process served over plain HTTP, so an unknown
	 * environment behaves like production.
	 */
	cookieSecure?: boolean;
	/**
	 * Brute-force throttle on `POST /admin/login`: 5 attempts per IP and per
	 * identifier every 15 minutes by default, in this process's memory. Pass
	 * `limiter` (warden's `AuthRateLimiter` fits) to share counts across
	 * instances. `false` turns it off — only for an app that throttles the
	 * route itself (see {@link middleware}).
	 */
	loginRateLimit?: StationLoginRateLimitConfig | false;
	/** Named router middleware attached to every route Station mounts. */
	middleware?: ReadonlyArray<string>;
	/**
	 * The warden guard the admin signs in, verifies and logs out through.
	 * Defaults to the auth manager's default guard. Station's sign-in issues
	 * a bearer token kept in its cookie, so the guard must be a token guard
	 * (warden's JWT strategy): a session guard is refused at boot.
	 */
	guard?: string;
	/**
	 * Sink for the admin's security events: sign-in success, failure and
	 * throttling, logout, authorization denials and CSRF blocks, each with the
	 * client IP and request id. Write events keep going to each resource's
	 * own `audit`.
	 */
	audit?: SecurityAuditSink;
}

const MAX_PER_PAGE = 100;
const DEFAULT_PERMISSION_PREFIX = "station";
/**
 * The auth cookie travels only to the admin: scoped to `/`, the admin bearer
 * token rode along with every request to the rest of the application.
 */
const AUTH_COOKIE_PATH = "/admin";
const DEFAULT_PER_PAGE = 25;
const POSITIVE_INT_RE = /^[1-9][0-9]*$/;

/** Process-scoped flags so we warn once per process, not once per request. */
let authWarnEmitted = false;
let perPageClampWarned = false;
let seedPermsWarned = false;
let missingAuditWarned = false;
let csrfBlockedWarned = false;
let revokeUnavailableWarned = false;
let auditCloneWarnEmitted = false;

/** @internal Reset module-level flags between tests. */
export function resetStationProviderFlags(): void {
	authWarnEmitted = false;
	perPageClampWarned = false;
	seedPermsWarned = false;
	missingAuditWarned = false;
	csrfBlockedWarned = false;
	revokeUnavailableWarned = false;
	auditCloneWarnEmitted = false;
}

/**
 * Stable fingerprint for a failed `station::errors/404` render, used to log each
 * distinct failure MODE once per provider instance rather than once per request.
 * Keys on the error `code`/`name` ONLY — never the message, which can embed the
 * request-controlled `id` and would let attacker traffic inflate the log past
 * the very bound this mechanism exists to hold.
 */
function notFoundFailFingerprint(cause: unknown): string {
	if (!(cause instanceof Error)) return "non-error";
	if ("code" in cause && typeof cause.code === "string") return cause.code;
	return cause.name;
}

/**
 * Hard cap on distinct 404-render failure modes logged per instance, so an
 * unforeseen unbounded error-code space still cannot inflate the log or memory.
 */
const NOT_FOUND_RENDER_FAIL_CAP = 32;

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
 * is the AC7 predicate: it decides whether `@c9up/rune` is REQUIRED at boot —
 * exported so `agnostic-peers-missing.test.ts` can pin the decision directly
 * (the dynamic-import-absent path can't be simulated inside vitest, exactly as
 * for atlas — see that file's header).
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
 * declared-column keys (mass-assignment inherent). Exported for the unit tests
 * that pin the coercion CRUX. A blank `writeOnly` value counts as not
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
 * Whether a rune error is about the payload as a whole. rune reports it on the
 * empty field path (rule `object`, or `required` for a missing payload);
 * releases before 0.2.4, still inside the peer range, named that path `_root`.
 */
function isRootError(e: RuneValidationError): boolean {
	return e.field === "" || e.field === "_root";
}

/**
 * Split rune's flat `ValidationError[]` for the HTML form re-render: one
 * message per top-level field (`form.inker` keys errors by column
 * propertyKey), and the payload-level failure, which no field can show, as a
 * form-level message.
 */
function formErrors(errors: ReadonlyArray<RuneValidationError>): {
	fields: Record<string, string>;
	form: string | undefined;
} {
	const fields: Record<string, string> = {};
	let form: string | undefined;
	for (const e of errors) {
		if (isRootError(e)) {
			form ??= e.message;
			continue;
		}
		// Collapse a nested dotted path (`profile.name`) to its top-level
		// key — `form.ts` keys errors by column propertyKey. `split` always yields
		// a non-empty array, so `[0]` is a string (no fallback needed).
		const [key = e.field] = e.field.split(".");
		if (!(key in fields)) fields[key] = e.message;
	}
	return { fields, form };
}

/** Session flash key under which the per-field validation errors are stashed (AdonisJS `flashMessages.errors` parity). */
const FLASH_ERRORS_KEY = "errors";

/**
 * Session flash key for the errors that belong to the form rather than to one
 * field, keyed by error code (AdonisJS `errorsBag` parity).
 */
const FLASH_FORM_ERRORS_KEY = "errorsBag";
const VALIDATION_ERROR_CODE = "E_VALIDATION_ERROR";

/**
 * The subset of a submitted body safe to re-surface on a validation error:
 * declared columns only — so `_csrf`, `_method`, and any mass-assignment /
 * arbitrary key are dropped from the flash store — minus the write-only ones
 * (a password is never written to the session nor reflected into the
 * re-rendered form). An empty result lets the caller fall back to the
 * existing `row`.
 */
function flashableInput(
	submitted: Record<string, unknown>,
	columns: ReadonlyArray<ColumnMetadata>,
	writeOnly: ReadonlySet<string>,
): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const c of columns) {
		if (writeOnly.has(c.propertyKey)) continue;
		if (c.propertyKey in submitted)
			out[c.propertyKey] = submitted[c.propertyKey];
	}
	return out;
}

function isStringRecord(value: unknown): value is Record<string, string> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return false;
	}
	return Object.values(value).every((v) => typeof v === "string");
}

/**
 * Read flashed old input + per-field errors for a form `GET` re-render after a
 * failed write redirected back (57.7, AdonisJS PRG). Returns `{}` when nothing
 * was flashed (a normal GET) — the form then renders from `row`/empty as usual.
 * `values` is restricted to declared column keys so the flashed `errors` bag (or
 * any other flashed key) never leaks into a field value.
 */
function readFlash(
	ctx: StationHttpContext,
	columns: ReadonlyArray<ColumnMetadata>,
): {
	values?: Record<string, unknown>;
	errors?: Record<string, string>;
	formError?: string;
} {
	const flashed = ctx.session?.flashMessages.all() ?? {};
	if (Object.keys(flashed).length === 0) return {};
	const values: Record<string, unknown> = {};
	for (const c of columns) {
		// `errors` / `errorsBag` are reserved for the error bags — a column
		// literally named so must not receive that object as its field value.
		if (
			c.propertyKey === FLASH_ERRORS_KEY ||
			c.propertyKey === FLASH_FORM_ERRORS_KEY
		)
			continue;
		if (c.propertyKey in flashed)
			values[c.propertyKey] = flashed[c.propertyKey];
	}
	const rawErrors = flashed[FLASH_ERRORS_KEY];
	const formBag = flashed[FLASH_FORM_ERRORS_KEY];
	return {
		values: Object.keys(values).length > 0 ? values : undefined,
		errors: isStringRecord(rawErrors) ? rawErrors : undefined,
		formError: isStringRecord(formBag)
			? formBag[VALIDATION_ERROR_CODE]
			: undefined,
	};
}

/**
 * The path and query a `Referer` points back to, when it may be trusted —
 * AdonisJS's `isValidRedirectUrl` + `redirect().back()`: a relative path is
 * trusted, an absolute URL only when its origin (scheme + host) is the
 * request's own, and the redirect goes to its path and query alone. Comparing
 * with `request.url()` could never work: in ream that is the path, while a
 * browser's Referer is a full URL. Deliberately stricter than upstream in one
 * place: with no origin to compare against, an absolute Referer is refused
 * rather than accepted.
 */
function trustedRefererPath(
	referer: string,
	origin: string | undefined,
): string | undefined {
	// A relative path is trusted only when it starts with a single "/" and
	// contains no backslash: browsers normalise "\\" to "/", so "/\\evil.com"
	// becomes the protocol-relative "//evil.com" that a lone `!startsWith("//")`
	// check would let through.
	if (referer.startsWith("//") || referer.includes("\\")) return undefined;
	let url: URL;
	try {
		if (referer.startsWith("/")) {
			url = new URL(referer, "http://localhost");
			if (url.origin !== "http://localhost") return undefined;
		} else {
			if (origin === undefined) return undefined;
			url = new URL(referer);
			if (url.origin !== origin) return undefined;
		}
	} catch {
		return undefined;
	}
	// Dot segments are resolved by the parser: "/.//evil.com" comes out as the
	// path "//evil.com", protocol-relative again once used as a Location.
	if (url.pathname.startsWith("//")) return undefined;
	return url.pathname + url.search;
}

/**
 * The request's own origin, as the browser saw it: ream's trusted-proxy aware
 * `protocol()` + `host()` (a proxy the app trusts forwards the public scheme
 * and host, which is what the Referer carries). Undefined when either is
 * unknown, so an absolute Referer can't be checked and is refused.
 */
function ownOrigin(ctx: StationHttpContext): string | undefined {
	const { request } = ctx;
	const secure = request.secure?.();
	const protocol =
		request.protocol?.() ??
		(secure === undefined ? undefined : secure ? "https" : "http");
	const host = request.host?.() ?? request.header?.("host");
	if (protocol === undefined || !host) return undefined;
	try {
		return new URL(`${protocol}://${host}`).origin;
	} catch {
		return undefined;
	}
}

/**
 * `redirect().back()` over Station's `redirect(url)` seam (57.7): the path and
 * query of a trusted `Referer`, else the caller's `fallback` (the form URL).
 */
function redirectBack(ctx: StationHttpContext, fallback: string): void {
	const referer = ctx.request.header?.("referer");
	const target =
		typeof referer === "string"
			? (trustedRefererPath(referer, ownOrigin(ctx)) ?? fallback)
			: fallback;
	ctx.response.redirect(target);
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

/**
 * Snapshot an entity's `@Column`-tracked fields for the audit before/
 * after diff. Deep-cloned via `structuredClone` so a downstream sink
 * that mutates the snapshot (e.g. "redact this field before logging")
 * can't echo the change back into the live entity.
 *
 * Falls back to a per-key copy when the entity contains a non-
 * clonable value (a function, a class instance with a non-clonable
 * field). The fallback is shallow but warned ONCE per process so
 * operators see it.
 */
function snapshotEntity(
	entity: Record<string, unknown>,
	columns: ReadonlyArray<ColumnMetadata>,
	redacted: ReadonlySet<string>,
): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const c of columns) {
		out[c.propertyKey] = redacted.has(c.propertyKey)
			? REDACTED
			: entity[c.propertyKey];
	}
	try {
		return structuredClone(out);
	} catch (err) {
		// structuredClone rejected a value (a function, a class instance with a
		// non-cloneable field, …). Try a JSON deep-clone next, so the before/
		// after audit snapshots still don't share mutable references with the
		// live entity — a shared-ref shallow copy would let a later `setProp`
		// mutation bleed back into the "before" image. Only if JSON also fails
		// (bigint, circular) do we accept the shallow copy + warn.
		try {
			const cloned: unknown = JSON.parse(JSON.stringify(out));
			if (isPlainRecord(cloned)) return cloned;
		} catch {
			// fall through to the warned shallow copy
		}
		if (!auditCloneWarnEmitted) {
			auditCloneWarnEmitted = true;
			const detail = err instanceof Error ? err.message : String(err);
			console.warn(
				`[station] structuredClone failed on an audit snapshot and the JSON fallback did not apply — using a shallow copy. A column value isn't cloneable: ${detail}. Snapshot mutations downstream MAY reach the live entity.`,
			);
		}
		return out;
	}
}

/** What an audit snapshot holds in place of a secret column's value. */
const REDACTED = "[redacted]";

/**
 * The redacted columns an edit changed — read from the raw values, so the
 * audit trail says "password changed" without carrying either hash.
 */
function changedRedacted(
	before: Readonly<Record<string, unknown>>,
	entity: Readonly<Record<string, unknown>>,
	redacted: ReadonlySet<string>,
): string[] {
	return [...redacted].filter((key) => !Object.is(before[key], entity[key]));
}

/**
 * Filesystem path to the `.inker` templates Station ships inside the
 * package (57.1, D3). Resolved from `import.meta.url` so the SAME path
 * holds src-run (dev, `exports` → `./src/StationProvider.ts`) and dist-run
 * (published, `./dist/StationProvider.js`) — `templates/` is a sibling of
 * both `src/` and `dist/`. `fileURLToPath` (not `URL.pathname`) so a repo
 * path containing spaces or reserved characters decodes correctly.
 */
const TEMPLATES_ROOT = fileURLToPath(new URL("../templates/", import.meta.url));

export default class StationProvider {
	/** What this provider bound, so shutdown only clears its own. */
	#owned: ResourceRegistry | undefined;

	#contexts: Map<Resource, ResourceContext> = new Map();
	#viewRenderer: InkerViewRenderer | undefined;
	/**
	 * Distinct 404-render failure modes already logged (fingerprints), scoped
	 * per instance so one provider's fault never suppresses another's.
	 */
	#notFoundRenderFailCauses = new Set<string>();
	#started = false;
	// 54.7 auth state — populated when warden is wired AND
	// StationConfig.requireAuth is true (default when warden is present).
	#authManager: WardenAuthManager | undefined;
	#loginLimiter: StationLoginLimiter | undefined;
	#cookieSecure: boolean | undefined;
	#securityAudit: SecurityAuditSink | undefined;
	#authConfig: Required<Pick<StationConfig, "loginPath" | "cookieName">> & {
		requireAuth: boolean;
		requireRole: string | undefined;
		permissionPrefix: string;
		accessPermission: string | undefined;
		/** The warden guard name; undefined uses the manager's default. */
		guard: string | undefined;
	} = {
		guard: undefined,
		requireAuth: false,
		requireRole: undefined,
		loginPath: "/admin/login",
		cookieName: "station_auth",
		permissionPrefix: DEFAULT_PERMISSION_PREFIX,
		accessPermission: undefined,
	};

	constructor(protected app: StationAppContext) {}

	register(): void {
		this.app.container.singleton(ResourceRegistry, () => {
			const registry = new ResourceRegistry();
			setStation(registry);
			return registry;
		});
		this.app.container.singleton("station", () =>
			this.app.container.resolve<ResourceRegistry>(ResourceRegistry),
		);
	}

	async boot(): Promise<void> {
		// Force-resolve so `setStation` runs even if no preload touches the
		// singleton. Mirrors AuroraProvider.boot().
		this.#owned =
			await this.app.container.resolve<ResourceRegistry>(ResourceRegistry);
	}

	async start(): Promise<void> {
		if (this.#started) return;

		const registry =
			await this.app.container.resolve<ResourceRegistry>(ResourceRegistry);

		// NOT gated on the registry being non-empty any more. Providers start
		// BEFORE preloads run, and a preload is where the docs say to write
		// `station.register(...)`, so reading a snapshot here and giving up when
		// it was empty meant an application that followed the documentation got
		// no admin at all. The surface is prepared here and each resource is
		// mounted as it is declared — the shape upstream's Transmit uses for the
		// same ordering problem.

		// 54.7 — read the optional `station` config block. Defaults bake
		// in `requireAuth: true` when @c9up/warden is detected later in
		// Phase 1, so a host that just installs the peer gets the auth
		// gate without any extra config.
		const userConfig = this.app.config.get<StationConfig>("station") ?? {};

		// Phase 1 — lazy peer imports (router + atlas). A missing optional
		// peer is a degraded-host signal: #loadPeers returns null → silent stop.
		const peers = await this.#loadPeers();
		if (!peers) return;
		const { atlas, rune } = peers;
		const router = withRouteMiddleware(peers.router, userConfig.middleware);
		this.#loginLimiter = buildLoginLimiter(userConfig.loginRateLimit);
		this.#cookieSecure = userConfig.cookieSecure;
		if (
			userConfig.audit !== undefined &&
			typeof userConfig.audit !== "function"
		) {
			throw new TypeError("[station] `station.audit` must be a function");
		}
		this.#securityAudit = userConfig.audit;

		// Phase 1a2 — resolve the SHARED inker renderer (AdonisJS/Edge parity)
		// and mount Station's package templates as the `station` disk. Unlike
		// warden (whose absence keeps the open dev-preview path), a view engine
		// is a HARD render requirement (D2): once an admin surface exists there
		// is no page without it.
		//
		// The failure is HELD rather than thrown: with no resource declared
		// there is no admin surface, and an application that installed the
		// provider without ever registering a resource must not be forced to
		// wire a view engine. It is rethrown on the first resource, which is the
		// moment the requirement becomes real.
		let rendererFailure: unknown;
		try {
			const renderer = await this.#resolveViewRenderer();
			// Mount once: `station::<template>` now resolves to this package's
			// templates/ dir on the host's single inker engine (edge.mount parity).
			renderer.mount("station", TEMPLATES_ROOT);
			this.#viewRenderer = renderer;
		} catch (err) {
			rendererFailure = err;
		}

		// Phase 1b — wire the warden auth gate (or warn-once when it stays open).
		await this.#configureAuth(userConfig);

		// The `db` connection is only consumed per resource, so its absence is
		// held the same way: rethrown when the first resource is declared.
		let db: unknown;
		let dbFailure: unknown;
		try {
			db = await this.#resolveDb();
		} catch (err) {
			dbFailure = err;
		}

		// Phase 2 — mount every resource, now and as they arrive. The shell (the
		// login surface, the `/admin` index) goes up with the first one: an
		// application with no resources has no admin, and had none before.
		let shellMounted = false;
		registry.useMounter((resource) => {
			if (!shellMounted) {
				if (rendererFailure !== undefined) throw rendererFailure;
				if (dbFailure !== undefined) throw dbFailure;
				try {
					this.#registerShellRoutes(router);
				} catch (err) {
					// The router proxy may still throw "Router accessed before
					// initialization" on first property access (a boot-ordering
					// hazard where the proxy module imported but Ignitor's
					// `setRouter` never fired). That is a legitimate degraded-host
					// shape — give up quietly. Anything else propagates.
					if (isRouterProxyUninit(err)) return;
					throw err;
				}
				shellMounted = true;
			}
			// 57.7 fail-closed: a write-capable admin (create/edit) validates +
			// guards mass-assignment through a rune-derived schema. If atlas is
			// present (CRUD is live) but `@c9up/rune` is NOT installed, refuse
			// rather than silently accept unvalidated bodies — there is NO
			// fallback to the deleted key-filter. Read-only admins need no rune.
			// Checked per resource, so the refusal names the one at fault.
			if (rune === null && resourcesNeedValidation([resource])) {
				throw new Error(
					`[station] @c9up/rune is required to validate the write forms of the '${resource.name}' admin (create/edit) but is not installed. Add @c9up/rune (a Station peer dependency) — Station will NOT fall back to unvalidated mass-assignment. See https://ream.dev/modules/station#mass-assignment.`,
				);
			}
			this.#contexts.set(
				resource,
				buildResourceContext(resource, db, atlas, rune),
			);
			this.#registerResourceRoutes(router, resource);
		});

		this.#started = true;
	}

	/**
	 * The gaps worth reporting once, when the full set of resources is known.
	 *
	 * `ready()` runs after every preload, so this is the first moment the whole
	 * admin surface exists. Nothing is mounted here — the routes were built as
	 * each resource was declared.
	 */
	async ready(): Promise<void> {
		if (!this.#started) return;
		const registry =
			await this.app.container.resolve<ResourceRegistry>(ResourceRegistry);
		const resources = registry.all();
		if (resources.length === 0) return;
		// 56.5 + 54.6 — "auth wired but no permissions seeded" and "no audit
		// sink" are surfaced loud-and-once so a half-wired install cannot ship to
		// prod without operators noticing. (CSRF is not a boot-time warn:
		// enforcement is request-time, and every write route fail-closes on
		// `ctx.request.csrfProtected`.)
		this.#warnSeedPermissionsOnce(resources);
		this.#warnAuditGapsOnce(resources);
	}

	/**
	 * Phase 1 — resolve the host router from the container (Ream registers it as
	 * `'router'` in Ignitor) + lazy-import the optional `@c9up/atlas` peer.
	 *
	 * Reading the router from the container — instead of importing
	 * `@c9up/ream/services/router` — keeps station runtime-agnostic: a non-Ream
	 * host never registers `'router'` → null (a legitimate degraded-host signal).
	 * `@c9up/atlas` stays a genuine peer MODULE import (it ships agnostic
	 * classes, not a framework singleton); module-not-found → null, anything
	 * else re-throws.
	 */
	async #loadPeers(): Promise<{
		router: StationRouter;
		atlas: AtlasModule;
		rune: RuneModule | null;
	} | null> {
		if (!this.app.container.has("router")) return null;
		const router = await this.app.container.resolve<StationRouter>("router");
		try {
			const atlas = loadBearingCast<AtlasModule>(await import("@c9up/atlas"));
			// rune is loaded here but its ABSENCE is NOT a degraded-host signal the
			// way atlas's is: atlas-missing ⇒ no CRUD at all (silent stop), whereas
			// rune-missing while a write resource IS mounted is a fail-CLOSED
			// misconfiguration (start() throws loud — see below). So `#loadRune`
			// swallows only module-not-found → null; start() decides whether that
			// null is fatal.
			const rune = await this.#loadRune();
			return { router, atlas, rune };
		} catch (err) {
			// ONLY when atlas itself is what is missing. An atlas that is
			// installed but cannot load — a dependency of its own gone, a broken
			// build — is not a host without atlas, and disabling the admin over
			// it hides the actual fault.
			if (isPackageMissing(err, "@c9up/atlas")) return null;
			throw err;
		}
	}

	/**
	 * Tolerantly load `@c9up/rune` (57.7) — the SAME seam as `@c9up/atlas`
	 * (dynamic module import, module-not-found → null, real error re-thrown).
	 * Returning null does NOT degrade the host: the caller fails loud only when
	 * a write-capable resource actually needs the validator (AC7, fail-closed).
	 */
	async #loadRune(): Promise<RuneModule | null> {
		try {
			return loadBearingCast<RuneModule>(await import("@c9up/rune"));
		} catch (err) {
			if (isPackageMissing(err, "@c9up/rune")) return null;
			throw err;
		}
	}

	/**
	 * Resolve the host's shared inker renderer from the container (the `"inker"`
	 * alias `InkerProvider` binds) — the AdonisJS package-views pattern (57.1,
	 * D1/D2). A view engine is mandatory once an admin surface exists, so an
	 * unbound or not-yet-ready `"inker"` throws a clear, actionable error at
	 * boot (mirrors `#resolveDb`'s loud-on-missing), rather than a silent
	 * degrade or a runtime 500. Consumed via the container only — never a
	 * static or dynamic `import "@c9up/inker"` (D5), exactly like warden.
	 */
	async #resolveViewRenderer(): Promise<InkerViewRenderer> {
		if (!this.app.container.has("inker")) {
			throw new Error(
				"[station] register @c9up/inker (InkerProvider) to render admin views",
			);
		}
		try {
			const resolved = await this.app.container.resolve<unknown>("inker");
			if (!isInkerViewRenderer(resolved)) {
				throw new Error(
					'the "inker" binding is not a usable view renderer (missing mount/renderToString)',
				);
			}
			return resolved;
		} catch (cause) {
			throw new Error(
				"[station] @c9up/inker is registered but not usable — it must fully boot (InkerProvider + its rosetta/router peers) before Station, and resolve to a real view renderer. See `cause` for the specific reason.",
				{ cause },
			);
		}
	}

	/**
	 * Render Station's 404 page through the shared inker renderer (57.1).
	 * Builds the same data the retired `renderNotFoundPage` composed and
	 * renders the `station::errors/404` template (the package's mounted disk);
	 * inker's `{{ }}` auto-escaping replaces the hand-rolled escaper for
	 * this view. `slug` is `encodeURIComponent`-safe (no HTML-special output)
	 * so its auto-escape is a no-op in the back-link `href`. The 404 uses no
	 * inker helpers, so a minimal render ctx is sufficient.
	 */
	async #renderNotFound(
		ctx: StationHttpContext,
		resource: Resource,
		id: string,
	): Promise<string> {
		if (this.#viewRenderer === undefined) {
			throw new Error("[station] view engine not initialised");
		}
		const renderCtx = {
			request: ctx.request,
			response: ctx.response,
			store: new Map<string, unknown>(),
			locale: "en",
		};
		try {
			return await this.#viewRenderer.renderToString(
				renderCtx,
				"station::errors/404",
				{
					title: "Not Found",
					id,
					label: resource.label,
					labelLower: resource.label.toLowerCase(),
					slug: encodeURIComponent(resource.name),
				},
			);
		} catch (cause) {
			// The error page itself failed to render (missing/faulty template,
			// fs fault, parse error). A not-found must never escalate into a 500:
			// fall back to a minimal, dependency-free static body. `id` is
			// request-controlled, so it is HTML-escaped here. The fault is logged
			// so a persistent deploy misconfig (unpublished templates/, corrupt
			// station::layout) is not silently swallowed — but once per failure
			// MODE per instance, not once per request: a durably-broken template
			// on a 404-sprayed endpoint must not turn attacker traffic into
			// unbounded log volume, while a genuinely new failure mode still
			// surfaces its `cause`. The fingerprint keys on code/name only (never
			// the request-controlled message) and is capped, so both stay bounded.
			const fingerprint = notFoundFailFingerprint(cause);
			if (
				this.#notFoundRenderFailCauses.size < NOT_FOUND_RENDER_FAIL_CAP &&
				!this.#notFoundRenderFailCauses.has(fingerprint)
			) {
				this.#notFoundRenderFailCauses.add(fingerprint);
				console.error(
					`[station] failed to render station::errors/404 (${fingerprint}) — serving the minimal fallback page; repeats of this failure mode are suppressed this instance`,
					cause,
				);
			}
			return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Not Found</title></head><body><h1>404 — Not Found</h1><p>No ${escapeMin(resource.label)} matches <code>${escapeMin(id)}</code>.</p></body></html>`;
		}
	}

	/**
	 * Render a Station template through the shared inker renderer (57.2). Builds
	 * the same minimal render ctx as `#renderNotFound` (the list/show views use
	 * no inker helpers) and delegates escaping to inker's `{{ }}`. Used by the
	 * list + show handlers. Unlike the retired hand-rolled builders — pure
	 * `(input) => string` functions that could only throw on their own logic —
	 * this path can additionally fault on template lookup, fs, or parse errors.
	 * Such a fault propagates to the root error boundary as a 500, which is the
	 * correct outcome on the success path: a broken list/show template is a real
	 * server error and must not be masked as a degraded 200. (`#renderNotFound`
	 * wraps its render in a static fallback only because a not-found is already
	 * an error response that must never escalate into a 500.)
	 */
	async #renderView(
		ctx: StationHttpContext,
		name: string,
		data: Readonly<Record<string, unknown>>,
	): Promise<string> {
		if (this.#viewRenderer === undefined) {
			throw new Error("[station] view engine not initialised");
		}
		// Thread the real per-request store (57.3/D3) so the als-backed inker
		// helpers — `csrfField()` on the form/login views — read the token. Inert
		// for list/show, whose templates call no helpers.
		const renderCtx = {
			request: ctx.request,
			response: ctx.response,
			store: ctx.store ?? new Map<string, unknown>(),
			locale: "en",
		};
		return await this.#viewRenderer.renderToString(renderCtx, name, data);
	}

	/**
	 * Wire the warden auth gate from the `station` config block. When warden is
	 * not installed/bound the gate stays open and a one-time warning is emitted.
	 */
	/**
	 * Refuse at boot a guard that cannot carry station's sign-in: it must
	 * exist, and issue the bearer token the admin cookie holds (warden's JWT
	 * strategy, `signToken`). A session guard answers `authenticate()` with a
	 * USE_LOGIN error and `verify()` with false, which made every sign-in a
	 * 500 and every admin page a bounce to the login form. A manager without
	 * `getStrategy` cannot be inspected and is taken as it is.
	 */
	#assertTokenGuard(guard: string | undefined): void {
		const manager = this.#authManager;
		if (manager?.getStrategy === undefined) return;
		const named =
			guard === undefined ? "the default guard" : `guard '${guard}'`;
		let strategy: unknown;
		try {
			strategy = manager.getStrategy(guard);
		} catch (cause) {
			throw new Error(
				`[station] \`station.guard\`: ${named} is not a registered warden guard.`,
				{ cause },
			);
		}
		const issuesTokens =
			typeof strategy === "object" &&
			strategy !== null &&
			"authenticate" in strategy &&
			typeof strategy.authenticate === "function" &&
			"verify" in strategy &&
			typeof strategy.verify === "function" &&
			"signToken" in strategy &&
			typeof strategy.signToken === "function";
		if (issuesTokens) return;
		const kind =
			typeof strategy === "object" &&
			strategy !== null &&
			"name" in strategy &&
			typeof strategy.name === "string"
				? ` (${strategy.name})`
				: "";
		throw new Error(
			`[station] The admin signs in through ${named}${kind}, which does not issue a bearer token. ` +
				"Station keeps the token warden's JWT strategy issues in its cookie: name a JWT guard with `station.guard`.",
		);
	}

	async #configureAuth(userConfig: StationConfig): Promise<void> {
		const permissionPrefix =
			userConfig.permissionPrefix ?? DEFAULT_PERMISSION_PREFIX;
		if (typeof permissionPrefix !== "string" || permissionPrefix === "") {
			throw new Error(
				"[station] `station.permissionPrefix` must be a non-empty string: admin permissions need their own namespace.",
			);
		}
		const guard = userConfig.guard;
		if (guard !== undefined && (typeof guard !== "string" || guard === "")) {
			throw new Error(
				"[station] `station.guard` must be a non-empty warden guard name.",
			);
		}
		const wardenWanted = userConfig.requireAuth !== false;
		if (wardenWanted) {
			try {
				this.#authManager =
					await this.app.container.resolve<WardenAuthManager>("auth");
				this.#authConfig = {
					guard,
					requireAuth: true,
					requireRole: userConfig.requireRole,
					loginPath: userConfig.loginPath ?? "/admin/login",
					cookieName: userConfig.cookieName ?? "station_auth",
					permissionPrefix,
					accessPermission:
						userConfig.accessPermission === false
							? undefined
							: (userConfig.accessPermission ?? `${permissionPrefix}.access`),
				};
			} catch (cause) {
				// Container has no working `auth` binding → warden not wired.
				// If the host EXPLICITLY opted in (`requireAuth: true`), that is a
				// misconfiguration, not the dev-preview path — fail closed rather
				// than silently mounting an unauthenticated admin. When
				// `requireAuth` was merely defaulted (undefined), fall through to
				// the open-by-default mode and warn-once below.
				if (userConfig.requireAuth === true) {
					throw new Error(
						"[station] `station.requireAuth: true` is set but no working `auth` binding is registered (wire @c9up/warden's WardenProvider). Refusing to mount an unauthenticated admin.",
						{ cause },
					);
				}
			}
		}
		if (this.#authConfig.requireAuth) {
			this.#assertTokenGuard(guard);
			return;
		}

		// An admin panel with no auth is full CRUD on every registered resource
		// for anyone who can reach the route. That is a different product, and
		// it has to be asked for rather than fallen into — the same bet bay
		// makes about losing a job on a Redis without LMOVE.
		//
		// `requireAuth: false` written down IS the asking. Defaulted (undefined)
		// is not: it means nobody decided, and nobody deciding is only tolerated
		// on a machine positively named development or test. An unset NODE_ENV,
		// `staging`, `preview`… fail closed like production: they are exactly
		// the boxes nobody configured, and staging often holds a copy of
		// production data (ream's `Application.inDev` takes the same stance).
		const env = normalizeNodeEnv(process.env.NODE_ENV);
		const devOrTest = env === "development" || env === "test";
		if (!devOrTest && userConfig.requireAuth !== false) {
			const where = inProduction()
				? "production"
				: `a non-development environment (NODE_ENV=${process.env.NODE_ENV === undefined ? "unset" : JSON.stringify(process.env.NODE_ENV)})`;
			throw new Error(
				`[station] Admin routes would mount with NO authorisation in ${where}: ` +
					"no working `auth` binding is registered, so every `/admin/*` route — " +
					"including create, update and delete — is open to anyone who can reach it.\n" +
					"  Wire @c9up/warden's WardenProvider, or set `station.requireAuth: false` " +
					"to state that an unauthenticated admin is intended here.",
			);
		}

		if (authWarnEmitted) return;
		authWarnEmitted = true;
		// Said even when the deployment opted in: agreeing once in a config file
		// is not the same as being reminded that this process is running that
		// way. The line has to be in the logs of the incident.
		const optedIn = !devOrTest && userConfig.requireAuth === false;
		const envName =
			env === "unknown" ? "AN UNCONFIGURED ENVIRONMENT" : env.toUpperCase();
		console.warn(
			"[station] Admin routes mounted without auth. Wire @c9up/warden (and set `station.requireAuth: true` if you opted out) and seed the per-action admin permissions in the Warden rights store BEFORE production. See https://ream.dev/modules/station#auth." +
				(optedIn
					? `\n  Running this way in ${envName} because \`station.requireAuth: false\` was set.`
					: ""),
		);
	}

	/** Phase 3 — mount the login surface + per-resource CRUD routes. */
	/** Wrap a handler in the auth gate when one is configured. */
	#gate(
		handler: (ctx: StationHttpContext) => Promise<void>,
	): (ctx: StationHttpContext) => Promise<void> {
		return this.#authConfig.requireAuth ? this.#withAuth(handler) : handler;
	}

	/**
	 * The routes that belong to the admin itself rather than to a resource.
	 *
	 * Registered once, while the provider starts — before the HTTP server is
	 * listening, and before any resource has necessarily been declared.
	 */
	#registerShellRoutes(router: StationRouter): void {
		// 54.7 — mount login surface first when auth is required, so
		// `/admin/login` is reachable even when the auth gate redirects every
		// other path to it.
		if (this.#authConfig.requireAuth && this.#authManager !== undefined) {
			router.get("/admin/login", this.#buildLoginFormHandler());
			router.post("/admin/login", this.#buildLoginPostHandler());
			router.post("/admin/logout", this.#buildLogoutHandler());
		}

		// `/admin` index — send the operator to the first listable resource (or
		// the login surface). Without it, the post-login redirect("/admin") lands
		// on a 404.
		//
		// The registry is read WHEN THE REQUEST ARRIVES, not when this route is
		// built: resources are declared in preloads, so a list captured here
		// would name whatever happened to exist first — or nothing at all.
		router.get(
			"/admin",
			this.#gate(async (ctx) => {
				const registry =
					await this.app.container.resolve<ResourceRegistry>(ResourceRegistry);
				const home = registry.all().find((r) => r.actions.includes("list"));
				ctx.response.redirect(home ? `/admin/${home.name}` : "/admin/login");
			}),
		);
	}

	/** Every route one resource contributes, mounted the moment it is declared. */
	#registerResourceRoutes(router: StationRouter, resource: Resource): void {
		const gate = (
			handler: (ctx: StationHttpContext) => Promise<void>,
		): ((ctx: StationHttpContext) => Promise<void>) => this.#gate(handler);
		{
			const slug = resource.name;
			if (resource.actions.includes("list")) {
				router.get(`/admin/${slug}`, gate(this.#buildListHandler(resource)));
			}
			if (resource.actions.includes("create")) {
				router.get(
					`/admin/${slug}/new`,
					gate(this.#buildNewFormHandler(resource)),
				);
				router.post(`/admin/${slug}`, gate(this.#buildCreateHandler(resource)));
			}
			if (resource.actions.includes("show")) {
				router.get(
					`/admin/${slug}/:id`,
					gate(this.#buildShowHandler(resource)),
				);
			}
			if (resource.actions.includes("edit")) {
				router.get(
					`/admin/${slug}/:id/edit`,
					gate(this.#buildEditFormHandler(resource)),
				);
				router.put(
					`/admin/${slug}/:id`,
					gate(this.#buildUpdateHandler(resource)),
				);
			}
			if (resource.actions.includes("destroy")) {
				router.delete(
					`/admin/${slug}/:id`,
					gate(this.#buildDestroyHandler(resource)),
				);
			}
			// Browser forms can't issue PUT/DELETE — accept POST with `_method`
			// from the auto-generated form (form.ts stamps the hidden input),
			// dispatching only to the actions this resource enables.
			if (
				resource.actions.includes("edit") ||
				resource.actions.includes("destroy")
			) {
				router.post(
					`/admin/${slug}/:id`,
					gate(this.#buildMethodOverrideHandler(resource)),
				);
			}
		}
	}

	/**
	 * 56.5 — every admin action is now gated behind a
	 * `<prefix>.<resource>.<action>` permission resolved through @c9up/warden
	 * (`auth.hasPermission`). Warn ONCE at boot, only when the auth layer
	 * is wired, that the host must seed roles/grants in the Warden rights
	 * store — otherwise every admin request 403s with no hint. The old
	 * "missing policy entry" warning is gone with the 54.4 callback table.
	 */
	#warnSeedPermissionsOnce(resources: ReadonlyArray<Resource>): void {
		if (seedPermsWarned) return;
		// Only meaningful once the Warden layer is wired — the dev-preview /
		// no-warden path leaves the gate open, so there's nothing to seed.
		if (this.#authManager === undefined) return;
		if (resources.length === 0) return;
		seedPermsWarned = true;
		const [example] = resources;
		if (example === undefined) return;
		const prefix = this.#authConfig.permissionPrefix;
		const access = this.#authConfig.accessPermission;
		const perms = [
			...(access === undefined ? [] : [access]),
			`${prefix}.${example.name}.list`,
			`${prefix}.${example.name}.create`,
		];
		console.warn(
			`[station] Admin actions are gated behind '${prefix}.<resource>.<action>' permissions resolved through @c9up/warden${access === undefined ? "" : `, and entering the admin behind '${access}'`}. Seed roles/grants in the Warden rights store (store.defineRole('admin', [${perms.map((p) => `'${p}'`).join(", ")}, ...]) then assignRole) or every admin request will 403. See https://ream.dev/modules/station#authorization.`,
		);
	}

	#warnAuditGapsOnce(resources: ReadonlyArray<Resource>): void {
		if (missingAuditWarned) return;
		const writeActions: ReadonlyArray<ResourceAction> = [
			"create",
			"edit",
			"destroy",
		];
		const missing = resources.filter(
			(r) =>
				r.audit === undefined &&
				r.actions.some((a) => writeActions.includes(a)),
		);
		if (missing.length === 0) return;
		missingAuditWarned = true;
		console.warn(
			`[station] No audit sink configured for write-enabled resources: ${missing.map((r) => r.name).join(", ")}. Pass 'audit:' in defineResource() to persist mutations to your audit log.`,
		);
	}

	async shutdown(): Promise<void> {
		// Release the module-level singleton, while it is still ours. A stopped
		// application left a dead resource registry reachable through `services/main`, and
		// with two applications in one process the survivor's binding must not
		// be the one cleared.
		if (this.#owned !== undefined && getStation() === this.#owned)
			clearStation();
		this.#owned = undefined;
	}

	#requireContext(resource: Resource): ResourceContext {
		const ctx = this.#contexts.get(resource);
		if (!ctx) {
			throw new Error(
				`[station] No repository available for ${resource.entity.name}. Did you register @c9up/atlas/provider in reamrc.ts?`,
			);
		}
		return ctx;
	}

	/**
	 * The derived rune schema for a write handler (57.7). Present by construction
	 * — start() fail-closes at boot when a write action is mounted without
	 * `@c9up/rune` — so an undefined here is an internal invariant break; throw
	 * loud (fail-closed) rather than silently accept an unvalidated body.
	 */
	#requireWritableSchema(
		resource: Resource,
		mode: "create" | "update",
	): RuneSchema {
		const context = this.#requireContext(resource);
		const writableSchema =
			mode === "create" ? context.writableSchema : context.updateSchema;
		if (writableSchema === undefined) {
			throw new Error(
				`[station] No validation schema for ${resource.entity.name} — @c9up/rune must be installed to accept admin writes.`,
			);
		}
		return writableSchema;
	}

	/**
	 * Fail-closed response for invalid write input (57.7, AC4). Content-negotiated:
	 *
	 *  - **JSON/XHR** → `422` with `{ error, code: "E_VALIDATION_ERROR", messages }`
	 *    (Adonis parity — API clients get the machine-readable errors).
	 *  - **HTML with a session** → the AdonisJS web idiom (PRG): flash the old
	 *    input + per-field errors, then `redirect().back()` to the form `GET`,
	 *    which re-reads the flash and re-renders with values + errors. No inline
	 *    body — the browser lands on a fresh form (no re-POST on refresh).
	 *  - **HTML without a session** → graceful fallback: re-render the form inline
	 *    at `422` so the errors are never silently lost when no `SessionMiddleware`
	 *    ran. (`row` supplies the id/action on EDIT; undefined keeps CREATE mode.)
	 *
	 * `redirect().back()` semantics are replicated over Station's `redirect(url)`
	 * seam ({@link redirectBack}) with the same same-origin guard ream's
	 * `RedirectBuilder.back()` uses — `formUrl` is the safe fallback.
	 */
	async #denyValidation(
		ctx: StationHttpContext,
		resource: Resource,
		submitted: Record<string, unknown>,
		errors: ReadonlyArray<RuneValidationError>,
		formUrl: string,
		row?: Readonly<Record<string, unknown>>,
	): Promise<void> {
		if (wantsJsonResponse(ctx)) {
			ctx.response.status(422);
			// AdonisJS parity: `{ errors: [{ field, rule, message }] }` —
			// the same shape ream's own `E_VALIDATION_ERROR` handler emits. The
			// root failure reads `""` whichever rune release reported it.
			ctx.response.json({
				errors: errors.map((e) => ({
					field: isRootError(e) ? "" : e.field,
					rule: e.rule,
					message: e.message,
				})),
			});
			return;
		}
		// Echo only declared, non-sensitive columns back to the form — never
		// `_csrf`, secrets, or mass-assignment keys (both the flash store and the
		// re-rendered HTML). An empty result falls back to `row`.
		const { formColumns, pkColumn, writeOnly } = this.#requireContext(resource);
		const safe = flashableInput(submitted, formColumns, writeOnly);
		const { fields, form } = formErrors(errors);
		if (ctx.session !== undefined) {
			// AdonisJS PRG: flash old input + errors, redirect back to the form.
			ctx.session.flashAll(safe);
			ctx.session.flash(FLASH_ERRORS_KEY, fields);
			if (form !== undefined) {
				ctx.session.flash(FLASH_FORM_ERRORS_KEY, {
					[VALIDATION_ERROR_CODE]: form,
				});
			}
			redirectBack(ctx, formUrl);
			return;
		}
		// No session middleware — fall back to an inline 422 re-render so the
		// submitted values + errors are still shown rather than silently dropped.
		const vm = buildFormViewModel({
			resource,
			columns: formColumns,
			pkColumn,
			writeOnly,
			row,
			values: Object.keys(safe).length > 0 ? safe : undefined,
			errors: fields,
			formError: form,
			csrfEnabled: ctx.store?.get("csrfToken") != null,
		});
		ctx.response.status(422);
		const html = await this.#renderView(ctx, "station::form", vm);
		ctx.response.type("text/html; charset=utf-8");
		ctx.response.send(html);
	}

	#buildListHandler(
		resource: Resource,
	): (ctx: StationHttpContext) => Promise<void> {
		return async (ctx) => {
			const { repo, listColumns, pkColumn } = this.#requireContext(resource);
			// 56.5: the list action is gated behind `<resource>.list` like
			// every other action — resolved through the Warden `"auth"`
			// layer. (Retro 2026-06-01: list previously skipped the gate
			// entirely, leaking the index regardless of authorization.)
			if (!(await this.#authorize(ctx, resource, "list"))) return;
			const qs = ctx.request.qs();
			const page = clampPositiveInt(qs.page, 1);
			const perPageRaw = clampPositiveInt(qs.perPage, DEFAULT_PER_PAGE);
			const perPage = Math.min(perPageRaw, MAX_PER_PAGE);
			if (perPage < perPageRaw && !perPageClampWarned) {
				perPageClampWarned = true;
				console.warn(
					`[station] perPage clamped to ${MAX_PER_PAGE} (got ${perPageRaw}). Suppressing further warnings.`,
				);
			}

			// De-hand-rolled (57.5): atlas `paginate()` runs the parallel
			// COUNT(*) + LIMIT/OFFSET data fetch in one call and owns the
			// `lastPage = ceil(total/perPage)` math Station used to duplicate.
			// Station keeps only the `MAX_PER_PAGE` clamp (above) and the
			// redirect-to-last-page wrapper — atlas floors perPage to ≥1 but
			// does not cap it.
			// Past this page `(page-1)*perPage` is no longer an exact integer:
			// atlas / the driver reject that offset, which surfaced as a 500.
			// No table that size exists, so such a page is past the end — count
			// through page 1 and send the caller to the real last page.
			if (page > Math.floor(Number.MAX_SAFE_INTEGER / perPage) + 1) {
				const first = await repo
					.query()
					.orderBy(pkColumn, "desc")
					.paginate(1, perPage);
				ctx.response.redirect(
					`/admin/${resource.name}?page=${Math.max(1, first.meta.lastPage)}&perPage=${perPage}`,
				);
				return;
			}
			const result = await repo
				.query()
				.orderBy(pkColumn, "desc")
				.paginate(page, perPage);
			if (page > result.meta.lastPage && result.meta.total > 0) {
				// Never render an empty page when one exists — redirect to the
				// last real page so the user lands on something useful.
				ctx.response.redirect(
					`/admin/${resource.name}?page=${result.meta.lastPage}&perPage=${perPage}`,
				);
				return;
			}

			const viewModel = buildListViewModel({
				resource,
				rows: result.all(),
				columns: listColumns,
				pkColumn,
				page: result.meta.currentPage,
				perPage: result.meta.perPage,
				total: result.meta.total,
				lastPage: result.meta.lastPage,
			});
			const html = await this.#renderView(ctx, "station::list", viewModel);
			ctx.response.type("text/html; charset=utf-8");
			ctx.response.send(html);
		};
	}

	#buildShowHandler(
		resource: Resource,
	): (ctx: StationHttpContext) => Promise<void> {
		return async (ctx) => {
			const { repo, showColumns, pkColumn, pkType } =
				this.#requireContext(resource);
			// Authorize BEFORE the existence check so an unauthorized caller
			// can't distinguish 404 (absent) from 403 (exists) — no row-existence
			// oracle for a user without `<resource>.show`.
			if (!(await this.#authorize(ctx, resource, "show"))) return;
			const id = ctx.params.id ?? "";
			const row = await findRecord(repo, pkType, id);
			if (row === null) {
				const notFoundHtml = await this.#renderNotFound(ctx, resource, id);
				ctx.response.status(404);
				ctx.response.type("text/html; charset=utf-8");
				ctx.response.send(notFoundHtml);
				return;
			}
			const viewModel = buildShowViewModel({
				resource,
				row,
				columns: showColumns,
				pkColumn,
			});
			const html = await this.#renderView(ctx, "station::show", viewModel);
			ctx.response.type("text/html; charset=utf-8");
			ctx.response.send(html);
		};
	}

	#buildNewFormHandler(
		resource: Resource,
	): (ctx: StationHttpContext) => Promise<void> {
		return async (ctx) => {
			const { formColumns, pkColumn, writeOnly } =
				this.#requireContext(resource);
			if (!(await this.#authorize(ctx, resource, "create"))) return;
			// 57.7 — after a failed create redirected back (PRG), the flash carries
			// the old input + per-field errors; re-populate + surface them.
			const { values, errors, formError } = readFlash(ctx, formColumns);
			const vm = buildFormViewModel({
				resource,
				columns: formColumns,
				pkColumn,
				writeOnly,
				values,
				errors,
				formError,
				csrfEnabled: ctx.store?.get("csrfToken") != null,
			});
			const html = await this.#renderView(ctx, "station::form", vm);
			ctx.response.type("text/html; charset=utf-8");
			ctx.response.send(html);
		};
	}

	#buildCreateHandler(
		resource: Resource,
	): (ctx: StationHttpContext) => Promise<void> {
		return async (ctx) => {
			// Fail-close: reject a request whose CSRF was not enforced+validated
			// (blackhole unwired / csrf:false / route excepted) BEFORE any auth or
			// DB work — no 404-vs-403 oracle to a forged request. A seeded token is
			// not proof; only `csrfProtected === true` is (AC4/AC7).
			if (ctx.request.csrfProtected !== true) {
				await this.#denyCsrf(ctx);
				return;
			}
			const { repo, pkColumn, columns, booleanKeys, writeOnly, redacted } =
				this.#requireContext(resource);
			if (!(await this.#authorize(ctx, resource, "create"))) return;
			const payload = await readPayload(ctx);
			const body = isPlainRecord(payload) ? payload : {};
			// 57.7 — validate + mass-assignment guard in one pass. `result.data`
			// holds ONLY editable-column keys (the allow-list: `editable`, or every
			// non-secret, non-hidden, non-framework column), so a forged `isAdmin`
			// on a hidden column, a secret column, the PK or a timestamp is dropped
			// by the schema, and each field is type-checked.
			// Invalid input fail-closes with a 422 BEFORE any repository write (AC4).
			const result = validateWritableBody(
				this.#requireWritableSchema(resource, "create"),
				booleanKeys,
				payload,
				writeOnly,
			);
			if (!result.valid) {
				// PRG fallback URL = the create form (AdonisJS `redirect().back()`).
				const formUrl = `/admin/${encodeURIComponent(resource.name)}/new`;
				await this.#denyValidation(ctx, resource, body, result.errors, formUrl);
				return;
			}
			const created = await repo.create(result.data);
			await emitAudit(resource, {
				action: "create",
				resource: resource.name,
				recordId: created[pkColumn],
				userId: ctx.auth?.user?.id,
				...requestOrigin(ctx),
				after: snapshotEntity(created, columns, redacted),
				at: new Date(),
			});
			redirectToShow(ctx, resource, created[pkColumn]);
		};
	}

	#buildEditFormHandler(
		resource: Resource,
	): (ctx: StationHttpContext) => Promise<void> {
		return async (ctx) => {
			const { repo, formColumns, pkColumn, pkType, writeOnly } =
				this.#requireContext(resource);
			// Authorize before the existence check (no 404-vs-403 oracle).
			if (!(await this.#authorize(ctx, resource, "edit"))) return;
			const id = ctx.params.id ?? "";
			const row = await findRecord(repo, pkType, id);
			if (row === null) {
				const notFoundHtml = await this.#renderNotFound(ctx, resource, id);
				ctx.response.status(404);
				ctx.response.type("text/html; charset=utf-8");
				ctx.response.send(notFoundHtml);
				return;
			}
			// 57.7 — after a failed update redirected back (PRG), the flash carries
			// the submitted values + errors; they win over the DB `row` so the user
			// sees what they typed. A normal edit GET has no flash → fields from row.
			const { values, errors, formError } = readFlash(ctx, formColumns);
			const vm = buildFormViewModel({
				resource,
				columns: formColumns,
				pkColumn,
				writeOnly,
				row,
				values,
				errors,
				formError,
				csrfEnabled: ctx.store?.get("csrfToken") != null,
			});
			const html = await this.#renderView(ctx, "station::form", vm);
			ctx.response.type("text/html; charset=utf-8");
			ctx.response.send(html);
		};
	}

	#buildUpdateHandler(
		resource: Resource,
	): (ctx: StationHttpContext) => Promise<void> {
		return async (ctx) => {
			// Fail-close on CSRF before any auth/DB work (see #buildCreateHandler).
			if (ctx.request.csrfProtected !== true) {
				await this.#denyCsrf(ctx);
				return;
			}
			const {
				repo,
				pkColumn,
				pkType,
				columns,
				booleanKeys,
				writeOnly,
				redacted,
			} = this.#requireContext(resource);
			// Authorize before the existence check (no 404-vs-403 oracle).
			if (!(await this.#authorize(ctx, resource, "edit"))) return;
			const id = ctx.params.id ?? "";
			const entity = await findRecord(repo, pkType, id);
			if (entity === null) {
				const notFoundHtml = await this.#renderNotFound(ctx, resource, id);
				ctx.response.status(404);
				ctx.response.type("text/html; charset=utf-8");
				ctx.response.send(notFoundHtml);
				return;
			}
			const payload = await readPayload(ctx);
			const body = isPlainRecord(payload) ? payload : {};
			// 57.7 — validate BEFORE any snapshot or mutation (AC4). On failure the
			// entity is untouched (no `setProp`, no `save`), so a bad edit never
			// poisons the audit diff nor emits a success event; the form re-renders
			// 422 with the submitted values + per-field errors (the existing entity
			// still supplies the id/action).
			const result = validateWritableBody(
				this.#requireWritableSchema(resource, "update"),
				booleanKeys,
				payload,
				writeOnly,
			);
			if (!result.valid) {
				// PRG fallback URL = this row's edit form (AdonisJS `redirect().back()`).
				const formUrl = `/admin/${encodeURIComponent(resource.name)}/${encodeURIComponent(id)}/edit`;
				await this.#denyValidation(
					ctx,
					resource,
					body,
					result.errors,
					formUrl,
					entity,
				);
				return;
			}
			// Snapshot BEFORE the mutation runs so the audit diff is
			// meaningful (entity is a BaseEntity; its dirty-tracking
			// would shadow the original values after setProp). `result.data`
			// holds only declared, type-checked columns — the mass-assignment
			// guarantee (PK / timestamps / unknown keys dropped) is inherent.
			const beforeSnapshot = snapshotEntity(entity, columns, redacted);
			const rawSecrets: Record<string, unknown> = {};
			for (const key of redacted) rawSecrets[key] = entity[key];
			for (const [key, value] of Object.entries(result.data)) {
				entity.setProp(key, value);
			}
			await repo.save(entity);
			const afterSnapshot = snapshotEntity(entity, columns, redacted);
			await emitAudit(resource, {
				action: "edit",
				resource: resource.name,
				recordId: entity[pkColumn],
				userId: ctx.auth?.user?.id,
				...requestOrigin(ctx),
				before: beforeSnapshot,
				after: afterSnapshot,
				redactedChanges: changedRedacted(rawSecrets, entity, redacted),
				at: new Date(),
			});
			redirectToShow(ctx, resource, entity[pkColumn]);
		};
	}

	#buildMethodOverrideHandler(
		resource: Resource,
	): (ctx: StationHttpContext) => Promise<void> {
		// Browser forms can only emit GET / POST. The auto-generated edit
		// form ships `<input type="hidden" name="_method" value="PUT">`
		// so the POST /admin/:r/:id endpoint can route to the update
		// handler. Only the enabled actions get a handler: an override naming a
		// disabled one is refused like any unsupported method, so `actions`
		// stays the boundary of what the admin can do to a resource.
		const updateHandler = resource.actions.includes("edit")
			? this.#buildUpdateHandler(resource)
			: undefined;
		const destroyHandler = resource.actions.includes("destroy")
			? this.#buildDestroyHandler(resource)
			: undefined;
		const allowed = [
			...(updateHandler === undefined ? [] : ["PUT", "PATCH"]),
			...(destroyHandler === undefined ? [] : ["DELETE"]),
		];
		return async (ctx) => {
			// Fail-close on CSRF before reading the body (see #buildCreateHandler).
			// The PUT/DELETE branches delegate to already-guarded handlers, but the
			// unsupported-override 405 branch would otherwise do work on a forged
			// request and leak a 403-vs-405 oracle — guard the entrypoint too.
			if (ctx.request.csrfProtected !== true) {
				await this.#denyCsrf(ctx);
				return;
			}
			const body = await readBody(ctx);
			const override = String(body._method ?? "").toUpperCase();
			if (
				updateHandler !== undefined &&
				(override === "PUT" || override === "PATCH")
			) {
				return updateHandler(ctx);
			}
			if (destroyHandler !== undefined && override === "DELETE") {
				return destroyHandler(ctx);
			}
			// Unsupported or disabled override — refuse rather than silently
			// downgrade to a no-op so misconfigured forms surface immediately.
			ctx.response.status(405);
			ctx.response.type("text/html; charset=utf-8");
			ctx.response.send(
				`<h1>405 Method Not Allowed</h1><p>POST /admin/${escapeMin(resource.name)}/:id accepts <code>_method</code> = ${escapeMin(allowed.join(" | "))}.</p>`,
			);
		};
	}

	#buildDestroyHandler(
		resource: Resource,
	): (ctx: StationHttpContext) => Promise<void> {
		return async (ctx) => {
			// Fail-close on CSRF before any auth/DB work (see #buildCreateHandler).
			if (ctx.request.csrfProtected !== true) {
				await this.#denyCsrf(ctx);
				return;
			}
			const { repo, pkColumn, pkType, columns, redacted } =
				this.#requireContext(resource);
			// Authorize before the existence check (no 404-vs-403 oracle).
			if (!(await this.#authorize(ctx, resource, "destroy"))) return;
			const id = ctx.params.id ?? "";
			const row = await findRecord(repo, pkType, id);
			if (row === null) {
				const notFoundHtml = await this.#renderNotFound(ctx, resource, id);
				ctx.response.status(404);
				ctx.response.type("text/html; charset=utf-8");
				ctx.response.send(notFoundHtml);
				return;
			}
			const before = snapshotEntity(row, columns, redacted);
			await repo.delete(row);
			await emitAudit(resource, {
				action: "destroy",
				resource: resource.name,
				recordId: row[pkColumn],
				userId: ctx.auth?.user?.id,
				...requestOrigin(ctx),
				before,
				at: new Date(),
			});
			ctx.response.redirect(`/admin/${encodeURIComponent(resource.name)}`);
		};
	}

	async #resolveDb(): Promise<unknown> {
		try {
			return await this.app.container.resolve<unknown>("db");
		} catch (cause) {
			throw new Error(
				`[station] No 'db' connection registered. Did you register @c9up/atlas/provider in reamrc.ts?`,
				{ cause },
			);
		}
	}

	// ───────────────────────────────────────────────────────────────────────
	// Story 54.7 — Warden integration
	// ───────────────────────────────────────────────────────────────────────

	/**
	 * Resolve the inbound auth token. Cookie wins over Authorization
	 * header because the cookie is what the login handler set; the
	 * Bearer fallback exists for API-style callers (curl / fetch with
	 * Authorization).
	 */
	#readAuthToken(ctx: StationHttpContext): string | undefined {
		const cookieName = this.#authConfig.cookieName;
		const fromCookie = ctx.request.cookie?.(cookieName);
		if (typeof fromCookie === "string" && fromCookie.length > 0) {
			return fromCookie;
		}
		const authHeader = ctx.request.header?.("authorization");
		if (typeof authHeader === "string" && authHeader.length > 0) {
			const trimmed = authHeader.trim();
			if (trimmed.toLowerCase().startsWith("bearer ")) {
				return trimmed.slice(7).trim();
			}
		}
		return undefined;
	}

	/**
	 * Decide whether to redirect (HTML browser flow) or 401-json (XHR /
	 * API flow). `Accept: application/json` OR `X-Requested-With:
	 * XMLHttpRequest` triggers the JSON shape; everything else gets the
	 * 302 to the login page.
	 */
	#wantsJsonResponse(ctx: StationHttpContext): boolean {
		return wantsJsonResponse(ctx);
	}

	/**
	 * Wrap a CRUD handler with the auth gate. Reads token from cookie/
	 * header → `authManager.verify(token)` → on success populates
	 * `ctx.auth.user` (and `ctx.auth.roles` when present on the user
	 * record) and delegates. On failure: JSON callers get 401, HTML
	 * callers get a 302 to `loginPath`.
	 *
	 * Role check (`requireRole`) is applied AFTER auth: an authenticated
	 * user without the role gets 403 (or 403-json), never a redirect —
	 * a redirect to login wouldn't help them.
	 */
	#withAuth(
		handler: (ctx: StationHttpContext) => Promise<void>,
	): (ctx: StationHttpContext) => Promise<void> {
		return async (ctx: StationHttpContext): Promise<void> => {
			const manager = this.#authManager;
			if (manager === undefined) {
				// Auth gate enabled but no manager wired — shouldn't happen
				// because we only set requireAuth=true when the container
				// resolved `auth`. Fail closed: treat as a 500.
				ctx.response.status(500);
				ctx.response.type("text/plain; charset=utf-8");
				ctx.response.send(
					"[station] auth gate enabled but AuthManager missing",
				);
				return;
			}
			const token = this.#readAuthToken(ctx);
			if (token === undefined) {
				if (this.#wantsJsonResponse(ctx)) {
					ctx.response.status(401);
					ctx.response.json({ error: "authentication required" });
					return;
				}
				ctx.response.redirect(this.#authConfig.loginPath);
				return;
			}
			const result = await manager.verify(token, this.#authConfig.guard);
			if (!result.authenticated || result.user === undefined) {
				// A strategy CRASH (the auth backend threw) is a server fault, not a
				// failed/expired login — don't clear the cookie or bounce to /login
				// as if the session died. Surface 503 so the real error isn't masked
				// as a routine re-login (audit 2026-06-13).
				if (result.strategyCrash) {
					ctx.response.status(503);
					if (this.#wantsJsonResponse(ctx)) {
						ctx.response.json({ error: "authentication service unavailable" });
					} else {
						ctx.response.type("text/html; charset=utf-8");
						ctx.response.send(
							"<h1>503 Service Unavailable</h1><p>Authentication is temporarily unavailable. Please try again.</p>",
						);
					}
					return;
				}
				// Clear the stale cookie regardless of response shape, so neither
				// a browser refresh nor an XHR caller retries with the dead token.
				ctx.response.clearCookie?.(this.#authConfig.cookieName, {
					path: AUTH_COOKIE_PATH,
				});
				if (this.#wantsJsonResponse(ctx)) {
					ctx.response.status(401);
					ctx.response.json({
						error: result.error ?? "invalid or expired session",
					});
					return;
				}
				ctx.response.redirect(this.#authConfig.loginPath);
				return;
			}
			const user = result.user;
			const rawRoles = user.roles;
			// `userRoles` is still derived for view rendering (ctx.auth.roles
			// below), but the GATE decision now comes from the Warden
			// resolver via `auth.hasRole` — no parallel Station-local RBAC
			// (D5/AC-E6). A forgotten `await` would make a truthy Promise
			// pass the `!` test = silent allow, so the call is awaited.
			const userRoles: string[] = Array.isArray(rawRoles)
				? rawRoles.filter((r): r is string => typeof r === "string")
				: [];
			const required = this.#authConfig.requireRole;
			if (required !== undefined) {
				let roleOk: boolean;
				try {
					// `=== true`: a non-boolean resolution must not pass. A throw
					// (rights-store outage) denies rather than 500-ing.
					roleOk = (await manager.hasRole(user, required, "global")) === true;
				} catch (err) {
					const detail = err instanceof Error ? err.message : String(err);
					console.error(
						`[station] role check threw for '${required}' — denying (fail-closed): ${detail}`,
					);
					roleOk = false;
				}
				if (!roleOk) {
					await this.#securityEvent(ctx, {
						action: "denied",
						userId: user.id,
						permission: `role:${required}`,
					});
					if (this.#wantsJsonResponse(ctx)) {
						ctx.response.status(403);
						ctx.response.json({ error: "insufficient role" });
						return;
					}
					ctx.response.status(403);
					ctx.response.type("text/plain; charset=utf-8");
					ctx.response.send("Forbidden");
					return;
				}
			}
			// Entering the admin is its own grant (bug 214): without it, any app
			// user holding a same-named permission for the public app got in.
			const access = this.#authConfig.accessPermission;
			if (access !== undefined) {
				let accessOk: boolean;
				try {
					accessOk =
						(await manager.hasPermission(user, access, "global")) === true;
				} catch (err) {
					const detail = err instanceof Error ? err.message : String(err);
					console.error(
						`[station] access check threw for '${access}' — denying (fail-closed): ${detail}`,
					);
					accessOk = false;
				}
				if (!accessOk) {
					await this.#securityEvent(ctx, {
						action: "denied",
						userId: user.id,
						permission: access,
					});
					deny(ctx);
					return;
				}
			}
			const existingAuth = ctx.auth ?? {};
			ctx.auth = {
				...existingAuth,
				user,
				roles: userRoles.length > 0 ? userRoles : existingAuth.roles,
			};
			await handler(ctx);
		};
	}

	/**
	 * `GET /admin/login` — render the sign-in form. If the caller is
	 * already authenticated, redirect to `/admin` to avoid bouncing them
	 * back through the form they don't need.
	 */
	#buildLoginFormHandler(): (ctx: StationHttpContext) => Promise<void> {
		return async (ctx: StationHttpContext): Promise<void> => {
			const manager = this.#authManager;
			if (manager !== undefined) {
				const token = this.#readAuthToken(ctx);
				if (typeof token === "string" && token.length > 0) {
					const result = await manager.verify(token, this.#authConfig.guard);
					if (result.authenticated) {
						ctx.response.redirect("/admin");
						return;
					}
				}
			}
			// No `?error=` read: Station never redirects with one (a failed POST
			// re-renders inline), so its only use was a third party writing
			// arbitrary text into the sign-in page's alert.
			const vm = buildLoginViewModel({
				action: this.#authConfig.loginPath,
				csrfEnabled: ctx.store?.get("csrfToken") != null,
			});
			const html = await this.#renderView(ctx, "station::login", vm);
			ctx.response.type("text/html; charset=utf-8");
			ctx.response.send(html);
		};
	}

	/**
	 * `POST /admin/login` — accept `{email, password}`, run them through
	 * `authManager.authenticate`, set the session cookie on success.
	 * Re-renders the form with an inline error on failure (preserves the
	 * submitted email so the user doesn't retype it).
	 */
	#buildLoginPostHandler(): (ctx: StationHttpContext) => Promise<void> {
		return async (ctx: StationHttpContext): Promise<void> => {
			// Fail-close on CSRF first — a forged login POST is refused before any
			// AuthManager work (see #buildCreateHandler). Login is open by design
			// (no auth gate), so CSRF is the sole pre-check here.
			if (ctx.request.csrfProtected !== true) {
				await this.#denyCsrf(ctx);
				return;
			}
			const manager = this.#authManager;
			if (manager === undefined) {
				ctx.response.status(500);
				ctx.response.type("text/plain; charset=utf-8");
				ctx.response.send("[station] login posted but AuthManager missing");
				return;
			}
			const body = await readBody(ctx);
			const email = typeof body.email === "string" ? body.email.trim() : "";
			const password = typeof body.password === "string" ? body.password : "";
			if (email.length === 0 || password.length === 0) {
				await this.#refuseLogin(ctx, email, {
					status: 400,
					code: "E_STATION_LOGIN_CREDENTIALS_REQUIRED",
					message: "Email and password are both required.",
				});
				return;
			}
			// Counted BEFORE the credential check (warden's AuthRateLimiter
			// contract): a refused attempt never reaches authenticate.
			const keys = loginKeys(ctx.request.ip?.() ?? "unknown", email);
			if (!(await this.#admitLogin(ctx, keys, email))) return;
			const result = await manager.authenticate(
				{ email, password },
				this.#authConfig.guard,
			);
			// A strategy that threw is a server fault, not a failed sign-in:
			// the operator gets the backend's message, the visitor a 503 that
			// says nothing about it, and no `login_failed` is recorded.
			if (result.strategyCrash === true) {
				console.error(
					`[station] admin sign-in failed in the auth backend: ${result.error ?? "unknown error"}`,
				);
				await this.#refuseLogin(ctx, email, {
					status: 503,
					code: "E_STATION_LOGIN_UNAVAILABLE",
					message: "Sign-in is temporarily unavailable.",
				});
				return;
			}
			// Warden returns the issued token on `user.token`, not at the
			// top level — reading `result.token` (which never exists) sent
			// every valid login down the 401 branch.
			const token =
				typeof result.user?.token === "string" ? result.user.token : undefined;
			if (!result.authenticated || token === undefined) {
				await this.#securityEvent(ctx, {
					action: "login_failed",
					identifier: email,
				});
				// Never `result.error`: warden's authenticate() turns any thrown
				// error into that string, so it can carry a database or lookup
				// failure's own wording to an unauthenticated visitor.
				await this.#refuseLogin(ctx, email, {
					status: 401,
					code: "E_STATION_INVALID_CREDENTIALS",
					message: "Invalid email or password.",
				});
				return;
			}
			await this.#loginLimiter?.clear(...keys);
			await this.#securityEvent(ctx, {
				action: "login",
				userId: result.user?.id,
				identifier: email,
			});
			// No maxAge: a session cookie, gone with the browser; the token's own
			// expiry is enforced by verify() on every request.
			ctx.response.cookie?.(this.#authConfig.cookieName, token, {
				httpOnly: true,
				sameSite: "Lax",
				secure: this.#cookieSecure ?? secureByDefault(ctx),
				path: AUTH_COOKIE_PATH,
			});
			ctx.response.redirect("/admin");
		};
	}

	/**
	 * The per-action gate: allow, or record the refusal and answer 403.
	 */
	async #authorize(
		ctx: StationHttpContext,
		resource: Resource,
		action: ResourceAction,
	): Promise<boolean> {
		const prefix = this.#authConfig.permissionPrefix;
		if (
			await authorizeAction(resource, action, ctx, this.#authManager, prefix)
		) {
			return true;
		}
		await this.#securityEvent(ctx, {
			action: "denied",
			userId: ctx.auth?.user?.id,
			resource: resource.name,
			resourceAction: action,
			permission: `${prefix}.${resource.name}.${action}`,
		});
		deny(ctx);
		return false;
	}

	/** Record a CSRF block, then refuse it. */
	async #denyCsrf(ctx: StationHttpContext): Promise<void> {
		await this.#securityEvent(ctx, { action: "csrf_denied" });
		denyCsrf(ctx);
	}

	/**
	 * Send a security event to `station.audit`, stamped with the request
	 * origin. A failing sink is logged, never allowed to change the response.
	 */
	async #securityEvent(
		ctx: StationHttpContext,
		event: Omit<
			SecurityAuditEvent,
			"at" | "ip" | "userAgent" | "requestId" | "path"
		>,
	): Promise<void> {
		const sink = this.#securityAudit;
		if (sink === undefined) return;
		try {
			await sink({
				...event,
				...requestOrigin(ctx),
				path: ctx.request.url?.(),
				at: new Date(),
			});
		} catch (err) {
			const detail = err instanceof Error ? err.message : String(err);
			console.error(
				`[station] security audit sink threw on ${event.action}: ${detail}. The event was NOT recorded.`,
			);
		}
	}

	/**
	 * Revoke `token` through the default guard when it supports revocation.
	 * A guard without it (or a JwtStrategy without a blacklist, whose
	 * `revoke` throws) is reported once: logout then only clears the cookie.
	 */
	async #revoke(token: string): Promise<void> {
		const strategy = this.#authManager?.getStrategy?.(this.#authConfig.guard);
		let reason = "the auth guard has no revoke(token)";
		if (
			typeof strategy === "object" &&
			strategy !== null &&
			"revoke" in strategy &&
			typeof strategy.revoke === "function"
		) {
			try {
				await strategy.revoke(token);
				return;
			} catch (err) {
				reason = err instanceof Error ? err.message : String(err);
			}
		}
		if (revokeUnavailableWarned) return;
		revokeUnavailableWarned = true;
		console.warn(
			`[station] Logout cannot revoke the admin token (${reason}); it stays valid until it expires. Give warden's JwtStrategy a \`blacklist\` so a logged-out token is refused.`,
		);
	}

	/**
	 * Count a login attempt and answer the refusal when the limiter says no:
	 * 429 + Retry-After when exhausted, 503 when the limiter itself failed (a
	 * throttle that cannot count must not wave attempts through).
	 */
	async #admitLogin(
		ctx: StationHttpContext,
		keys: string[],
		email: string,
	): Promise<boolean> {
		const limiter = this.#loginLimiter;
		if (limiter === undefined) return true;
		let decision: { allowed: boolean; retryAfterSeconds: number };
		try {
			decision = await limiter.attempt(...keys);
		} catch (err) {
			const detail = err instanceof Error ? err.message : String(err);
			console.error(
				`[station] login rate limiter failed — refusing the attempt (fail-closed): ${detail}`,
			);
			await this.#refuseLogin(ctx, email, {
				status: 503,
				code: "E_STATION_LOGIN_UNAVAILABLE",
				message: "Sign-in is temporarily unavailable.",
			});
			return false;
		}
		if (decision.allowed) return true;
		await this.#securityEvent(ctx, {
			action: "login_throttled",
			identifier: email,
		});
		ctx.response.header(
			"Retry-After",
			String(Math.max(1, Math.ceil(decision.retryAfterSeconds))),
		);
		await this.#refuseLogin(ctx, email, {
			status: 429,
			code: "E_STATION_TOO_MANY_LOGIN_ATTEMPTS",
			message: "Too many sign-in attempts. Try again later.",
		});
		return false;
	}

	/**
	 * Answer a refused sign-in with the gate's content negotiation: a JSON or
	 * XHR caller gets `{ error, code }`, a browser the sign-in page with the
	 * message as its alert and the submitted email kept.
	 */
	async #refuseLogin(
		ctx: StationHttpContext,
		email: string,
		refusal: { status: number; code: string; message: string },
	): Promise<void> {
		ctx.response.status(refusal.status);
		if (wantsJsonResponse(ctx)) {
			ctx.response.json({ error: refusal.message, code: refusal.code });
			return;
		}
		const vm = buildLoginViewModel({
			action: this.#authConfig.loginPath,
			email,
			error: refusal.message,
			csrfEnabled: ctx.store?.get("csrfToken") != null,
		});
		const html = await this.#renderView(ctx, "station::login", vm);
		ctx.response.type("text/html; charset=utf-8");
		ctx.response.send(html);
	}

	/**
	 * `POST /admin/logout` — clear the session cookie and redirect to
	 * the login page. POST (not GET) so a crafted `<img src>` can't log
	 * someone out via CSRF.
	 */
	#buildLogoutHandler(): (ctx: StationHttpContext) => Promise<void> {
		return async (ctx: StationHttpContext): Promise<void> => {
			// Fail-close on CSRF: a forged cross-site POST must not be able to log
			// an admin out (session-fixation nuisance) (see #buildCreateHandler).
			if (ctx.request.csrfProtected !== true) {
				await this.#denyCsrf(ctx);
				return;
			}
			// Clearing the cookie alone left the token valid until it expired:
			// a copy taken before logout (shared machine, proxy log) still
			// opened the admin.
			const token = this.#readAuthToken(ctx);
			if (token !== undefined) {
				// Who is leaving, read before the token is revoked — only when
				// someone is listening, since it costs a verify().
				const userId =
					this.#securityAudit === undefined
						? undefined
						: (await this.#authManager?.verify(token, this.#authConfig.guard))
								?.user?.id;
				await this.#revoke(token);
				await this.#securityEvent(ctx, { action: "logout", userId });
			} else {
				await this.#securityEvent(ctx, { action: "logout" });
			}
			ctx.response.clearCookie?.(this.#authConfig.cookieName, {
				path: AUTH_COOKIE_PATH,
			});
			ctx.response.redirect(this.#authConfig.loginPath);
		};
	}
}

/** Who sent the request, as far as the host can tell. */
function requestOrigin(ctx: StationHttpContext): {
	ip?: string;
	userAgent?: string;
	requestId?: string;
} {
	return {
		ip: ctx.request.ip?.(),
		userAgent: ctx.request.header?.("user-agent"),
		requestId: ctx.request.id?.() ?? ctx.request.header?.("x-request-id"),
	};
}

/**
 * `Secure` unless this is a development/test process on plain HTTP — an
 * unknown environment gets the production answer, and `NODE_ENV=prod` is
 * production too.
 */
function secureByDefault(ctx: StationHttpContext): boolean {
	const env = normalizeNodeEnv(process.env.NODE_ENV);
	if (env !== "development" && env !== "test") return true;
	return ctx.request.secure?.() === true;
}

function buildLoginLimiter(
	config: StationConfig["loginRateLimit"],
): StationLoginLimiter | undefined {
	if (config === false) return undefined;
	if (config?.limiter !== undefined) return config.limiter;
	return new MemoryLoginLimiter(config?.maxAttempts, config?.windowSeconds);
}

/**
 * A router whose every route gets `names` attached through the route's own
 * `middleware(...names)` (ream's / AdonisJS's route API). A router that hands
 * back no such method cannot honour the config, which is refused loudly.
 */
function withRouteMiddleware(
	router: StationRouter,
	names: ReadonlyArray<string> | undefined,
): StationRouter {
	if (names === undefined || names.length === 0) return router;
	const attach = (route: unknown): unknown => {
		if (
			typeof route !== "object" ||
			route === null ||
			!("middleware" in route) ||
			typeof route.middleware !== "function"
		) {
			throw new Error(
				"[station] `station.middleware` is set but the router's routes have no middleware() method to attach it with.",
			);
		}
		route.middleware(...names);
		return route;
	};
	return {
		get: (path, handler) => attach(router.get(path, handler)),
		post: (path, handler) => attach(router.post(path, handler)),
		put: (path, handler) => attach(router.put(path, handler)),
		delete: (path, handler) => attach(router.delete(path, handler)),
	};
}

/**
 * Cross-package bridge — Station's `Resource.entity` is intentionally
 * typed `new (...args: never[]) => unknown` so the package type-compiles
 * without `@c9up/atlas` installed (peer is optional, memory
 * `project_package_extraction`). At the route-mount boundary we hand
 * the same constructor to Atlas's `BaseRepository`, whose signature is
 * `new () => T extends BaseEntity`. The narrowing casts live in this
 * single helper rather than at every call site (mirrors AC9-style
 * single-load-bearing-site convention from 54.1).
 */
function buildResourceContext(
	resource: Resource,
	db: unknown,
	atlas: AtlasModule,
	rune: RuneModule | null,
): ResourceContext {
	const entityCtor = loadBearingCast<
		ConstructorParameters<typeof AtlasBaseRepository>[0]
	>(resource.entity);
	const conn = loadBearingCast<DatabaseConnection>(db);
	const repo = loadBearingCast<StationRepository>(
		new atlas.BaseRepository(entityCtor, conn),
	);
	const columns = atlas.getColumnMetadata(resource.entity);
	const pkColumn = atlas.getPrimaryKey(resource.entity);
	if (pkColumn === undefined) {
		// Refusing to fall back to "id": a silently-wrong PK would leave the
		// REAL primary key out of the mass-assignment exclusion (client could
		// overwrite it) and mis-key the audit `recordId` + the post-write
		// redirect. Surface the metadata gap loud at boot instead.
		throw new Error(
			`[station] Could not resolve a primary key for ${resource.entity.name}. Declare an @PrimaryKey() column on the entity so atlas can report it.`,
		);
	}
	const dateColumns = atlas.getDateColumnConfig(resource.entity);
	const autoManaged = new Set<string>(
		Object.entries(dateColumns)
			.filter(([, cfg]) => cfg.autoCreate === true || cfg.autoUpdate === true)
			.map(([prop]) => prop),
	);
	// 57.7 — derive the writable validation schema from the SAME column metadata
	// the old `filterWritableBody` read. `rune === null` here means no write
	// action is mounted for this resource (start() already fail-closed the
	// atlas-present-but-rune-absent write case), so the schema stays undefined.
	const excludedProps = new Set<string>(
		atlas.getRelationMetadata(resource.entity).map((r) => r.propertyKey),
	);
	if (atlas.hasSoftDeletes(resource.entity)) excludedProps.add("deletedAt");
	const listColumns = viewColumns(
		columns,
		resource.list.columns,
		resource,
		"list.columns",
	);
	const showColumns = viewColumns(
		columns,
		resource.show.columns,
		resource,
		"show.columns",
	);
	const formColumns = editableColumns(
		columns,
		resource,
		pkColumn,
		autoManaged,
		excludedProps,
	);
	const writeOnly = writeOnlyKeys(formColumns, resource);
	const derived =
		rune === null
			? undefined
			: deriveWritableSchema(
					formColumns,
					pkColumn,
					autoManaged,
					excludedProps,
					rune,
					writeOnly,
				);
	return {
		repo,
		columns,
		listColumns,
		showColumns,
		formColumns,
		writeOnly,
		redacted: resource.auditSecrets
			? new Set<string>()
			: writeOnlyKeys(columns, resource),
		pkColumn,
		pkType: (
			columns.find((c) => c.propertyKey === pkColumn)?.type ?? ""
		).toLowerCase(),
		autoManaged,
		writableSchema: derived?.schema,
		updateSchema: derived?.updateSchema,
		booleanKeys: derived?.booleanKeys ?? new Set<string>(),
	};
}

/**
 * SANCTIONED CROSS-PACKAGE NARROWING — the ONE production site in
 * `@c9up/station` where `as T` is permitted. Memory `feedback_no_any_types`
 * is honoured by funnelling every load-bearing narrow (dynamic peer
 * imports, IoC-resolved `db`, atlas-agnostic `Resource.entity` handed to
 * Atlas's `BaseRepository`) through this single function. Analogous to
 * the test-side `tests/__helpers__/bypass-type-check.ts`. Every
 * call site MUST carry a rationale comment explaining why static
 * narrowing isn't expressible at the boundary. NEVER widen this helper
 * beyond `unknown → T`.
 */
function loadBearingCast<T>(value: unknown): T {
	return value as T;
}

/**
 * Parse a query-string value as a positive integer with a fallback.
 * Strict: only `^[1-9][0-9]*$` is accepted — empty, missing, leading
 * zero, fractional (`1.7`), exponent (`1e3`), trailing garbage (`1abc`),
 * negative, and non-numeric all fall back. Clamp range is [1, +∞).
 */
function clampPositiveInt(raw: string | undefined, fallback: number): number {
	if (typeof raw !== "string" || !POSITIVE_INT_RE.test(raw)) return fallback;
	const n = Number.parseInt(raw, 10);
	return Number.isFinite(n) && n >= 1 ? n : fallback;
}

/**
 * Node's ERR_MODULE_NOT_FOUND surfaces on an Error subclass with `code`.
 * Exported for the 54.8 agnostic-peer-missing unit test, which can't
 * realistically simulate the dynamic-import failure path inside vitest's
 * mock graph.
 */
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

/** Ream's router proxy throws this exact string before Ignitor wires it. */
function isRouterProxyUninit(err: unknown): boolean {
	return (
		err instanceof Error &&
		err.message.includes("Router accessed before initialization")
	);
}

/**
 * 56.5 authorization gate. Returns true when the action is allowed.
 * Station authorizes EXCLUSIVELY through Warden's unified layer: the
 * decision is `auth.hasPermission(user, "<prefix>.<resource>.<action>", scope)`
 * resolved via the container `"auth"` AuthManager (D1/D2). No
 * Station-local RBAC computation, no token-payload read.
 *
 *   - `authManager === undefined` ⇒ OPEN (returns true). This is the
 *     dev-preview / no-warden path — UNCHANGED from the legacy
 *     `if (!authEnabled) return true`. That mode already emits the loud
 *     "no auth — not for production" boot warning; this does NOT widen
 *     any production path.
 *   - A guest (no `ctx.auth.user`) ⇒ DENIED (fail-closed).
 *   - Otherwise the answer is the resolver's — permission present ⇒
 *     allow, absent ⇒ 403.
 *
 * Per-row ownership is NOT expressible here (D7): the coarse permission
 * gate has no `row`. Ownership is a Warden Bouncer-policy concern,
 * reachable through the fuller Bouncer path (a documented follow-up).
 *
 * The result MUST be awaited at every call site — a forgotten `await`
 * yields a truthy Promise = silent ALLOW (AC10 probe 3).
 */
async function authorizeAction(
	resource: Resource,
	action: ResourceAction,
	ctx: StationHttpContext,
	authManager: WardenAuthManager | undefined,
	prefix: string,
	scope: StationScope = "global",
): Promise<boolean> {
	const permission = `${prefix}.${resource.name}.${action}`;
	if (authManager === undefined) return true;
	const user = ctx.auth?.user;
	// `=== undefined` alone is too narrow: a host whose middleware writes
	// `ctx.auth = { user: null }` as a logged-out sentinel must still be
	// denied. Fail closed on any nullish user.
	if (user === undefined || user === null) return false;
	try {
		// Coerce to a strict boolean: the duck-typed manager could resolve a
		// truthy non-boolean, and `!truthy` would silently ALLOW. Anything
		// not exactly `true` denies (fail-closed).
		return (await authManager.hasPermission(user, permission, scope)) === true;
	} catch (err) {
		// A rights-store I/O failure (DB/Redis-backed resolver) must not pass
		// the gate. Deny and surface it loud rather than 500-ing or allowing.
		const detail = err instanceof Error ? err.message : String(err);
		console.error(
			`[station] authorization check threw for '${permission}' — denying (fail-closed): ${detail}`,
		);
		return false;
	}
}

/** Content-negotiation: JSON for `Accept: application/json` or an XHR, else HTML. */
function wantsJsonResponse(ctx: StationHttpContext): boolean {
	const accept = ctx.request.header?.("accept");
	if (typeof accept === "string" && accept.includes("application/json")) {
		return true;
	}
	const xrw = ctx.request.header?.("x-requested-with");
	if (typeof xrw === "string" && xrw.toLowerCase() === "xmlhttprequest") {
		return true;
	}
	return false;
}

function deny(ctx: StationHttpContext): void {
	ctx.response.status(403);
	// Match the auth gate's content negotiation — a JSON / XHR caller used to get
	// an HTML 403 body here, inconsistent with the gate (audit 2026-06-13).
	if (wantsJsonResponse(ctx)) {
		ctx.response.json({
			error: "Forbidden",
			message: "Your account does not have access to this resource action.",
		});
		return;
	}
	ctx.response.type("text/html; charset=utf-8");
	ctx.response.send(
		"<h1>403 Forbidden</h1><p>Your account does not have access to this resource action.</p>",
	);
}

/**
 * Fail-closed CSRF denial (403), mirroring {@link deny}'s content negotiation.
 * Fires when a write reaches an admin handler without a CSRF-verified request
 * (`ctx.request.csrfProtected !== true`). The FIRST block per process also emits
 * one `console.error` — unlike the removed boot-time warning it can never
 * false-alarm (it accompanies a real unprotected write attempt), pointing the
 * operator at the actual misconfiguration (blackhole unwired / `csrf: false` /
 * `/admin/*` excepted).
 */
function denyCsrf(ctx: StationHttpContext): void {
	if (!csrfBlockedWarned) {
		csrfBlockedWarned = true;
		console.error(
			"[station] Blocked a write to /admin/* — CSRF was not enforced for this request. Check that @c9up/blackhole is wired (csrf: true) in start/kernel.ts, /admin/* is NOT in csrf.exceptRoutes, and the blackhole native addon has been rebuilt (a stale .node predates the csrfProtected signal and always reads undefined). Returning 403.",
		);
	}
	ctx.response.status(403);
	if (wantsJsonResponse(ctx)) {
		ctx.response.json({
			error: "Forbidden",
			code: "E_STATION_CSRF_REQUIRED",
			message: "This admin action requires an active, verified CSRF token.",
		});
		return;
	}
	ctx.response.type("text/html; charset=utf-8");
	ctx.response.send(
		"<h1>403 Forbidden</h1><p>This admin action requires an active, verified CSRF token.</p>",
	);
}

/**
 * Memoise the parsed body per request (Adonis BodyParser semantics — the
 * body is parsed once and stays re-readable). `#buildMethodOverrideHandler`
 * reads it to inspect `_method`, then delegates to the update/destroy
 * handler which reads it again; without this, a single-shot
 * `ctx.request.body()` would return `{}` on the second read and the edit
 * would silently no-op.
 */
const parsedBodyCache = new WeakMap<StationHttpContext, unknown>();

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * The request payload as the body parser produced it, whatever its shape. The
 * write handlers validate it as is, so a payload that is not an object fails
 * on the root instead of passing as an empty one.
 *
 * Station never parses a body itself: in ream, `request.body()` is `{}` unless
 * the host's `BodyParserMiddleware` claimed the request (a form post, or JSON
 * under a JSON media type). The documented setup registers that middleware
 * globally in `start/kernel.ts`, ahead of every route, admin ones included.
 */
async function readPayload(ctx: StationHttpContext): Promise<unknown> {
	if (parsedBodyCache.has(ctx)) return parsedBodyCache.get(ctx);
	const raw =
		typeof ctx.request.body === "function" ? await ctx.request.body() : {};
	parsedBodyCache.set(ctx, raw);
	return raw;
}

/** The payload's fields, or none when it is not an object. */
async function readBody(
	ctx: StationHttpContext,
): Promise<Record<string, unknown>> {
	const payload = await readPayload(ctx);
	return isPlainRecord(payload) ? payload : {};
}

const INTEGER_PK_TYPES: ReadonlySet<string> = new Set([
	"integer",
	"int",
	"smallint",
	"bigint",
	"serial",
	"bigserial",
	"increments",
	"bigincrements",
]);
const INTEGER_ID_RE = /^-?[0-9]+$/;
const UUID_ID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** atlas's refusal of a string parameter its column type cannot hold. */
const UNBINDABLE_ID_RE = /^parameter \$1: '.*' is not a valid [a-z ]+$/s;

/**
 * The record a route's `:id` names, or null when there is none — including
 * when the id cannot name a row at all. A declared integer or uuid primary
 * key refuses a malformed id before any query; otherwise Postgres types the
 * parameter from the column and atlas refuses a string that does not fit
 * (`'abc'`, `'1e3'`, an i32 overflow), which is the same "no such record".
 * Every other failure (a lost connection, a broken query) still propagates.
 */
async function findRecord(
	repo: StationRepository,
	pkType: string,
	id: string,
): Promise<StationEntity | null> {
	if (INTEGER_PK_TYPES.has(pkType) && !INTEGER_ID_RE.test(id)) return null;
	if (pkType === "uuid" && !UUID_ID_RE.test(id)) return null;
	try {
		return await repo.find(id);
	} catch (err) {
		if (err instanceof Error && UNBINDABLE_ID_RE.test(err.message)) {
			return null;
		}
		throw err;
	}
}

function redirectToShow(
	ctx: StationHttpContext,
	resource: Resource,
	id: unknown,
): void {
	const slug = encodeURIComponent(resource.name);
	const safeId = encodeURIComponent(String(id ?? ""));
	// defineResource allows action subsets (e.g. [list, create, edit]), so the
	// show route may not be mounted. Redirect to the most specific ENABLED view
	// instead of blindly hitting show and 404-ing: show → edit → list → index.
	if (resource.actions.includes("show")) {
		ctx.response.redirect(`/admin/${slug}/${safeId}`);
		return;
	}
	if (resource.actions.includes("edit")) {
		ctx.response.redirect(`/admin/${slug}/${safeId}/edit`);
		return;
	}
	if (resource.actions.includes("list")) {
		ctx.response.redirect(`/admin/${slug}`);
		return;
	}
	ctx.response.redirect("/admin");
}

/**
 * 54.6 audit emission. The sink runs AFTER the write commits, so a
 * failed mutation never produces a misleading audit row. Sink errors
 * are logged to stderr but never re-thrown — an audit pipeline outage
 * must not block the user-facing request.
 */
async function emitAudit(resource: Resource, event: AuditEvent): Promise<void> {
	if (resource.audit === undefined) return;
	try {
		await resource.audit(event);
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		// COMPLIANCE GAP: the mutation committed but its audit row was
		// lost. Logged at error level (not warn) so monitoring surfaces
		// it, and handed to the optional onAuditError hook so a
		// compliance-serious host can alert / enqueue a retry. The hook
		// is wrapped so a throwing handler can't crash the request.
		console.error(
			`[station] COMPLIANCE GAP: audit sink for resource '${resource.name}' threw on ${event.action} (record ${String(event.recordId)}): ${detail}. The operation succeeded but the audit row was NOT recorded.`,
		);
		if (resource.onAuditError !== undefined) {
			try {
				resource.onAuditError(event, err);
			} catch (hookErr) {
				const hookDetail =
					hookErr instanceof Error ? hookErr.message : String(hookErr);
				console.error(
					`[station] onAuditError handler for resource '${resource.name}' itself threw: ${hookDetail}.`,
				);
			}
		}
	}
}

/**
 * Tiny HTML-escape for the 404 / 405 error bodies — a self-contained
 * local helper. Station keeps no shared TS escaper (inker's `{{ }}`
 * owns view escaping); this covers the error bodies that are sent as
 * `text/html` without going through the inker renderer. Escapes the
 * same five characters as inker so the two escaping paths stay in
 * parity (`&` first to avoid double-encoding).
 */
function escapeMin(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}
