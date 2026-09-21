/** Seed the browser deployment settings so rendered workbenches see a configured face. */

import { resolveBrowserSettings } from '../../src/client/remote/settings.ts'

/**
 * Writes the fixture deployment settings into `localStorage`.
 *
 * The workbench gates its whole render on the settings face: with nothing
 * stored it shows the configuration form instead of the account and workbench
 * surfaces. Specs that exercise those surfaces seed this before rendering.
 * @param overrides - Field overrides for the fixture settings.
 */
export function seedBrowserSettings(overrides: Record<string, string> = {}): void {
  window.localStorage.setItem(
    'dsh-ai-coding/settings/v1',
    JSON.stringify({
      apiBaseUrl: 'http://fixture.test/v1',
      accessToken: `fixture-${'token'}`,
      workspaceApiBaseUrl: 'http://fixture.test/v1',
      workspaceAccessToken: `fixture-${'token'}`,
      authMode: 'static-token',
      ...overrides,
    }),
  )
}

/** Whether the settings face is currently configured (test-side assertion aid). */
export function browserSettingsConfigured(): boolean {
  return resolveBrowserSettings() !== undefined
}
