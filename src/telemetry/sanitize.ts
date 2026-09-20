/** Strip credential-bearing substrings from failure summaries before queue, log, or UI exposure. */

/**
 * Redact Bearer credentials and keyed token/password/secret values so a raw
 * provider error message can never carry a credential into the queue, a
 * collector status view, the fixture, or the admin browser.
 * @param value - Raw error or failure text of unbounded shape.
 * @returns Text with every recognized credential substring replaced by `[REDACTED]`.
 */
export function sanitizeSensitiveSummary(value: string): string {
  return value
    .replace(/Bearer\s+[a-z0-9._~+=/-]+/gi, 'Bearer [REDACTED]')
    .replace(/(access[-_]?token|refresh[-_]?token|api[-_]?key|password|secret|cookie)\s*[:=]\s*\S+/gi, '$1=[REDACTED]')
    .replace(/(access[-_]?token|refresh[-_]?token|api[-_]?key|password|secret|cookie)(\s*[:=]\s*|\s+)'[^']*'/gi, '$1=[REDACTED]')
    .replace(/(access[-_]?token|refresh[-_]?token|api[-_]?key|password|secret|cookie)(\s*[:=]\s*|\s+)"[^"]*"/gi, '$1=[REDACTED]')
    .replace(/([a-z]:)?(?:\\|\/)(?:users|home)(?:\\|\/)[^\s'"]+/gi, '[PATH]')
}
