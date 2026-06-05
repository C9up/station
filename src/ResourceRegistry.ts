import type { Resource } from "./types.js";

/**
 * Central catalogue of declared resources for a Station-powered admin surface.
 *
 * Plain data structure: no boot()/start() lifecycle here — provider wiring
 * lands in story 54.7. Iteration order is registration order, which is what
 * the admin sidebar wants.
 */
export class ResourceRegistry {
	readonly #map = new Map<string, Resource>();

	register<T>(resource: Resource<T>): void {
		const existing = this.#map.get(resource.name);
		if (existing !== undefined) {
			throw new Error(
				`[station] ResourceRegistry: duplicate resource name '${resource.name}' (already registered for ${existing.entity.name})`,
			);
		}
		this.#map.set(resource.name, resource);
	}

	get(name: string): Resource | undefined {
		return this.#map.get(name);
	}

	getOrThrow(name: string): Resource {
		const found = this.#map.get(name);
		if (found === undefined) {
			throw new Error(
				`[station] ResourceRegistry: no resource named '${name}'`,
			);
		}
		return found;
	}

	has(name: string): boolean {
		return this.#map.has(name);
	}

	count(): number {
		return this.#map.size;
	}

	all(): ReadonlyArray<Resource> {
		const snapshot: Resource[] = [...this.#map.values()];
		return Object.freeze(snapshot);
	}
}
