/**
 * Authorization-code flow arithmetic for the Web frontend.
 *
 * Everything here is pure: the gate supplies the browser facts — the current
 * search string, random bytes, and navigation — so both directions of the
 * round trip are testable without a document.
 *
 * The gate stops at the code. Exchanging it for a token needs the client
 * secret, which must never reach this page; that exchange belongs to the
 * backend (today, the ERP-facing MCP server).
 */

import type { SsoConfig } from './config.ts'

/** One authorization code and the state value it was issued against. */
export interface SsoAuthorizationCode {
  /** Authorization code returned by the authorization server. */
  readonly code: string
  /** Opaque state value this page sent with the authorization request. */
  readonly state: string
}

/** What the authorization server put back on the redirect URL. */
export type SsoCallback =
  | { readonly kind: 'code'; readonly code: string; readonly state: string }
  | { readonly kind: 'error'; readonly error: string; readonly description?: string }

/** Query parameters the authorization server adds to the redirect URL. */
const CALLBACK_PARAMETERS = ['code', 'state', 'error', 'error_description'] as const

/** Resolve the absolute URL of one API path under the configured backend origin. */
export function joinUrl(baseUrl: string, path: string): string {
  if (baseUrl === '') return path
  const origin = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl
  return `${origin}${path.startsWith('/') ? path : `/${path}`}`
}

/**
 * Build one opaque state value, used to bind the redirect to this tab.
 * @param random - byte source; defaults to the Web Crypto generator.
 * @returns a hex string of 16 random bytes.
 */
export function createSsoState(random: (length: number) => Uint8Array = cryptoRandom): string {
  const bytes = random(16)
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}

function cryptoRandom(length: number): Uint8Array {
  const bytes = new Uint8Array(length)
  crypto.getRandomValues(bytes)
  return bytes
}

/**
 * The redirect target to use when the deployment names none: this document
 * without its query string, so the code lands on the page that sent it.
 * @param location - document location; defaults to the current one.
 * @returns the origin and path of `location`.
 */
export function defaultRedirectUri(location: { readonly origin: string; readonly pathname: string }
  = window.location): string {
  return `${location.origin}${location.pathname}`
}

/**
 * Build the authorization URL the browser is sent to.
 *
 * `URLSearchParams` performs the percent-encoding; unlike a hand-built
 * `encodeURI` it does not double-encode the redirect target.
 * @param config - endpoints and client identity.
 * @param options - state value and the redirect target carrying it back.
 * @returns the absolute authorization URL.
 */
export function buildAuthorizeUrl(config: SsoConfig, options: {
  readonly state: string
  readonly redirectUri: string
}): string {
  const parameters = new URLSearchParams({
    client_id: config.clientId,
    response_type: config.responseType,
    redirect_uri: options.redirectUri,
    state: options.state,
  })
  if (config.scope !== '') parameters.set('scope', config.scope)
  return `${joinUrl(config.apiBaseUrl, config.authorizePath)}?${parameters.toString()}`
}

/**
 * Read the authorization server's answer off a query string.
 * @param search - query string, with or without the leading `?`.
 * @returns the code or the reported error; undefined when the URL carries neither.
 */
export function readSsoCallback(search: string): SsoCallback | undefined {
  const parameters = new URLSearchParams(search)
  const code = parameters.get('code')
  if (code !== null && code !== '') {
    return { kind: 'code', code, state: parameters.get('state') ?? '' }
  }
  const error = parameters.get('error')
  if (error !== null && error !== '') {
    const description = parameters.get('error_description')
    return description === null || description === ''
      ? { kind: 'error', error }
      : { kind: 'error', error, description }
  }
  return undefined
}

/**
 * Strip the callback parameters so a reload cannot replay a spent code.
 * @param url - absolute URL of the current document.
 * @returns the origin-relative path, query, and hash without callback parameters.
 */
export function withoutCallbackParams(url: string): string {
  const parsed = new URL(url)
  for (const name of CALLBACK_PARAMETERS) parsed.searchParams.delete(name)
  return `${parsed.pathname}${parsed.search}${parsed.hash}`
}
