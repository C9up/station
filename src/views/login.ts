/**
 * `GET /admin/login` — sign-in form rendered by StationProvider when
 * the host has `@c9up/warden` wired (Story 54.7). The form POSTs
 * `email` + `password` to `/admin/login`; the provider's
 * `buildLoginHandler` runs them through `auth.authenticate(...)` and
 * sets a session cookie on success.
 *
 * Every dynamic value flows through `escapeHtml()` so a tampered
 * `?error=…` query parameter cannot smuggle markup into the page.
 */

import { escapeHtml, safeHtml } from "./escape.js";
import { renderLayout } from "./layout.js";

export interface LoginPageInput {
	/** Pre-fill the email field (e.g. after a failed attempt). */
	email?: string;
	/** Optional error message to display above the form. */
	error?: string;
	/** Form action path. Default `/admin/login`. */
	action?: string;
	/** Caller-controlled hidden inputs (typically `_csrf`). */
	hiddenInputs?: ReadonlyArray<{ name: string; value: string }>;
}

export function renderLoginPage(input: LoginPageInput): string {
	const email = input.email ?? "";
	const error = input.error;
	const action = input.action ?? "/admin/login";

	const hiddens = (input.hiddenInputs ?? [])
		.map(
			(h) =>
				`<input type="hidden" name="${escapeHtml(h.name)}" value="${escapeHtml(h.value)}">`,
		)
		.join("");

	const errorBlock =
		error !== undefined
			? `<p class="st-form-error" role="alert">${escapeHtml(error)}</p>`
			: "";

	const body =
		`<h1>Sign in</h1>` +
		errorBlock +
		`<form class="st-form" method="POST" action="${escapeHtml(action)}">` +
		hiddens +
		`<div class="st-field">` +
		`<label for="f-email">Email</label>` +
		`<input id="f-email" type="email" name="email" value="${escapeHtml(email)}" required autocomplete="email" autofocus>` +
		`</div>` +
		`<div class="st-field">` +
		`<label for="f-password">Password</label>` +
		`<input id="f-password" type="password" name="password" required autocomplete="current-password">` +
		`</div>` +
		`<div class="st-form-actions">` +
		`<button type="submit">Sign in</button>` +
		`</div>` +
		`</form>`;

	return renderLayout({
		title: "Sign in",
		bodyHtml: safeHtml(body),
	});
}
