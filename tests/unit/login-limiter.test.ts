/**
 * The default login limiter (bugs 027/028): a client whose IP is already
 * throttled cannot add keys to the store, and an identifier costs a fixed
 * number of bytes in it whatever its length.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { loginKeys, MemoryLoginLimiter } from "../../src/loginLimiter.js";

describe("station > MemoryLoginLimiter", () => {
	it("a throttled IP cycling identifiers cannot fill the store and lock everyone out (bug 027)", async () => {
		const limiter = new MemoryLoginLimiter();
		let admitted = 0;
		for (let i = 0; i < 100_000; i++) {
			const decision = await limiter.attempt(
				...loginKeys("203.0.113.9", `x${i}@e.com`),
			);
			if (decision.allowed) admitted++;
		}
		expect(admitted).toBe(5);
		const admin = await limiter.attempt(
			...loginKeys("198.51.100.7", "admin@corp.com"),
		);
		expect(admin.allowed).toBe(true);
	});

	it("does not count the keys after the refused one", async () => {
		const limiter = new MemoryLoginLimiter(1, 900);
		await limiter.attempt(...loginKeys("1.1.1.1", "a@b.com"));
		const refused = await limiter.attempt(...loginKeys("1.1.1.1", "b@b.com"));
		expect(refused.allowed).toBe(false);
		expect(refused.retryAfterSeconds).toBeGreaterThan(0);
		// b@b.com was never counted: from a fresh IP it still has its attempt.
		expect(
			(await limiter.attempt(...loginKeys("2.2.2.2", "b@b.com"))).allowed,
		).toBe(true);
	});

	it("keys an identifier by a fixed-size digest of its normalized form (bug 028)", () => {
		const huge = `${"a".repeat(1_000_000)}@x.io`;
		const [ip, id] = loginKeys(" 203.0.113.9 ", huge);
		expect(ip).toBe("ip:203.0.113.9");
		// Asserted as booleans: a failure must not print a 1 MB key.
		expect(/^id:[A-Za-z0-9_-]{43}$/.test(id ?? "")).toBe(true);
		expect(loginKeys("1.1.1.1", `  ${huge.toUpperCase()} `)[1] === id).toBe(
			true,
		);
		// The same digest as warden's AuthRateLimiter.loginKeys, so a shared
		// limiter shares budgets.
		const expected = createHash("sha256")
			.update("admin@example.com")
			.digest("base64url");
		expect(loginKeys("1.1.1.1", " Admin@Example.com ")[1]).toBe(
			`id:${expected}`,
		);
	});
});
