/**
 * Host half of Web single sign-on: the PKCE authorization-code round trip
 * against the identity provider, the grant stored in the credential seam's
 * record half, token refresh, and the reference projection consumers resolve.
 *
 * The browser never holds a secret. It asks `/sso/authorize` for a URL and
 * navigates; the identity provider redirects to `/sso/callback`, which this
 * Host validates (state + single use), exchanges with the verifier it kept,
 * commits the grant, and projects the access token onto the configured
 * credential reference — the fan-out of that projection is what recycles
 * consumer connections (MCP transports) with the new token.
 *
 * The callback is an authorization-server redirect target, so it cannot
 * require the browser login cookie; the state value — unguessable,
 * single-use, expiring — is its CSRF protection, per the OAuth2 redirect
 * model. The other routes are browser fetches and pass the connection trust
 * fence first.
 *
 * @module
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
// Side-effect type import: declaration-merges `ctx.webServer` onto Context.
import type {} from '@deepseek-ai/dsh-host-webserver'
import z from '@deepseek-ai/schemastery'
import { buildAuthorizeUrl, createPkcePair, createState, requestTokens, TokenRejectedError, type SsoExchangeConfig } from './authorize.ts'
import { createGrantStore, createPendingStore, PENDING_TTL_MS, projectToken, tokenRef, withdrawToken, type GrantStore, type SsoGrant } from './grant.ts'
import { SSO_AUTHORIZE_PATH, SSO_CALLBACK_PATH, SSO_LOGOUT_PATH, SSO_STATUS_PATH, type SsoAuthorize, type SsoStatus } from './shared.ts'

export type * from './shared.ts'

/** Cordis function-plugin name. */
export const name = 'sso'

/** The route carrier, the trust fence guarding the browser routes, and the credential store. */
export const inject = ['webServer', 'connection', 'credentials']

/** Credential reference the access token is projected onto unless configured otherwise. */
export const DEFAULT_TOKEN_REF = 'DSH_ERP_ACCESS_TOKEN'

/** Single sign-on host configuration. */
export interface Config {
  /** `mock` derives tokens without network; `remote` runs the real round trip. */
  readonly mode: 'mock' | 'remote'
  /**
   * Authorization endpoint, or the front-end relay page that forwards to it;
   * required exactly when `mode` is `remote`. With a fragment
   * (`https://idp/#/oauth2/`) the parameters ride inside the fragment
   * (`#/oauth2/?…`), where a hash-routed relay reads them from the full href.
   */
  readonly authorizeUrl: string
  /** Token endpoint; required exactly when `mode` is `remote`. */
  readonly tokenUrl: string
  /** Public OAuth2 client identifier; required exactly when `mode` is `remote`. */
  readonly clientId: string
  /**
   * Confidential-client secret for the token endpoint, or empty for a public
   * PKCE client; falls back to `$DSH_SSO_CLIENT_SECRET`. It stays host-side:
   * never logged and never sent to the browser.
   */
  readonly clientSecret: string
  /** Requested scope; empty omits the parameter. */
  readonly scope: string
  /** Callback path the authorize redirect targets. */
  readonly redirectPath: string
  /**
   * Absolute callback URL registered with the identity provider; empty derives
   * `http://<request Host><redirectPath>`. Set it when the deployment is
   * reached through TLS or a proxy, where the derived origin would not match
   * the registration.
   */
  readonly redirectUri: string
  /** This plugin's own addressing unit for the grant record. */
  readonly credentialKey: string
  /** Credential reference the access token is projected onto. */
  readonly credentialRef: string
  /** Refresh this long before the access token expires, in milliseconds. */
  readonly expirySkewMs: number
  /** Deadline for one remote exchange in milliseconds. */
  readonly exchangeTimeoutMs: number
}

export const Config: z<Config> = z.object({
  mode: z.union(['mock', 'remote'] as const).default('mock'),
  authorizeUrl: z.string().default(''),
  tokenUrl: z.string().default(''),
  clientId: z.string().default(''),
  clientSecret: z.string().default(''),
  scope: z.string().default(''),
  redirectPath: z.string().default(SSO_CALLBACK_PATH),
  redirectUri: z.string().default(''),
  credentialKey: z.string().default('default'),
  credentialRef: z.string().default(DEFAULT_TOKEN_REF),
  expirySkewMs: z.number().step(1).min(1).max(3_600_000).default(60_000),
  exchangeTimeoutMs: z.number().step(1).min(1).max(600_000).default(15_000),
})

