/**
 * Station errors, one class per code. Every refusal Station raises is a flare
 * `Exception` with a code in the `E_STATION_` namespace, so a caller can match
 * on `error.code` or `error instanceof errors.E_STATION_…` rather than on the
 * message.
 */
import { createError } from "@c9up/flare";

/** The `services/main` registry was used before StationProvider booted or `setStation()` ran. */
export const E_STATION_NOT_BOOTED = createError(
	"[station] ResourceRegistry singleton accessed before StationProvider.boot() ran " +
		"or `setStation(myRegistry)` was called. Wire one of them first.",
	"E_STATION_NOT_BOOTED",
);

/** `defineResource()` was given an invalid declaration. The value is what is wrong. */
export const E_STATION_INVALID_RESOURCE = createError<[string]>(
	"[station] defineResource: %s",
	"E_STATION_INVALID_RESOURCE",
);

/** Two resources were registered under the same name. */
export const E_STATION_DUPLICATE_RESOURCE = createError<[string, string]>(
	"[station] ResourceRegistry: duplicate resource name '%s' (already registered for %s)",
	"E_STATION_DUPLICATE_RESOURCE",
);

/** `getOrThrow()` named a resource that is not registered. */
export const E_STATION_UNKNOWN_RESOURCE = createError<[string]>(
	"[station] ResourceRegistry: no resource named '%s'",
	"E_STATION_UNKNOWN_RESOURCE",
);

/** A resource's column list names a property that is not a column of the entity. */
export const E_STATION_UNKNOWN_COLUMN = createError<
	[string, string, string, string]
>(
	"[station] defineResource '%s': %s names '%s', which is not a column of %s.",
	"E_STATION_UNKNOWN_COLUMN",
);

/** `editable` names a column the framework manages or one `formFields` hides. */
export const E_STATION_COLUMN_NOT_EDITABLE = createError<
	[string, string, string]
>(
	"[station] defineResource '%s': editable names '%s', which %s.",
	"E_STATION_COLUMN_NOT_EDITABLE",
);

/** An admin entity declares no `@PrimaryKey()` column. */
export const E_STATION_PRIMARY_KEY_MISSING = createError<[string]>(
	"[station] Could not resolve a primary key for %s. Declare an @PrimaryKey() column on the entity so atlas can report it.",
	"E_STATION_PRIMARY_KEY_MISSING",
);

/** A `station` option is invalid. The value says which and why. */
export const E_STATION_INVALID_CONFIG = createError<[string]>(
	"[station] %s",
	"E_STATION_INVALID_CONFIG",
);

/** `station.guard` names a guard warden does not know. */
export const E_STATION_UNKNOWN_GUARD = createError<[string]>(
	"[station] `station.guard`: %s is not a registered warden guard.",
	"E_STATION_UNKNOWN_GUARD",
);

/** The admin guard does not issue a bearer token; Station needs a JWT guard. */
export const E_STATION_GUARD_NOT_JWT = createError<[string, string]>(
	"[station] The admin signs in through %s%s, which does not issue a bearer token. " +
		"Station keeps the token warden's JWT strategy issues in its cookie: name a JWT guard with `station.guard`.",
	"E_STATION_GUARD_NOT_JWT",
);

/** No working `auth` binding is registered where the admin requires one. */
export const E_STATION_AUTH_REQUIRED = createError<[string]>(
	"[station] %s",
	"E_STATION_AUTH_REQUIRED",
);

/** No database is registered for the admin. */
export const E_STATION_DATABASE_REQUIRED = createError<[string]>(
	"[station] %s Did you register @c9up/atlas/provider in reamrc.ts?",
	"E_STATION_DATABASE_REQUIRED",
);

/** A resource with write forms needs `@c9up/rune`, which is not installed. */
export const E_STATION_RUNE_REQUIRED = createError<[string]>(
	"[station] %s",
	"E_STATION_RUNE_REQUIRED",
);

/** No `@c9up/inker` view engine is registered to render the admin. */
export const E_STATION_INKER_REQUIRED = createError(
	"[station] register @c9up/inker (InkerProvider) to render admin views",
	"E_STATION_INKER_REQUIRED",
);

/** `@c9up/inker` is registered but does not resolve to a usable view renderer; see `cause`. */
export const E_STATION_INKER_UNUSABLE = createError(
	"[station] @c9up/inker is registered but not usable — it must fully boot (InkerProvider + its rosetta/router peers) before Station, and resolve to a real view renderer. See `cause` for the specific reason.",
	"E_STATION_INKER_UNUSABLE",
);

/** `station.middleware` is set but the router's routes have no `middleware()` method. */
export const E_STATION_ROUTE_MIDDLEWARE_UNSUPPORTED = createError(
	"[station] `station.middleware` is set but the router's routes have no middleware() method to attach it with.",
	"E_STATION_ROUTE_MIDDLEWARE_UNSUPPORTED",
);

/** An internal invariant broke (the view engine was not initialised); report it as a bug. */
export const E_STATION_INTERNAL = createError(
	"[station] view engine not initialised",
	"E_STATION_INTERNAL",
);
