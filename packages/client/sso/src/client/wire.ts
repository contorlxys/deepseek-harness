/**
 * Browser-side wire helpers over the Host's single sign-on routes: the shape
 * guards both components narrow answers with, and the two calls they share —
 * read the live state, and start the round trip. Paths and payload types come
 * from the Host package, so the two halves cannot drift apart.
 */
import type { SsoAuthorize, SsoStatus } from '@deepseek-ai/dsh-host-sso/shared'
import { SSO_AUTHORIZE_ROUTE, SSO_STATUS_ROUTE } from '@deepseek-ai/dsh-host-sso/shared'

/** Narrow one status answer to the wire type. */
export function isSsoStatus(value: unknown): value is SsoStatus {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return typeof record['authenticated'] === 'boolean'
    && (record['expiresAt'] === undefined || typeof record['expiresAt'] === 'number')
}

/** Narrow one authorize answer to the wire type. */
export function isSsoAuthorize(value: unknown): value is SsoAuthorize {
  if (typeof value !== 'object' || value === null) return false
  return typeof (value as Record<string, unknown>)['authorizeUrl'] === 'string'
}

/**
 * Read the Host's authorization state.
 * @returns the state the Host reports.
 * @throws Error when the query fails or answers an unexpected shape.
 */
export async function readSsoStatus(): Promise<SsoStatus> {
  const response = await fetch(SSO_STATUS_ROUTE, { cache: 'no-store' })
  if (!response.ok) throw new Error(`sso: status answered HTTP ${String(response.status)}`)
  const payload: unknown = await response.json()
  if (!isSsoStatus(payload)) throw new Error('sso: status returned no state')
  return payload
}

/**
 * Ask the Host for one authorize URL and navigate to it. The Host owns the
 * PKCE material and the grant; the browser only ever navigates.
 * @returns after the navigation is under way.
 * @throws Error when the request fails or answers an unexpected shape.
 */
export async function beginSsoSignIn(): Promise<void> {
  const response = await fetch(SSO_AUTHORIZE_ROUTE, { cache: 'no-store' })
  if (!response.ok) throw new Error(`sso: authorize answered HTTP ${String(response.status)}`)
  const payload: unknown = await response.json()
  if (!isSsoAuthorize(payload)) throw new Error('sso: authorize returned no URL')
  window.location.assign(payload.authorizeUrl)
}