/** Trust surface consumed here; the browser-side connection package owns the full type. */
interface SsoConnection {
  requestRejection(request: { readonly headers: IncomingMessage['headers'] }): 401 | 403 | undefined
}

/** The composition's connection service (typed locally: its package is browser-side). */
function connectionOf(ctx: Context): SsoConnection {
  return Reflect.get(ctx, 'connection') as SsoConnection
}

/** JSON response (no-store: authorization outcomes are live facts). */
function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

/**
 * Where the browser belongs once the grant is committed: everything before the
 * callback's own last path segment. Derived from the request instead of
 * configured, so a deployment that proxies the whole app under a prefix
 * returns to that prefix rather than to the absolute root.
 * @param req - the callback request.
 * @param config - validated configuration naming the callback path.
 * @returns the absolute path to redirect to; `/` when nothing precedes the callback.
 */
function completionReturnPath(req: IncomingMessage, config: Config): string {
  const pathname = (req.url ?? '/').split('?')[0] ?? '/'
  const suffix = config.redirectPath
  if (suffix !== '' && pathname.endsWith(suffix)) {
    const prefix = pathname.slice(0, -suffix.length)
    return prefix === '' ? '/' : prefix
  }
  const cut = pathname.lastIndexOf('/')
  return cut <= 0 ? '/' : pathname.slice(0, cut)
}

/**
 * Send the browser back to the application: the completion is a 302 whose
 * location is the app, so a signed-in user lands on the home screen instead of
 * on a dead end. The body is the fallback for a client that does not follow
 * the redirect, and its link is relative for the same reason the location is.
 * @param req - the callback request.
 * @param res - the response to end.
 * @param config - validated configuration naming the callback path.
 */
function sendCompleteRedirect(req: IncomingMessage, res: ServerResponse, config: Config): void {
  res.statusCode = 302
  res.setHeader('location', completionReturnPath(req, config))
  res.setHeader('content-type', 'text/html; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end('<!doctype html><html><body style="font-family:system-ui;padding:2rem">'
    + '<p>Authorization complete. <a href="../">Return to the application</a>.</p>'
    + '</body></html>')
}

/**
 * The absolute callback URL one authorize request presents to the identity
 * provider: the configured registration, or the request's own origin when the
 * deployment names none.
 * @param req - the authorize request.
 * @param config - validated configuration carrying the optional override.
 * @returns the redirect target; it must equal what the provider has registered.
 */
function callbackUri(req: IncomingMessage, config: Config): string {
  if (config.redirectUri !== '') return config.redirectUri
  const host = req.headers['host']
  if (typeof host !== 'string' || host === '') throw new Error('sso: the authorize request carries no Host header')
  return `http://${host}${config.redirectPath}`
}

/**
 * Assert one configured callback URL can be presented as a redirect target.
 * @param value - the configured `redirectUri`.
 * @throws Error when it is not an absolute HTTP(S) URL free of credentials and fragments.
 */
function assertRedirectUri(value: string): void {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`sso: redirectUri "${value}" is not an absolute URL`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`sso: redirectUri "${value}" must use http or https`)
  }
  if (url.username !== '' || url.password !== '' || url.hash !== '') {
    throw new Error(`sso: redirectUri "${value}" must carry no credentials and no fragment`)
  }
}

/**
 * Mount the single sign-on routes and recover the stored grant.
 * @param ctx - plugin context carrying the webServer, connection, and credentials services.
 * @param config - validated {@link Config}.
 */
