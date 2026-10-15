/**
 * Per-request bearer authentication for a Streamable HTTP MCP server: the
 * transport asks the credential seam for the access token before every
 * request, so a rotated token reaches the server without a reconnect — the one
 * case the per-connection `${cred:NAME}` substitution cannot serve, because a
 * transport snapshots its request headers for its lifetime.
 *
 * The SDK owns the wire form: it writes `Authorization: Bearer <token>`. A
 * deployment needing another header name or scheme uses a `${cred:NAME}`
 * template in `headers` instead, which resolves at every connection attempt.
 *
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CredentialRefResolver } from './credential-refs.ts'

/** Configured per-request authentication; an empty reference disables it. */
export interface RequestAuthConfig {
  /**
   * Credential reference naming the current access token. Empty (the schema
   * default) leaves every request with the configured headers alone.
   */
  credentialRef: string
}

/**
 * One transport's per-request authentication callbacks, shaped for the MCP
 * SDK's `AuthProvider`.
 */
export interface TransportAuth {
  /**
   * The current access token. Rejection fails the request that asked for it:
   * a referenced credential that is unconfigured, or a composition without a
   * credentials provider, is an operator error rather than an unauthenticated
   * request the server would reject on its own.
   */
  token(): Promise<string>
  /**
   * Called after the server answered 401. Re-reads the credential so the
   * SDK's single retry carries a value rotated in the meantime; an unchanged
   * value is reported as a rejection the operator must act on.
   */
  onUnauthorized(): Promise<void>
}

/**
 * Whether any configured header names `Authorization`, compared the way HTTP
 * compares field names.
 * @param headers - configured request headers.
 * @returns true when the configuration sets the header the SDK owns.
 */
export function hasAuthorizationHeader(headers: Readonly<Record<string, string>>): boolean {
  return Object.keys(headers).some(name => name.toLowerCase() === 'authorization')
}

/**
 * Drop every `Authorization` spelling from configured headers. An
 * authenticated transport's header is written by the SDK from the token
 * source, so a configured copy is never sent; removing it keeps the record of
 * what the transport sends honest. A configuration that sets both is rejected
 * at load rather than silently ignoring the header.
 * @param headers - configured request headers.
 * @returns a new record without the SDK-owned header.
 */
export function withoutAuthorization(headers: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => name.toLowerCase() !== 'authorization'),
  )
}

/**
 * Build one transport's per-request authentication.
 * @param ctx - Host context supplying the logger.
 * @param serverName - server identity used in diagnostics.
 * @param name - credential reference the transport reads before each request.
 * @param resolve - resolves one credential reference to its current value.
 * @returns the transport's authentication callbacks.
 */
export function createRequestAuth(
  ctx: Context,
  serverName: string,
  name: string,
  resolve: CredentialRefResolver,
): TransportAuth {
  const label = `mcp-client(${serverName})`
  /** The value handed to the last request that asked, for rejection reporting. */
  let issued: string | undefined
  return {
    async token(): Promise<string> {
      const value = await resolve(name)
      issued = value
      return value
    },
    async onUnauthorized(): Promise<void> {
      const value = await resolve(name)
      if (value !== issued) return
      ctx.logger.error(
        `${label}: the credential "${name}" was rejected with HTTP 401 and still resolves to the value just sent — re-authorize it or replace the stored credential; the retry carries the unchanged token`,
      )
    },
  }
}
