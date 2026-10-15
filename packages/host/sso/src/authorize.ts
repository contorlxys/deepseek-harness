/**
 * Authorization primitives for the Web single sign-on round trip: PKCE pair
 * and state generation, the authorize-URL build, and the token-endpoint
 * exchange for both the authorization code and the refresh grant.
 *
 * `mock` mode derives deterministic tokens without any network call, so the
 * whole round trip is exercisable before the identity provider ships; it
 * answers the same {@link TokenSet} shape `remote` does, including a rotated
 * refresh token on refresh.
 *
 * @module
 */

import { createHash, randomBytes } from 'node:crypto'

/** One PKCE pair: the verifier this Host keeps, the challenge it publishes. */
export interface PkcePair {
  readonly verifier: string
  readonly challenge: string
}

/** CSRF state binding one authorize redirect to its callback. */
export type SsoState = string

/**
 * The token endpoint answered with an OAuth2 error: the grant itself was
 * refused (`invalid_grant`, `invalid_client`, …), which no retry can fix. A
 * transient failure — an unreachable endpoint, a 5xx, an unusable body — is a
 * plain {@link Error} instead, so a caller can tell a dead grant from a bad
 * minute.
 */
export class TokenRejectedError extends Error {
  /** @param code - the endpoint's OAuth2 `error` value. */
  constructor(readonly code: string) {
    super(`sso: the token endpoint refused the grant: ${code}`)
  }
}

/**
 * Derive a PKCE pair (RFC 7636, S256).
 * @returns the verifier held in memory and its SHA-256 challenge.
 */
