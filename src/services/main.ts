/**
 * Default `ResourceRegistry` singleton — Adonis-style:
 *
 *   import station from '@c9up/station/services/main'
 *
 *   station.register(defineResource({ entity: User }))
 *
 * Populated either by `StationProvider.boot()` (lands in story 54.7) or by
 * the app itself via `setStation(myRegistry)`.
 */

import type { ResourceRegistry } from "../ResourceRegistry.js";

let instance: ResourceRegistry | undefined;

/** @internal Bind the singleton (called by StationProvider or by the app). */
export function setStation(value: ResourceRegistry): void {
	instance = value;
}

/** @internal Read the singleton (or `undefined` pre-boot). */
export function getStation(): ResourceRegistry | undefined {
	return instance;
}

const station: ResourceRegistry = new Proxy({} as ResourceRegistry, {
	get(_target, prop) {
		if (!instance) {
			throw new Error(
				"[station] ResourceRegistry singleton accessed before StationProvider.boot() ran " +
					"or `setStation(myRegistry)` was called. Wire one of them first.",
			);
		}
		const value = Reflect.get(instance, prop, instance);
		return typeof value === "function" ? value.bind(instance) : value;
	},
});

export default station;
