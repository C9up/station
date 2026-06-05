import { describe, expect, it } from "vitest";
import { defineResource } from "../../src/defineResource.js";
import { renderNotFoundPage } from "../../src/views/errors/404.js";

const userResource = defineResource({ entity: class User {} });

describe("station > views > renderNotFoundPage", () => {
	it("includes the 'Not Found' marker in the document title and body", () => {
		const html = renderNotFoundPage({ resource: userResource, id: "42" });
		expect(html).toContain("<title>Not Found · Station</title>");
		expect(html).toContain("<h1>404 Not Found</h1>");
		expect(html).toContain("No users with ID <code>42</code>");
	});

	it("XSS regression: escapes the id in the body (path-injection probe)", () => {
		const html = renderNotFoundPage({
			resource: userResource,
			id: "<script>alert(1)</script>",
		});
		expect(html).toContain(
			"<code>&lt;script&gt;alert(1)&lt;/script&gt;</code>",
		);
		expect(html).not.toContain("<code><script>alert(1)</script></code>");
	});
});
