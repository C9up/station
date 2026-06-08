/**
 * Convert an identifier (camelCase / PascalCase / digits / already-lowercase)
 * to kebab-case.
 *
 *   BlogPost   -> blog-post
 *   URLParser  -> url-parser   (consecutive uppercase = one segment)
 *   My2024Post -> my-2024-post (digit boundaries split too)
 *   user       -> user         (idempotent on already-lower input)
 */
export function kebabCase(input: string): string {
	const upperAfterLowerOrDigit = input.replace(/([a-z0-9])([A-Z])/g, "$1-$2");
	const upperAfterUpperBeforeLower = upperAfterLowerOrDigit.replace(
		/([A-Z])([A-Z][a-z])/g,
		"$1-$2",
	);
	const digitAfterLetter = upperAfterUpperBeforeLower.replace(
		/([A-Za-z])([0-9])/g,
		"$1-$2",
	);
	return digitAfterLetter.toLowerCase();
}

/**
 * Convert kebab-case to space-separated Title Case.
 *
 *   blog-posts -> Blog Posts
 */
export function titleCase(input: string): string {
	return input
		.split("-")
		.map((part) =>
			part.length === 0 ? part : part[0].toUpperCase() + part.slice(1),
		)
		.join(" ");
}

/**
 * Irregular plural table. Lookup is on the LAST kebab segment so
 * `super-man` -> `super-men` works while `human` falls through.
 */
const IRREGULAR_PLURALS: ReadonlyMap<string, string> = new Map([
	["person", "people"],
	["child", "children"],
	["man", "men"],
	["woman", "women"],
	["mouse", "mice"],
	["goose", "geese"],
	["tooth", "teeth"],
	["foot", "feet"],
	["analysis", "analyses"],
	["crisis", "crises"],
	["phenomenon", "phenomena"],
	["criterion", "criteria"],
	["datum", "data"],
	["medium", "media"],
]);

function pluraliseWord(word: string): string {
	const irregular = IRREGULAR_PLURALS.get(word);
	if (irregular !== undefined) {
		return irregular;
	}
	if (/[^aeiou]y$/.test(word)) {
		return `${word.slice(0, -1)}ies`;
	}
	if (/(s|x|z|ch|sh)$/.test(word)) {
		return `${word}es`;
	}
	return `${word}s`;
}

/**
 * Minimal English pluraliser. Hand-rolled (zero runtime deps).
 *
 * Multi-word kebab inputs only have their LAST segment pluralised:
 *
 *   user      -> users
 *   blog-post -> blog-posts
 *   super-man -> super-men
 */
export function pluralise(singular: string): string {
	const segments = singular.split("-");
	const last = segments[segments.length - 1];
	segments[segments.length - 1] = pluraliseWord(last);
	return segments.join("-");
}
