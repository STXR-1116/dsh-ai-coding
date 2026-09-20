import { randomUUID } from 'node:crypto'

type AccountRole = 'admin' | 'manager' | 'member'

export interface RefreshedAccountSession {
  readonly accessToken: string
  readonly refreshToken: string
  readonly expiresAt: number
  readonly mustChangePassword: boolean
  readonly role: AccountRole
}

const refreshInFlight = new Map<string, Promise<RefreshedAccountSession | undefined>>()

/** Refresh an account session without accepting incomplete or stale token data. */
export async function refreshServiceSession(
  baseUrl: string,
  refreshToken: string,
  fetcher: typeof fetch = fetch,
): Promise<RefreshedAccountSession | undefined> {
  let response: Response
  try {
    response = await fetcher(`${baseUrl}/auth/refresh`, {
      method: 'POST',
      cache: 'no-store',
      headers: { accept: 'application/json', 'content-type': 'application/json', 'idempotency-key': randomUUID() },
      body: JSON.stringify({ refresh_token: refreshToken }),
    })
  } catch {
    return undefined
  }
  if (!response.ok) return undefined
  let value: unknown
  try {
    value = await response.json()
  } catch {
    return undefined
  }
  const envelope =
    isRecord(value) &&
    Object.hasOwn(value, 'data') &&
    (typeof value.code === 'number' || typeof value.code === 'string') &&
    typeof value.message === 'string' &&
    typeof value.request_id === 'string'
      ? value.data
      : undefined
  if (!isRecord(envelope)) return undefined
  const data = envelope
  const accessToken = typeof data.access_token === 'string' && data.access_token.length > 0 ? data.access_token : undefined
  const nextRefreshToken = typeof data.refresh_token === 'string' && data.refresh_token.length > 0 ? data.refresh_token : undefined
  const expiresIn =
    typeof data.expires_in === 'number' && Number.isFinite(data.expires_in) && data.expires_in > 0 ? data.expires_in : undefined
  const mustChangePassword = typeof data.must_change_password === 'boolean' ? data.must_change_password : undefined
  const user = isRecord(data.user) ? data.user : undefined
  const role = user === undefined || !isRole(user.global_role) ? undefined : user.global_role
  if (
    accessToken === undefined ||
    nextRefreshToken === undefined ||
    expiresIn === undefined ||
    mustChangePassword === undefined ||
    role === undefined
  )
    return undefined
  return { accessToken, refreshToken: nextRefreshToken, expiresAt: Date.now() + expiresIn * 1000, mustChangePassword, role }
}

/** Coordinate concurrent Auth.js JWT refresh callbacks for one service session. */
export function refreshServiceSessionOnce(
  baseUrl: string,
  refreshToken: string,
  fetcher: typeof fetch = fetch,
): Promise<RefreshedAccountSession | undefined> {
  const key = `${baseUrl}\u0000${refreshToken}`
  const existing = refreshInFlight.get(key)
  if (existing !== undefined) return existing
  const pending = refreshServiceSession(baseUrl, refreshToken, fetcher)
  const coordinated = pending.finally(() => {
    if (refreshInFlight.get(key) === coordinated) refreshInFlight.delete(key)
  })
  refreshInFlight.set(key, coordinated)
  return coordinated
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function isRole(value: unknown): value is AccountRole {
  return value === 'admin' || value === 'manager' || value === 'member'
}
