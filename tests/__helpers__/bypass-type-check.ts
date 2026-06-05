/**
 * Inject a runtime-bad value into a typed slot for testing a runtime guard.
 *
 * THIS IS THE *ONE* PLACE IN @c9up/station WHERE `as T` IS PERMITTED.
 * Everywhere else, see cerebrum DNR 2026-05-04 ("no `any` AND no `as` casts
 * in new code"). Encapsulating the bypass here keeps ad-hoc workarounds
 * from spreading across test files. Use ONLY when deliberately testing a
 * runtime guard's response to a value the type system says cannot exist.
 *
 * Mirrors `packages/ream/tests/__helpers__/bypass-type-check.ts` (project
 * convention, cerebrum 2026-05-09 D2).
 */
export function bypassTypeCheck<T>(value: unknown): T {
	return value as T;
}
