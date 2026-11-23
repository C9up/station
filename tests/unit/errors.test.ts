import { Exception } from "@c9up/flare";
import { describe, expect, it } from "vitest";

import { errors } from "../../src/index.js";

describe("errors", () => {
	it("the entry exports the errors namespace, each a flare Exception", () => {
		const error = new errors.E_STATION_UNKNOWN_RESOURCE(["users"]);
		expect(error).toBeInstanceOf(Exception);
		expect(error).toBeInstanceOf(errors.E_STATION_UNKNOWN_RESOURCE);
		expect(error).toMatchObject({
			code: "E_STATION_UNKNOWN_RESOURCE",
			status: 500,
			message: "[station] ResourceRegistry: no resource named 'users'",
		});
	});

	it("keeps the cause it is given", () => {
		const cause = new Error("boom");
		const error = new errors.E_STATION_INKER_UNUSABLE(undefined, { cause });
		expect(error.cause).toBe(cause);
		expect(error.code).toBe("E_STATION_INKER_UNUSABLE");
	});
});