export function createPkcePair(): PkcePair {
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

/**
 * Create one unguessable state value.
 * @returns 128 random bits, hex-encoded.
 */
export function createState(): SsoState {
  return randomBytes(16).toString('hex')
}

/** Exchange settings for authorize-URL building and token requests. */
export interface SsoExchangeConfig {
  /** `mock` derives tokens locally; `remote` calls the token endpoint. */
  readonly mode: 'mock' | 'remote'
  /** Authorization endpoint; required exactly when `mode` is `remote`. */
  readonly authorizeUrl: string
  /** Token endpoint; required exactly when `mode` is `remote`. */
  readonly tokenUrl: string
  /** Public OAuth2 client identifier; required exactly when `mode` is `remote`. */
  readonly clientId: string
  /**
   * Confidential-client secret posted as `client_secret`; empty keeps the
   * exchange a public-client PKCE one. It stays host-side: never logged and
   * never sent to the browser.
   */
  readonly clientSecret: string
  /** Requested scope; empty omits the parameter. */
  readonly scope: string
  /** Deadline for one remote exchange in milliseconds. */
  readonly exchangeTimeoutMs: number
}

/** Redirect parameters this Host binds into the authorize URL. */
export interface AuthorizeParameters {
  readonly state: SsoState
  readonly challenge: string
  readonly redirectUri: string
}

/**
 * Attach the OAuth2 parameters to the configured authorize target.
 *
 * A plain endpoint carries them as its query (`https://idp/authorize?…`). Some
 * deployments instead expose only a hash-routed authorization PAGE
 * (`https://idp/#/oauth2/`), which reads its route query from the fragment; a
 * `URL`'s search always lands before the hash, so there the parameters ride
 * INSIDE the fragment (`#/oauth2/?…`) or the page would see none of them.
 * @param target - the configured authorize target.
 * @param parameters - the parameters, in the order they should be written.
 * @returns the complete URL.
 */
function withAuthorizeParameters(target: string, parameters: [string, string][]): string {
  const url = new URL(target)
  const query = new URLSearchParams(parameters)
  const route = url.hash.slice(1)
  if (route === '') {
    url.search = query.toString()
    return url.href
  }
  const separator = route.indexOf('?')
  const path = separator === -1 ? route : route.slice(0, separator)
  const carried = new URLSearchParams(separator === -1 ? '' : route.slice(separator + 1))
  for (const [key, value] of query) carried.set(key, value)
  url.search = ''
  url.hash = `${path}?${carried.toString()}`
  return url.href
}

/**
 * Build the authorization-server URL the browser navigates to.
 * @param config - exchange settings naming the authorize endpoint or page.
 * @param parameters - state, PKCE challenge, and the callback redirect target.
 * @returns the complete authorize URL.
 */
export function buildAuthorizeUrl(config: SsoExchangeConfig, parameters: AuthorizeParameters): string {
  const entries: [string, string][] = [
    ['response_type', 'code'],
    ['client_id', config.clientId],
  ]
  if (config.scope !== '') entries.push(['scope', config.scope])
  entries.push(
    ['state', parameters.state],
    ['code_challenge', parameters.challenge],
    ['code_challenge_method', 'S256'],
    ['redirect_uri', parameters.redirectUri],
  )
  return withAuthorizeParameters(config.authorizeUrl, entries)
}

/** One token-endpoint request: a code exchange or a refresh. */
export interface TokenRequest {
  /** Authorization code from the callback; present for a code exchange. */
  readonly code?: string
  /** PKCE verifier bound to this code; present for a code exchange. */
  readonly codeVerifier?: string
  /** Refresh token to exchange; present for a refresh. */
  readonly refreshToken?: string
  /** Callback target the code was issued for; present for a code exchange. */
  readonly redirectUri?: string
}

/** One token-endpoint answer. */
export interface TokenSet {
  readonly accessToken: string
  /**
   * The rotated refresh token; absent when the endpoint kept the existing
   * one, in which case the caller retains the stored refresh token.
   */
  readonly refreshToken?: string
  /** Milliseconds from now the access token expires. */
  readonly expiresInMs: number
}

/** Fixed lifetime of mock-derived access tokens. */
const MOCK_TOKEN_LIFETIME_MS = 3_600_000

/**
 * Derive the mock token material for one exchange input.
 * @param kind - token flavor separating access from refresh derivations.
 * @param input - the value the derivation is keyed on.
 * @returns a deterministic token: the same input always yields the same token.
 */
function mockToken(kind: 'access' | 'refresh', input: string): string {
  const digest = createHash('sha256').update(`${kind}:${input}`).digest('hex')
  return `mock-erp-${digest.slice(0, 32)}`
}

/** The JSON body the remote token endpoint answers with. */
interface TokenResponse {
  readonly access_token?: unknown
  readonly refresh_token?: unknown
  readonly expires_in?: unknown
}

/**
 * Read the OAuth2 `error` code of a refused token request (RFC 6749 §5.2).
 * @param response - the non-OK token-endpoint answer.
 * @returns the error code, or undefined when the body does not carry one.
 */
async function rejectionCode(response: Response): Promise<string | undefined> {
  let parsed: unknown
  try {
    parsed = await response.json()
  } catch {
    // A non-JSON refusal (proxy error page, HTML) names no OAuth2 error.
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const error = (parsed as { error?: unknown }).error
  return typeof error === 'string' && error !== '' ? error : undefined
}

/**
 * Request one token set — by authorization code or by refresh grant.
 * @param config - exchange mode, endpoints, and deadline.
 * @param request - the code exchange or the refresh token to present.
 * @param post - HTTP carrier; defaults to global fetch.
 * @returns the token set; the refresh token is absent when the endpoint did
 *   not rotate it.
 * @throws Error when the endpoint is unreachable, refuses the grant, or
 *   answers without a usable access token.
 */
export async function requestTokens(
  config: SsoExchangeConfig,
  request: TokenRequest,
  post: typeof fetch = fetch,
): Promise<TokenSet> {
  if (config.mode === 'mock') {
    if (request.refreshToken !== undefined) {
      return {
        accessToken: mockToken('access', request.refreshToken),
        refreshToken: mockToken('refresh', request.refreshToken),
        expiresInMs: MOCK_TOKEN_LIFETIME_MS,
      }
    }
    const code = request.code ?? ''
    const verifier = request.codeVerifier ?? ''
    return {
      accessToken: mockToken('access', `${code}:${verifier}`),
      refreshToken: mockToken('refresh', `${code}:${verifier}`),
      expiresInMs: MOCK_TOKEN_LIFETIME_MS,
    }
  }
  const isRefresh = request.refreshToken !== undefined
  const body = new URLSearchParams({
    grant_type: isRefresh ? 'refresh_token' : 'authorization_code',
    client_id: config.clientId,
    ...(config.clientSecret === '' ? {} : { client_secret: config.clientSecret }),
    ...(isRefresh ? { refresh_token: request.refreshToken ?? '' } : {
      code: request.code ?? '',
      code_verifier: request.codeVerifier ?? '',
      redirect_uri: request.redirectUri ?? '',
    }),
  })
  let response: Response
  try {
    response = await post(config.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(config.exchangeTimeoutMs),
    })
  } catch (error) {
    throw new Error(`sso: the token endpoint is unreachable: ${String(error)}`)
  }
  if (!response.ok) {
    // A refused grant arrives as an OAuth2 error body and is terminal; every
    // other non-OK answer (5xx, a proxy page) is treated as the transient
    // failure it is, so a caller never destroys a renewal root over a blip.
    const code = await rejectionCode(response)
    if (code !== undefined) throw new TokenRejectedError(code)
    throw new Error(`sso: the token endpoint answered HTTP ${String(response.status)}`)
  }
  let parsed: unknown
  try {
    parsed = await response.json()
  } catch {
    // A non-JSON answer is the same observable fact: no usable token came back.
    throw new Error('sso: the token endpoint returned no usable token')
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('sso: the token endpoint returned no usable token')
  }
  const answer = parsed as TokenResponse
  const accessToken = answer.access_token
  if (typeof accessToken !== 'string' || accessToken === '') {
    throw new Error('sso: the token endpoint returned no usable token')
  }
  const expiresIn = answer.expires_in
  if (typeof expiresIn !== 'number' || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new Error('sso: the token endpoint returned no usable expiry')
  }
  const refreshToken = answer.refresh_token
  return {
    accessToken,
    ...(typeof refreshToken === 'string' && refreshToken !== '' ? { refreshToken } : {}),
    expiresInMs: expiresIn * 1000,
  }
}
