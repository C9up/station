export type ResourceAction = "list" | "show" | "create" | "edit" | "destroy";

export const RESOURCE_ACTIONS: ReadonlyArray<ResourceAction> = Object.freeze([
	"list",
	"show",
	"create",
	"edit",
	"destroy",
]);

/**
 * Audit-trail event (Story 54.6). Emitted AFTER a write action lands
 * successfully — on a 4xx/5xx the event does not fire (the action's
 * effect is the boundary). `before` is present for `edit` and
 * `destroy`; `after` is present for `create` and `edit`.
 */
export interface AuditEvent {
	readonly action: ResourceAction;
	readonly resource: string;
	readonly recordId?: unknown;
	readonly userId?: unknown;
	readonly before?: Readonly<Record<string, unknown>>;
	readonly after?: Readonly<Record<string, unknown>>;
	readonly at: Date;
}

export type AuditSink = (event: AuditEvent) => void | Promise<void>;

/**
 * Per-field override for the auto-generated form (Story 54.5). Station
 * infers the form from the entity's `@Column` metadata; consumers can
 * override one column at a time without losing the inference for the
 * others.
 */
export interface FormFieldOverride {
	/** Hide the field from the form entirely (still rendered on show). */
	hidden?: boolean;
	/** Override the rendered `<input type>`. */
	inputType?:
		| "text"
		| "number"
		| "email"
		| "password"
		| "date"
		| "datetime-local"
		| "checkbox"
		| "textarea";
	/** Override the visible label (defaults to the column name title-cased). */
	label?: string;
	/** Add an `<input placeholder>`. */
	placeholder?: string;
	/** Mark the field as required at the HTML level. */
	required?: boolean;
}

export interface ResourceOptions<TEntity> {
	/** Entity class (Atlas `@Entity()`-decorated constructor). */
	entity: new (
		...args: never[]
	) => TEntity;
	/** Human-readable label shown in the admin sidebar (e.g. "Users"). */
	label?: string;
	/** Subset of actions to mount. Default: all five. */
	actions?: ReadonlyArray<ResourceAction>;
	/** URL slug override. Default: derived from the entity class name. */
	name?: string;
	/**
	 * Audit sink invoked AFTER each successful write (Story 54.6). When
	 * omitted, Station falls back to a once-per-process stderr warning
	 * so apps don't silently lose audit visibility.
	 */
	audit?: AuditSink;
	/**
	 * Invoked when the audit sink throws (Story 54.6 hardening, retro
	 * 2026-06-01). The mutation has already committed, so this is a
	 * compliance-observability hook — emit an alert / enqueue a retry /
	 * record the gap. Station does NOT block the user request on an audit
	 * failure; without this handler the failure is logged at `error`
	 * level. The handler is itself wrapped so a throwing handler can't
	 * crash the request.
	 */
	onAuditError?: (event: AuditEvent, error: unknown) => void;
	/**
	 * Per-field overrides on top of the inferred form (Story 54.5).
	 * Keyed by the entity's camelCase property name; absent keys keep
	 * the inferred defaults.
	 */
	formFields?: Readonly<Record<string, FormFieldOverride>>;
}

export interface Resource<TEntity = unknown> {
	/** The entity class passed in. */
	readonly entity: new (
		...args: never[]
	) => TEntity;
	/** URL slug — e.g. "users", "blog-posts". Always lowercase, kebab-case. */
	readonly name: string;
	/** Display label — e.g. "Users". Defaults to a title-cased pluralised entity name. */
	readonly label: string;
	/** Frozen list of enabled actions, in canonical order (list, show, create, edit, destroy). */
	readonly actions: ReadonlyArray<ResourceAction>;
	/** Optional audit sink (Story 54.6). */
	readonly audit?: AuditSink;
	/** Optional audit-failure observability hook (Story 54.6 hardening). */
	readonly onAuditError?: (event: AuditEvent, error: unknown) => void;
	/** Frozen per-field overrides for the inferred form (Story 54.5). */
	readonly formFields: Readonly<Record<string, FormFieldOverride>>;
}