export function apply(ctx: Context, config: Config): void {
  // Misconfiguration fails loud at activation, before any request can arrive.
  if (config.mode === 'remote') {
    if (config.authorizeUrl === '' || config.tokenUrl === '') {
      throw new Error('sso: mode "remote" requires authorizeUrl and tokenUrl')
    }
    if (config.clientId === '') throw new Error('sso: mode "remote" requires clientId')
  }
  if (config.redirectUri !== '') assertRedirectUri(config.redirectUri)
  const exchange: SsoExchangeConfig = {
    mode: config.mode,
    authorizeUrl: config.authorizeUrl,
    tokenUrl: config.tokenUrl,
    clientId: config.clientId,
    // A confidential client keeps its secret out of the profile where it can:
    // the config value wins, the environment is the layer a deployment sets.
    clientSecret: config.clientSecret !== ''
      ? config.clientSecret
      : (process.env['DSH_SSO_CLIENT_SECRET'] ?? ''),
    scope: config.scope,
    exchangeTimeoutMs: config.exchangeTimeoutMs,
  }
  const store: GrantStore = createGrantStore(ctx, config.credentialKey)
  const ref = tokenRef(config.credentialRef)

  /** Pending round trips on the credential seam's record half: a sign-in started
   * before a Host restart is still consumable after it. */
  const pending = createPendingStore(ctx, config.credentialKey)

  /** Answer an untrusted/unauthenticated browser fetch; true when it was rejected. */
  const rejected = (req: IncomingMessage, res: ServerResponse): boolean => {
    const rejection = connectionOf(ctx).requestRejection(req)
    if (rejection === undefined) return false
    res.statusCode = rejection
    res.end()
    return true
  }

  /** Read one query parameter from a request URL. */
  const query = (req: IncomingMessage, name: string): string | undefined => {
    const url = req.url
    if (url === undefined) return undefined
    const value = new URL(url, 'http://localhost').searchParams.get(name)
    return value === null || value === '' ? undefined : value
  }

  /**
   * Commit one fresh token set over whatever grant is stored.
   * @param tokens - the token-endpoint answer; the refresh token is mandatory
   *   on a code exchange because it is this plugin's renewal root.
   * @returns the grant after the write.
   */
  const commitTokens = async (tokens: { accessToken: string; refreshToken?: string; expiresInMs: number }): Promise<SsoGrant> => {
    const refreshToken = tokens.refreshToken
    if (refreshToken === undefined) {
      throw new Error('sso: the token endpoint returned no refresh token')
    }
    const grant = await store.commit(() => Promise.resolve({
      accessToken: tokens.accessToken,
      refreshToken,
      expiresAt: Date.now() + tokens.expiresInMs,
    }))
    if (grant === undefined) {
      // commit() replaces rather than declines: undefined means the provider
      // refused the write, which has no silent interpretation.
      throw new Error('sso: the credential provider refused the grant write')
    }
    await projectToken(ctx, ref, grant.accessToken)
    return grant
  }

  /**
   * Read the grant, refreshing it when inside the expiry skew window. The
   * refresh runs inside the store's serialized write, so concurrent callers
   * rotate once and re-read the winner's grant. Only a refused grant withdraws
   * the record — and that removal happens outside the write, because removing
   * a record from inside its own read-modify-write would deadlock the seam's
   * lock. A transient failure (unreachable endpoint, 5xx) keeps the record so
   * the next call retries: deleting the renewal root over a network blip would
   * cost the operator a fresh login.
   * @returns the usable grant, or undefined when none is stored, a refresh was
   *   refused, or the refresh could not be completed right now.
   */
  const usableGrant = async (): Promise<SsoGrant | undefined> => {
    /** The failure that stopped this call's refresh, or undefined when none was attempted. */
    let refreshFailure: unknown
    const grant = await store.commit(async (current) => {
      if (current === undefined) return undefined
      if (current.expiresAt - Date.now() > config.expirySkewMs) return undefined
      try {
        const tokens = await requestTokens(exchange, { refreshToken: current.refreshToken })
        return {
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken ?? current.refreshToken,
          expiresAt: Date.now() + tokens.expiresInMs,
        }
      } catch (error) {
        // Leave the record standing: a refusal is withdrawn outside the write
        // (removing a record from inside its own read-modify-write would
        // deadlock the seam's lock), and a transient failure keeps it so the
        // next call retries instead of costing the operator a fresh login.
        refreshFailure = error
        return undefined
      }
    })
    if (refreshFailure !== undefined) {
      const refused = refreshFailure instanceof TokenRejectedError
      const reason = refreshFailure instanceof Error ? refreshFailure.message : 'unknown failure'
      ctx.logger.warn(refused
        ? `sso: token refresh refused, withdrawing the grant: ${reason}`
        : `sso: token refresh could not be completed, keeping the stored grant: ${reason}`)
      if (refused) {
        await store.remove()
        await withdrawToken(ctx, ref)
      }
      // An expired grant whose refresh could not be completed is not usable
      // even though the record it came from still is: report unauthenticated
      // rather than hand a dead token to consumers.
      return undefined
    }
    if (grant !== undefined) {
      // Project the stored token whether or not this call refreshed it: the
      // reference must not lag the record (a Host restart between grant and
      // projection, say).
      await projectToken(ctx, ref, grant.accessToken)
    }
    return grant
  }

  // Recover any stored grant on activation so consumers resolve a live token
  // without waiting for the first status poll.
  void usableGrant().catch((error: unknown) => {
    ctx.logger.warn(`sso: grant recovery failed: ${String(error)}`)
  })

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: SSO_AUTHORIZE_PATH,
    handler: async (req, res) => {
      if (rejected(req, res)) return
      if (req.method !== 'GET') {
        res.statusCode = 405
        res.setHeader('allow', 'GET')
        res.end()
        return
      }
      try {
        const redirectUri = callbackUri(req, config)
        const state = createState()
        const { verifier, challenge } = createPkcePair()
        const now = Date.now()
        // Drain expired attempts first: an abandoned sign-in must not leave its
        // verifier behind for the rest of its deadline.
        await pending.drain(now)
        await pending.put(state, { verifier, expiresAt: now + PENDING_TTL_MS })
        // Mock mode skips the identity provider: the "authorize" URL is this
        // Host's own callback carrying a mock code, so the browser-side flow
        // is identical to the real one.
        const authorizeUrl = config.mode === 'mock'
          ? `${redirectUri}?code=${encodeURIComponent(`mock-code-${state}`)}&state=${encodeURIComponent(state)}`
          : buildAuthorizeUrl(exchange, { state, challenge, redirectUri })
        const payload: SsoAuthorize = { authorizeUrl }
        sendJson(res, 200, payload)
      } catch (error) {
        sendJson(res, 400, { code: 'bad-request', message: String(error) })
      }
    },
  }), `sso: GET ${SSO_AUTHORIZE_PATH}`)

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: SSO_CALLBACK_PATH,
    handler: async (req, res) => {
      // No connection fence here: the identity provider redirects a browser
      // that has never authenticated with this Host. The state value —
      // unguessable, single-use, expiring — is the CSRF protection.
      if (req.method !== 'GET') {
        res.statusCode = 405
        res.setHeader('allow', 'GET')
        res.end()
        return
      }
      const state = query(req, 'state')
      const code = query(req, 'code')
      const error = query(req, 'error')
      if (error !== undefined) {
        sendJson(res, 502, { code: 'authorization-denied', message: error })
        return
      }
      if (state === undefined || code === undefined) {
        sendJson(res, 400, { code: 'bad-request', message: 'the callback requires code and state parameters' })
        return
      }
      const attempt = await pending.take(state)
      if (attempt === undefined || attempt.expiresAt <= Date.now()) {
        // A state minted by ANOTHER Host instance — same profile config, another
        // port, so the redirect target and the instance that signed the user in
        // differ — is indistinguishable from an expired one here. Name this Host
        // so the mismatch reads as a configuration fact, not a random failure.
        sendJson(res, 400, {
          code: 'bad-state',
          message: `the callback state is unknown or expired for this Host (${req.headers.host ?? 'unknown host'}); the redirect target must be the instance the sign-in started on — start again`,
        })
        return
      }
      const redirectUri = callbackUri(req, config)
      try {
        const tokens = await requestTokens(exchange, {
          code,
          codeVerifier: attempt.verifier,
          redirectUri,
        })
        await commitTokens(tokens)
        sendCompleteRedirect(req, res, config)
      } catch (exchangeError) {
        sendJson(res, 502, { code: 'exchange-failed', message: String(exchangeError) })
      }
    },
  }), `sso: GET ${SSO_CALLBACK_PATH}`)

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: SSO_STATUS_PATH,
    handler: async (req, res) => {
      if (rejected(req, res)) return
      if (req.method !== 'GET') {
        res.statusCode = 405
        res.setHeader('allow', 'GET')
        res.end()
        return
      }
      const grant = await usableGrant()
      const payload: SsoStatus = grant === undefined
        ? { authenticated: false }
        : { authenticated: true, expiresAt: grant.expiresAt }
      sendJson(res, 200, payload)
    },
  }), `sso: GET ${SSO_STATUS_PATH}`)

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: SSO_LOGOUT_PATH,
    handler: async (req, res) => {
      if (rejected(req, res)) return
      if (req.method !== 'POST') {
        res.statusCode = 405
        res.setHeader('allow', 'POST')
        res.end()
        return
      }
      req.resume()
      await store.remove()
      await withdrawToken(ctx, ref)
      const payload: SsoStatus = { authenticated: false }
      sendJson(res, 200, payload)
    },
  }), `sso: POST ${SSO_LOGOUT_PATH}`)
}
