import "./augmentations.js";

export { kebabCase, pluralise, titleCase } from "./casing.js";
export { defineResource } from "./defineResource.js";
export { ResourceRegistry } from "./ResourceRegistry.js";
export type { StationAppContext, StationConfig } from "./StationProvider.js";
export { default as StationProvider } from "./StationProvider.js";

import type { StationConfig } from "./StationProvider.js";

/**
 * Author-time config helper for `config/station.ts` — AdonisJS `defineConfig`
 * parity. Identity at runtime; the generic preserves literal types for inference.
 */
export function defineConfig<T extends StationConfig>(config: T): T {
	return config;
}
export {
	type AuditEvent,
	type AuditSink,
	type FormFieldOverride,
	RESOURCE_ACTIONS,
	type Resource,
	type ResourceAction,
	type ResourceOptions,
} from "./types.js";
