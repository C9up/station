/**
 * Process-scoped flags so the provider warns once per process, not once per
 * request. Internal: no `exports` entry of the package reaches this module.
 */
export const warnedOnce = {
	authWarnEmitted: false,
	perPageClampWarned: false,
	seedPermsWarned: false,
	missingAuditWarned: false,
	csrfBlockedWarned: false,
	revokeUnavailableWarned: false,
	auditCloneWarnEmitted: false,
};

/** Re-arm every warning, so each test sees the first one again. */
export function resetStationProviderFlags(): void {
	for (const key of Object.keys(warnedOnce)) {
		Reflect.set(warnedOnce, key, false);
	}
}
