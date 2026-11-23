/**
 * Brute-force throttle for `POST /admin/login`.
 *
 * The contract is the one `@c9up/warden`'s `AuthRateLimiter` exposes, so an
 * application passes its own instance (a Redis-backed one in a cluster) as
 * `station.loginRateLimit.limiter`. Station cannot construct warden's class —
 * it never imports `@c9up/warden` — so the default is this in-process copy of
 * the same semantics: one atomic count per key BEFORE the credential check,
 * keys `ip:<ip>` and `id:<digest of the identifier>` counted in that order and
 * no further than the first refused one, a bounded store that refuses new
 * keys rather than forgiving live windows when it is full.
 */

import { createHash } from "node:crypto";
import { E_STATION_INVALID_CONFIG } from "./errors.js";

export interface StationLoginDecision {
	allowed: boolean;
	retryAfterSeconds: number;
}

/** Structural slice of warden's `AuthRateLimiter`. */
export interface StationLoginLimiter {
	attempt(...keys: string[]): Promise<StationLoginDecision>;
	clear(...keys: string[]): Promise<void>;
}

export interface StationLoginRateLimitConfig {
	/** Attempts allowed per window, per key. Default 5. */
	maxAttempts?: number;
	/** Window length in seconds. Default 900 (15 min). */
	windowSeconds?: number;
	/**
	 * The limiter to use instead of the in-process default — e.g. warden's
	 * `AuthRateLimiter` over a `RedisAttemptStore`, so a lockout holds on every
	 * instance. `maxAttempts`/`windowSeconds` then belong to that limiter.
	 */
	limiter?: StationLoginLimiter;
}

/**
 * Same keys as warden's `AuthRateLimiter.loginKeys`, so a shared limiter
 * shares budgets: the IP first, then the SHA-256 of the normalized identifier
 * (trimmed, lowercased). The identifier is whatever the client posted; kept
 * verbatim, a 1 MB body pinned 1 MB in the store for the whole window.
 */
export function loginKeys(ip: string, identifier: string): string[] {
	const digest = createHash("sha256")
		.update(identifier.trim().toLowerCase())
		.digest("base64url");
	return [`ip:${ip.trim()}`, `id:${digest}`];
}

const MAX_KEYS = 100_000;

export class MemoryLoginLimiter implements StationLoginLimiter {
	readonly #maxAttempts: number;
	readonly #windowMs: number;
	readonly #entries = new Map<string, { count: number; resetAt: number }>();

	constructor(maxAttempts = 5, windowSeconds = 900) {
		this.#maxAttempts = positiveInteger("maxAttempts", maxAttempts);
		this.#windowMs = positiveInteger("windowSeconds", windowSeconds) * 1000;
	}

	/**
	 * Count the attempt under its keys, in order. The first key over the limit
	 * refuses it and the keys after it are not counted: counting them all let
	 * an IP already throttled create one `id:` window per request, until the
	 * full store refused every other client's new keys.
	 */
	async attempt(...keys: string[]): Promise<StationLoginDecision> {
		const now = Date.now();
		let highest = 0;
		let retryMs = 0;
		for (const key of keys) {
			const counted = this.#increment(key, now);
			if (counted.count > highest) {
				highest = counted.count;
				retryMs = counted.resetAt - now;
			}
			if (counted.count > this.#maxAttempts) break;
		}
		return {
			allowed: highest <= this.#maxAttempts,
			retryAfterSeconds: Math.max(1, Math.ceil(retryMs / 1000)),
		};
	}

	async clear(...keys: string[]): Promise<void> {
		for (const key of keys) this.#entries.delete(key);
	}

	#increment(key: string, now: number): { count: number; resetAt: number } {
		let entry = this.#entries.get(key);
		if (entry === undefined || entry.resetAt <= now) {
			this.#entries.delete(key);
			const earliest = this.#makeRoom(now);
			// Full of live windows: the keys are attacker-chosen, so evicting
			// one would forgive a victim's lockout. Refuse the new key instead.
			if (earliest !== undefined) {
				return { count: Number.POSITIVE_INFINITY, resetAt: earliest };
			}
			entry = { count: 0, resetAt: now + this.#windowMs };
			this.#entries.set(key, entry);
		}
		entry.count++;
		return entry;
	}

	#makeRoom(now: number): number | undefined {
		if (this.#entries.size < MAX_KEYS) return undefined;
		let earliest = Number.POSITIVE_INFINITY;
		for (const [key, entry] of this.#entries) {
			if (entry.resetAt <= now) this.#entries.delete(key);
			else earliest = Math.min(earliest, entry.resetAt);
		}
		return this.#entries.size < MAX_KEYS ? undefined : earliest;
	}
}

function positiveInteger(field: string, value: number): number {
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new E_STATION_INVALID_CONFIG([
			`station.loginRateLimit.${field} must be a positive whole number, got ${String(value)}`,
		]);
	}
	return value;
}
