/** Explicit validation and defaults for collector queue settings supplied by Host config. */

import type { TelemetryQueueSettings } from '../types.ts'

/**
 * Defaults applied by {@link resolveTelemetrySettings} when the deployment
 * omits a field. They are the resolve step's documented baseline, not a
 * bypass: every field stays overridable from `cordis.yml` and every provided
 * value is validated.
 */
const DEFAULT_TELEMETRY_SETTINGS: TelemetryQueueSettings = {
  maxEvents: 10_000,
  maxBytes: 33_554_432,
  batchMaxEvents: 500,
  batchMaxBytes: 2_097_152,
  flushIntervalMs: 15_000,
  httpTimeoutMs: 10_000,
  maxAttempts: 12,
  retentionMs: 604_800_000,
  claimTimeoutMs: 60_000,
}

/**
 * Resolve collector settings from optional deployment config.
 * @param config - Raw config values; every present field must be a positive integer.
 * @returns The complete validated settings.
 * @throws when a provided value is not a positive integer or batch limits exceed queue capacity.
 */
export function resolveTelemetrySettings(config?: Partial<TelemetryQueueSettings>): TelemetryQueueSettings {
  const resolved = { ...DEFAULT_TELEMETRY_SETTINGS, ...(config ?? {}) } as TelemetryQueueSettings
  for (const field of Object.keys(DEFAULT_TELEMETRY_SETTINGS) as Array<keyof TelemetryQueueSettings>) {
    const value = resolved[field]
    if (!Number.isInteger(value) || value <= 0) throw new Error(`telemetry config "${field}" must be a positive integer`)
  }
  if (resolved.batchMaxEvents > resolved.maxEvents) throw new Error('telemetry config "batchMaxEvents" must not exceed "maxEvents"')
  if (resolved.batchMaxBytes > resolved.maxBytes) throw new Error('telemetry config "batchMaxBytes" must not exceed "maxBytes"')
  return resolved
}
