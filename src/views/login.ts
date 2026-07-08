/**
 * `GET /admin/login` — sign-in form rendered by StationProvider when
 * the host has `@c9up/warden` wired (Story 54.7). The form POSTs
 * `email` + `password` to `/admin/login`; the provider's
 * `buildLoginHandler` runs them through `auth.authenticate(...)` and
 * sets a session cookie on success.
 *
 * Pure `(input) => LoginViewModel` builder (Story 57.3): every value reaches
 * HTML through `templates/login.inker`'s `{{ }}` auto-escape (the retired
 * `escape.ts` no longer runs here), so a tampered `?error=…` query parameter
 * cannot smuggle markup into the page. The CSRF hidden input is emitted by
 * inker's canonical `{{ csrfField() }}` helper, guarded by the precomputed
 * `csrfEnabled` boolean.
 */

export interface LoginPageInput {
	/** Pre-fill the email field (e.g. after a failed attempt). */
	email?: string;
	/** Optional error message to display above the form. */
	error?: string;
	/** Form action path. Default `/admin/login`. */
	action?: string;
	/**
	 * Whether the host has a CSRF token in the per-request store. When true the
	 * template emits `{{ csrfField() }}`; the handler derives it from
	 * `ctx.store` (57.3). Replaces the old `hiddenInputs?` array.
	 */
	csrfEnabled?: boolean;
}

// A `type` alias (not `interface`) so the view-model carries an implicit index
// signature and stays assignable to the renderer's
// `Readonly<Record<string, unknown>>` data param without a cast.
export type LoginViewModel = {
	title: string;
	email: string;
	action: string;
	error: string;
	csrfEnabled: boolean;
};

export function buildLoginViewModel(input: LoginPageInput): LoginViewModel {
	return {
		title: "Sign in",
		email: input.email ?? "",
		// No URL-encoding: the login action is a fixed host-configured path.
		action: input.action ?? "/admin/login",
		// Empty string is falsy in inker, so `{% if error %}` gates the block.
		error: input.error ?? "",
		csrfEnabled: input.csrfEnabled === true,
	};
}
