/**
 * Default `ResourceRegistry` singleton — Adonis-style:
 *
 *   import station from '@c9up/station/services/main'
 *
 *   station.register(defineResource({ entity: User }))
 *
 * Populated either by `StationProvider.boot()` (lands in story 54.7) or by
 * the app itself via `_setStation(myRegistry)`.
 */

import type { ResourceRegistry } from "../ResourceRegistry.js";

let _instance: ResourceRegistry | undefined;

/** @internal Bind the singleton (called by StationProvider or by the app). */
export function _setStation(instance: ResourceRegistry): void {
	_instance = instance;
}

/** @internal Read the singleton (or `undefined` pre-boot). */
export function _getStation(): ResourceRegistry | undefined {
	return _instance;
}

const station: ResourceRegistry = new Proxy({} as ResourceRegistry, {
	get(_target, prop) {
		if (!_instance) {
			throw new Error(
				"[station] ResourceRegistry singleton accessed before StationProvider.boot() ran " +
					"or `_setStation(myRegistry)` was called. Wire one of them first.",
			);
		}
		const value = Reflect.get(_instance, prop, _instance);
		return typeof value === "function" ? value.bind(_instance) : value;
	},
});

export default station;
