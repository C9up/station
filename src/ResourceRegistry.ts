import type { Resource } from "./types.js";

/**
 * Central catalogue of declared resources for a Station-powered admin surface.
 *
 * Plain data structure: no boot()/start() lifecycle here — provider wiring
 * lands in story 54.7. Iteration order is registration order, which is what
 * the admin sidebar wants.
 */
/**
 * How a registered resource reaches the router.
 *
 * Installed by `StationProvider` once the admin surface is prepared, so a
 * resource declared in a preload becomes mounted routes at the moment it is
 * declared. The provider used to read a SNAPSHOT of this registry in `start()`
 * and give up when it was empty — and providers start before preloads run, so
 * `station.register(...)` written where the docs say to write it arrived after
 * the only pass that would have mounted it.
 */
export type ResourceMounter = (resource: Resource) => void;

export class ResourceRegistry {
	readonly #map = new Map<string, Resource>();
	#mounter?: ResourceMounter;

	register<T>(resource: Resource<T>): void {
		const existing = this.#map.get(resource.name);
		if (existing !== undefined) {
			throw new Error(
				`[station] ResourceRegistry: duplicate resource name '${resource.name}' (already registered for ${existing.entity.name})`,
			);
		}
		this.#map.set(resource.name, resource);
		this.#mounter?.(resource);
	}

	/**
	 * @internal Give the registry a way to mount what it is told about.
	 *
	 * Mounts everything already registered before it arrived: an application is
	 * free to declare a resource at module scope, which runs while the provider
	 * is still starting.
	 */
	useMounter(mounter: ResourceMounter): void {
		this.#mounter = mounter;
		for (const resource of this.#map.values()) mounter(resource);
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
