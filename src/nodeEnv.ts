/**
 * Reading `NODE_ENV`, with the aliases people actually set.
 *
 * `NODE_ENV=prod` is ordinary in a Dockerfile or a platform dashboard. Read
 * verbatim it answers "not production" — and here that decides whether an
 * admin panel mounts with no authorisation at all.
 *
 * Duplicated rather than imported: station's peers are all optional, and a
 * safety decision that only holds when one of them is installed is not a
 * decision.
 */

const DEV_ENVS = ["dev", "develop", "development"];
const PROD_ENVS = ["prod", "production"];
const TEST_ENVS = ["test", "testing"];

/** The canonical name for whatever `NODE_ENV` holds. */
export function normalizeNodeEnv(value: string | undefined): string {
	if (!value || typeof value !== "string") return "unknown";
	const env = value.toLowerCase();
	if (DEV_ENVS.includes(env)) return "development";
	if (PROD_ENVS.includes(env)) return "production";
	if (TEST_ENVS.includes(env)) return "test";
	return env;
}

/** Whether this process is running in production, under any spelling. */
export function inProduction(): boolean {
	return normalizeNodeEnv(process.env.NODE_ENV) === "production";
}
