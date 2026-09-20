import { describe, expect, it } from 'vitest'
import { sanitizeSensitiveSummary } from '../src/telemetry/sanitize.ts'

describe('sanitizeSensitiveSummary', () => {
  it('redacts Bearer credentials in any casing or separator', () => {
    expect(sanitizeSensitiveSummary('request failed: Bearer abc123.def456_ghi')).toBe('request failed: Bearer [REDACTED]')
    expect(sanitizeSensitiveSummary('auth=bearer eyJhbGciOi.token')).toBe('auth=Bearer [REDACTED]')
  })

  it('redacts keyed token, password, secret, api key, and cookie values', () => {
    expect(sanitizeSensitiveSummary('access_token=sup3r-secret')).toBe('access_token=[REDACTED]')
    expect(sanitizeSensitiveSummary('refresh-token: r-12345')).toBe('refresh-token=[REDACTED]')
    expect(sanitizeSensitiveSummary('api_key AK-...')).toBe('api_key AK-...')
    expect(sanitizeSensitiveSummary('apikey=AKIA123')).toBe('apikey=[REDACTED]')
    expect(sanitizeSensitiveSummary('password=hunter2')).toBe('password=[REDACTED]')
    expect(sanitizeSensitiveSummary('Password: hunter2')).toBe('Password=[REDACTED]')
    expect(sanitizeSensitiveSummary('secret -> abc')).toBe('secret -> abc')
    expect(sanitizeSensitiveSummary('secret: abc')).toBe('secret=[REDACTED]')
    expect(sanitizeSensitiveSummary('Set-Cookie: session=xyz; HttpOnly')).toBe('Set-Cookie=[REDACTED] HttpOnly')
  })

  it('leaves ordinary failure text untouched', () => {
    const message = 'connect ECONNREFUSED 127.0.0.1:4456 after 500ms'
    expect(sanitizeSensitiveSummary(message)).toBe(message)
    expect(sanitizeSensitiveSummary('HTTP 503 from upstream')).toBe('HTTP 503 from upstream')
  })
})
