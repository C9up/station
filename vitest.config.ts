import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		include: ["tests/**/*.test.ts"],
		coverage: {
			provider: "v8",
			include: ["src/**"],
			exclude: ["src/**/*.d.ts"],
			reporter: ["text-summary", "json-summary"],
			// A floor, not a target: set just under what the suite covers today, so
			// a change that stops testing a path fails here instead of landing.
			thresholds: {
				lines: 85,
				statements: 83,
				branches: 76,
				functions: 92,
			},
		},
	},
});
