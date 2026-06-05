import { describe, expect, it } from "vitest";

import { kebabCase, pluralise, titleCase } from "../../src/casing.js";

describe("kebabCase", () => {
	it("converts PascalCase to kebab-case", () => {
		expect(kebabCase("BlogPost")).toBe("blog-post");
	});

	it("treats consecutive uppercase letters as one segment", () => {
		expect(kebabCase("URLParser")).toBe("url-parser");
	});

	it("splits on digit boundaries", () => {
		expect(kebabCase("My2024Post")).toBe("my-2024-post");
	});

	it("is idempotent on already-lower input", () => {
		expect(kebabCase("user")).toBe("user");
	});

	it("handles single-word PascalCase", () => {
		expect(kebabCase("User")).toBe("user");
	});

	it("handles trailing uppercase acronym", () => {
		expect(kebabCase("ParseURL")).toBe("parse-url");
	});
});

describe("pluralise", () => {
	it("appends 's' by default", () => {
		expect(pluralise("user")).toBe("users");
		expect(pluralise("post")).toBe("posts");
	});

	it("turns consonant+y into ies", () => {
		expect(pluralise("category")).toBe("categories");
	});

	it("appends 'es' for s/x/z/ch/sh endings", () => {
		expect(pluralise("box")).toBe("boxes");
		expect(pluralise("bus")).toBe("buses");
		expect(pluralise("buzz")).toBe("buzzes");
		expect(pluralise("watch")).toBe("watches");
		expect(pluralise("brush")).toBe("brushes");
	});

	it("catches Greek -is words via the irregular table (analysis, crisis)", () => {
		expect(pluralise("analysis")).toBe("analyses");
		expect(pluralise("crisis")).toBe("crises");
	});

	it("does NOT mangle non-Greek words ending in -is (tennis stays tennises, not tennes)", () => {
		expect(pluralise("tennis")).toBe("tennises");
		expect(pluralise("chassis")).toBe("chassises");
		expect(pluralise("iris")).toBe("irises");
	});

	it("uses the irregular table", () => {
		expect(pluralise("person")).toBe("people");
		expect(pluralise("child")).toBe("children");
		expect(pluralise("man")).toBe("men");
		expect(pluralise("woman")).toBe("women");
		expect(pluralise("mouse")).toBe("mice");
		expect(pluralise("goose")).toBe("geese");
		expect(pluralise("tooth")).toBe("teeth");
		expect(pluralise("foot")).toBe("feet");
		expect(pluralise("datum")).toBe("data");
	});

	it("pluralises only the last segment of multi-word kebab input", () => {
		expect(pluralise("blog-post")).toBe("blog-posts");
		expect(pluralise("super-man")).toBe("super-men");
	});

	it("leaves the prefix untouched (human stays humans, not humens)", () => {
		expect(pluralise("human")).toBe("humans");
	});
});

describe("titleCase", () => {
	it("converts single-word kebab", () => {
		expect(titleCase("users")).toBe("Users");
	});

	it("converts multi-word kebab to space-separated Title Case", () => {
		expect(titleCase("blog-posts")).toBe("Blog Posts");
	});

	it("handles already-capitalised tokens by uppercasing the first letter only", () => {
		expect(titleCase("hello-world")).toBe("Hello World");
	});
});
