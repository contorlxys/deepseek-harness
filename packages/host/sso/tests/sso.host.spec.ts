/**
 * The single sign-on routes over fake contexts (every wire branch: the trust
 * fence, method validation, state binding, the mock exchange, grant storage
 * and projection, refresh, and logout), plus one wiring test through the real
 * Loader and WebServer covering the whole mock round trip. The connection
 * service is a controllable stub (its real provider is the browser
 * composition); the credential provider is an in-memory seam implementation.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import * as Sso from '../src/index.ts'
import { buildAuthorizeUrl, createPkcePair, createState, requestTokens } from '../src/authorize.ts'
import { parseGrantRecord, type SsoGrant } from '../src/grant.ts'
import {
  SSO_AUTHORIZE_PATH, SSO_CALLBACK_PATH, SSO_LOGOUT_PATH, SSO_STATUS_PATH, type SsoAuthorize, type SsoStatus,
} from '../src/shared.ts'

/**
 * The plugin's configuration interface. The package publishes its Schemastery
 * schema under the same name `Config`, so fixtures are typed through the entry
 * point's own parameter instead of that schema class instance.
 */
type SsoConfig = Parameters<typeof Sso.apply>[1]

/** Parse one route's JSON body for assertions; every route answers a small object. */
function jsonBody(response: { readonly body: string }): Record<string, unknown> {
  return JSON.parse(response.body) as Record<string, unknown>
}

/** The trust-fence answer the connection stub gives every request. */
const trust: { rejection: 401 | 403 | undefined } = { rejection: undefined }

afterEach(() => {
  trust.rejection = undefined
  vi.unstubAllGlobals()
})

// ---- In-memory credential seam ----

/** The grant store this plugin's record address maps to. */
type MemoryRecord = { kind: 'grant'; payload: Record<string, unknown> } | { kind: 'api-key'; key?: string }

/** In-memory credential provider implementing the record and reference halves this suite drives. */
class MemoryCredentials {
  readonly set = vi.fn(async (ref: string, value: string): Promise<void> => {
    stored.refs.set(ref, value)
  })
  readonly unset = vi.fn(async (ref: string): Promise<void> => {
    stored.refs.delete(ref)
  })
  readonly readRecord = vi.fn(async (key: string): Promise<MemoryRecord | undefined> => {
    return stored.records.get(key)
  })
  readonly modifyRecord = vi.fn(async (
    key: string,
    mutate: (current: MemoryRecord | undefined) => Promise<MemoryRecord | undefined>,
  ): Promise<MemoryRecord | undefined> => {
    const current = stored.records.get(key)
    const next = await mutate(current)
    if (next !== undefined) {
      stored.records.set(key, next)
      return next
    }
    // The seam's declined semantics: mutate declined, so the current record stands.
    return current
  })
  readonly deleteRecord = vi.fn(async (key: string): Promise<void> => {
    stored.records.delete(key)
  })
  readonly listRecords = vi.fn(async (): Promise<readonly { key: string; kind: MemoryRecord['kind'] }[]> => {
    return [...stored.records.entries()].map(([key, record]) => ({ key, kind: record.kind }))
  })
  readonly store = stored
}

const stored = {
  records: new Map<string, MemoryRecord>(),
  refs: new Map<string, string>(),
}

function freshCredentials(): MemoryCredentials {
  stored.records.clear()
  stored.refs.clear()
  const provider = new MemoryCredentials()
  provider.set.mockClear()
  provider.unset.mockClear()
  return provider
}

// ---- Fake mounting ----

type SsoRoute = {
  kind: 'exact'
  path: string
  handler: (req: unknown, res: unknown) => Promise<void> | void
}

function defaultConfig(overrides: Partial<SsoConfig> = {}): SsoConfig {
  const base: SsoConfig = {
    mode: 'mock',
    authorizeUrl: '',
    tokenUrl: '',
    clientId: '',
    clientSecret: '',
    scope: '',
    redirectPath: SSO_CALLBACK_PATH,
    redirectUri: '',
    credentialKey: 'default',
    credentialRef: 'DSH_ERP_ACCESS_TOKEN',
    expirySkewMs: 60_000,
    exchangeTimeoutMs: 15_000,
  }
  return Object.assign(base, overrides)
}

/** Mount one apply() against a fake context; answers with the routes and the provider. */
function mount(config: Partial<SsoConfig> = {}): {
  route: (path: string) => SsoRoute['handler']
  credentials: MemoryCredentials
  warns: string[]
} {
  const routes = new Map<string, SsoRoute>()
  const credentials = freshCredentials()
  const warns: string[] = []
  const ctx = {
    effect: (fn: () => unknown) => {
      fn()
      return () => {}
    },
    webServer: {
      register: (route: SsoRoute) => {
        routes.set(route.path, route)
        return () => { routes.delete(route.path) }
      },
    },
    connection: { requestRejection: () => trust.rejection },
    credentials,
    logger: { warn: (message: unknown) => { warns.push(String(message)) } },
  } as unknown as Context
  Sso.apply(ctx, defaultConfig(config))
  return {
    route: (path) => {
      const route = routes.get(path)
      if (route === undefined) throw new Error(`route ${path} was not registered`)
      return route.handler
    },
    credentials,
    warns,
  }
}

/** One request as node:http presents it to the route. */
function fakeRequest(init: {
  method?: string
  url?: string
  headers?: Record<string, string>
} = {}): unknown {
  const { method = 'GET', url = '/', headers = {} } = init
  return { method, url, headers, resume() {} }
}

/** One response collector; `settled` resolves when the handler ends the response. */
function fakeResponse(): {
  res: unknown
  settled: Promise<void>
  read: () => { status: number; headers: Record<string, string>; body: string }
} {
  const state = { status: 0, headers: {} as Record<string, string>, chunks: [] as string[] }
  let settle = (): void => {}
  const settled = new Promise<void>((resolve) => { settle = resolve })
  const res = {
    set statusCode(value: number) { state.status = value },
    setHeader(name: string, value: string) { state.headers[name] = value },
    end(data?: string) {
      if (data !== undefined) state.chunks.push(data)
      settle()
    },
  }
  return {
    res,
    settled,
    read: () => ({ status: state.status, headers: state.headers, body: state.chunks.join('') }),
  }
}

/** Run one request through one handler and answer the recorded response. */
async function respond(
  handler: SsoRoute['handler'],
  init: Parameters<typeof fakeRequest>[0],
): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  const { res, settled, read } = fakeResponse()
  await handler(fakeRequest(init), res)
  await settled
  return read()
}

/** Run one full mock round trip: authorize, then the callback it names. */
async function mockRoundTrip(
  mounted: ReturnType<typeof mount>,
): Promise<{ authorize: SsoAuthorize; callback: { status: number; headers: Record<string, string>; body: string } }> {
  const authorize = await respond(mounted.route(SSO_AUTHORIZE_PATH), {
    method: 'GET',
    url: SSO_AUTHORIZE_PATH,
    headers: { host: 'app.internal:3080' },
  })
  const payload = JSON.parse(authorize.body) as SsoAuthorize
  const callbackUrl = new URL(payload.authorizeUrl)
  const callback = await respond(mounted.route(SSO_CALLBACK_PATH), {
    method: 'GET',
    url: `${callbackUrl.pathname}${callbackUrl.search}`,
    headers: { host: 'app.internal:3080' },
  })
  return { authorize: payload, callback }
}

/** The grant currently stored by one mounted round trip. */
function storedGrant(): SsoGrant | undefined {
  return parseGrantRecord(stored.records.get('sso/default'))
}

// ---- Unit: grant parsing ----

describe('grant record parsing', () => {
  it('accepts a grant record with the full payload', () => {
    expect(parseGrantRecord({ kind: 'grant', payload: { accessToken: 'a', refreshToken: 'r', expiresAt: 1 } }))
      .toEqual({ accessToken: 'a', refreshToken: 'r', expiresAt: 1 })
  })

  it.each([
    ['no record', undefined],
    ['an api-key record', { kind: 'api-key', key: 'k' }],
    ['a non-object payload', { kind: 'grant', payload: 'x' }],
    ['a null payload', { kind: 'grant', payload: null }],
    ['an empty access token', { kind: 'grant', payload: { accessToken: '', refreshToken: 'r', expiresAt: 1 } }],
    ['a non-string refresh token', { kind: 'grant', payload: { accessToken: 'a', refreshToken: 7, expiresAt: 1 } }],
    ['a non-finite expiry', { kind: 'grant', payload: { accessToken: 'a', refreshToken: 'r', expiresAt: Number.NaN } }],
  ])('rejects %s', (_name, record) => {
    expect(parseGrantRecord(record as never)).toBeUndefined()
  })
})

// ---- Unit: authorize primitives ----

describe('authorize primitives', () => {
  it('derives an S256 challenge from the verifier', () => {
    const { verifier, challenge } = createPkcePair()
    expect(verifier).toMatch(/^[\w-]{43}$/u)
    expect(challenge).toMatch(/^[\w-]{43}$/u)
    expect(challenge).not.toBe(verifier)
  })

  it('creates distinct unguessable states', () => {
    expect(createState()).not.toBe(createState())
    expect(createState()).toMatch(/^[0-9a-f]{32}$/u)
  })

  it('builds the authorize URL with every parameter', () => {
    const url = buildAuthorizeUrl(
      { mode: 'remote', authorizeUrl: 'https://idp.example/authorize', tokenUrl: '', clientId: 'cli', clientSecret: '', scope: 'erp', exchangeTimeoutMs: 1000 },
      { state: 'st', challenge: 'ch', redirectUri: 'http://host/cb' },
    )
    const parsed = new URL(url)
    expect(parsed.origin + parsed.pathname).toBe('https://idp.example/authorize')
    expect(parsed.searchParams.get('response_type')).toBe('code')
    expect(parsed.searchParams.get('client_id')).toBe('cli')
    expect(parsed.searchParams.get('scope')).toBe('erp')
    expect(parsed.searchParams.get('state')).toBe('st')
    expect(parsed.searchParams.get('code_challenge')).toBe('ch')
    expect(parsed.searchParams.get('code_challenge_method')).toBe('S256')
    expect(parsed.searchParams.get('redirect_uri')).toBe('http://host/cb')
  })

  it('omits an empty scope from the authorize URL', () => {
    const url = buildAuthorizeUrl(
      { mode: 'remote', authorizeUrl: 'https://idp.example/authorize', tokenUrl: '', clientId: 'cli', clientSecret: '', scope: '', exchangeTimeoutMs: 1000 },
      { state: 'st', challenge: 'ch', redirectUri: 'http://host/cb' },
    )
    expect(new URL(url).searchParams.has('scope')).toBe(false)
  })

  it('rides inside the fragment when the target is a hash-routed relay page', () => {
    const url = buildAuthorizeUrl(
      { mode: 'remote', authorizeUrl: 'http://127.0.0.1:8090/#/oauth2/', tokenUrl: '', clientId: 'IOT', clientSecret: '', scope: 'read', exchangeTimeoutMs: 1000 },
      { state: 'st', challenge: 'ch', redirectUri: 'http://127.0.0.1:3081/sso/callback' },
    )
    const parsed = new URL(url)
    expect(parsed.search).toBe('')
    expect(parsed.origin + parsed.pathname).toBe('http://127.0.0.1:8090/')
    expect(parsed.hash.startsWith('#/oauth2/?response_type=code&client_id=IOT&scope=read&state=st&')).toBe(true)
    // The relay reads the parameters out of the full href, so the trailing
    // fragment must not be handed to the authorization endpoint as a parameter.
    const forwarded = new URLSearchParams(parsed.href.split('?')[1] ?? '')
    expect(forwarded.get('code_challenge')).toBe('ch')
    expect(forwarded.get('code_challenge_method')).toBe('S256')
    expect(forwarded.get('redirect_uri')).toBe('http://127.0.0.1:3081/sso/callback')
    expect(parsed.href.includes('#/oauth2/')).toBe(true)
  })

  it('keeps a route query already present in the fragment', () => {
    const url = buildAuthorizeUrl(
      { mode: 'remote', authorizeUrl: 'http://idp.example/#/oauth2/?tenant=erp', tokenUrl: '', clientId: 'IOT', clientSecret: '', scope: '', exchangeTimeoutMs: 1000 },
      { state: 'st', challenge: 'ch', redirectUri: 'http://host/cb' },
    )
    const hash = new URL(url).hash
    const route = new URLSearchParams(hash.slice(hash.indexOf('?') + 1))
    expect(route.get('tenant')).toBe('erp')
    expect(route.get('client_id')).toBe('IOT')
    expect(route.has('scope')).toBe(false)
  })
})

// ---- Unit: token requests ----

describe('token requests', () => {
  it('derives deterministic mock tokens for a code exchange', async () => {
    const one = await requestTokens({ mode: 'mock', authorizeUrl: '', tokenUrl: '', clientId: '', clientSecret: '', scope: '', exchangeTimeoutMs: 1000 },
      { code: 'c-1', codeVerifier: 'v-1', redirectUri: 'http://h/cb' })
    const two = await requestTokens({ mode: 'mock', authorizeUrl: '', tokenUrl: '', clientId: '', clientSecret: '', scope: '', exchangeTimeoutMs: 1000 },
      { code: 'c-1', codeVerifier: 'v-1' })
    expect(one.accessToken).toBe(two.accessToken)
    expect(one.refreshToken).toBe(two.refreshToken)
    expect(one.expiresInMs).toBe(3_600_000)
    const other = await requestTokens({ mode: 'mock', authorizeUrl: '', tokenUrl: '', clientId: '', clientSecret: '', scope: '', exchangeTimeoutMs: 1000 },
      { code: 'c-2', codeVerifier: 'v-1' })
    expect(other.accessToken).not.toBe(one.accessToken)
  })

  it('derives deterministic mock tokens for a refresh', async () => {
    const config = { mode: 'mock' as const, authorizeUrl: '', tokenUrl: '', clientId: '', clientSecret: '', scope: '', exchangeTimeoutMs: 1000 }
    const one = await requestTokens(config, { refreshToken: 'r-1' })
    const two = await requestTokens(config, { refreshToken: 'r-1' })
    expect(one).toEqual(two)
    expect(one.refreshToken).not.toBe('r-1')
  })

  it('posts the client secret when the client is confidential', async () => {
    const bodies: string[] = []
    /** Capture the form body of each token request; answer a valid token set. */
    const post = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      bodies.push(typeof init?.body === 'string' ? init.body : '')
      return new Response(JSON.stringify({ access_token: 'a', refresh_token: 'r', expires_in: 60 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    const secret = { mode: 'remote' as const, authorizeUrl: '', tokenUrl: 'https://idp/t', clientId: 'IOT', clientSecret: 'sekret', scope: '', exchangeTimeoutMs: 1000 }
    const publicClient = { mode: 'remote' as const, authorizeUrl: '', tokenUrl: 'https://idp/t', clientId: 'IOT', clientSecret: '', scope: '', exchangeTimeoutMs: 1000 }
    const request = { code: 'c', codeVerifier: 'v', redirectUri: 'http://h/cb' }
    await requestTokens(secret, request, post)
    await requestTokens(publicClient, request, post)
    expect(bodies[0]).toContain('client_secret=sekret')
    expect(bodies[1]).not.toContain('client_secret')
  })
})

// ---- Routes over the fake context ----

describe('single sign-on routes', () => {
  it('rejects remote mode without endpoints or client id', () => {
    const ctx = { effect: () => () => {}, webServer: { register: () => () => {} } } as unknown as Context
    expect((): void => {
      Sso.apply(ctx, defaultConfig({ mode: 'remote' }))
    }).toThrow('requires authorizeUrl and tokenUrl')
    expect((): void => {
      Sso.apply(ctx, defaultConfig({ mode: 'remote', authorizeUrl: 'https://idp/a', tokenUrl: 'https://idp/t' }))
    }).toThrow('requires clientId')
  })

  it('completes the mock round trip: authorize, callback, storage, projection', async () => {
    const mounted = mount()
    const { authorize, callback } = await mockRoundTrip(mounted)

    // Mock authorize names this Host's own callback with a bound state.
    expect(authorize.authorizeUrl).toMatch(/^http:\/\/app\.internal:3080\/sso\/callback\?code=mock-code-/u)
    expect(callback.status).toBe(200)
    expect(callback.headers['content-type']).toContain('text/html')
    expect(callback.body).toContain('Authorization complete')

    const grant = storedGrant()
    expect(grant).toBeDefined()
    expect(grant!.accessToken).toMatch(/^mock-erp-/u)
    expect(grant!.refreshToken).toMatch(/^mock-erp-/u)
    expect(grant!.expiresAt).toBeGreaterThan(Date.now())
    // The access token is projected onto the configured reference.
    expect(mounted.credentials.set).toHaveBeenCalledWith('DSH_ERP_ACCESS_TOKEN', grant!.accessToken)
  })

  it.each([401, 403] as const)('answers the fence rejection %i on the browser routes', async (rejection) => {
    trust.rejection = rejection
    const mounted = mount()
    for (const path of [SSO_AUTHORIZE_PATH, SSO_STATUS_PATH, SSO_LOGOUT_PATH]) {
      const response = await respond(mounted.route(path), { method: 'GET', url: path })
      expect(response.status).toBe(rejection)
    }
    expect(mounted.credentials.set).not.toHaveBeenCalled()
  })

  it('answers 405 for wrong methods on every route', async () => {
    const mounted = mount()
    const post = await respond(mounted.route(SSO_AUTHORIZE_PATH), { method: 'POST', url: SSO_AUTHORIZE_PATH })
    expect(post.status).toBe(405)
    expect(post.headers['allow']).toBe('GET')
    const statusPost = await respond(mounted.route(SSO_STATUS_PATH), { method: 'POST', url: SSO_STATUS_PATH })
    expect(statusPost.status).toBe(405)
    const callbackPost = await respond(mounted.route(SSO_CALLBACK_PATH), { method: 'POST', url: SSO_CALLBACK_PATH })
    expect(callbackPost.status).toBe(405)
    const logoutGet = await respond(mounted.route(SSO_LOGOUT_PATH), { method: 'GET', url: SSO_LOGOUT_PATH })
    expect(logoutGet.status).toBe(405)
    expect(logoutGet.headers['allow']).toBe('POST')
  })

  it('answers 400 when the authorize request carries no Host header', async () => {
    const mounted = mount()
    const response = await respond(mounted.route(SSO_AUTHORIZE_PATH), { method: 'GET', url: SSO_AUTHORIZE_PATH, headers: {} })
    expect(response.status).toBe(400)
    expect(jsonBody(response)['code']).toBe('bad-request')
  })

  it('presents the configured redirect URI instead of the request origin', async () => {
    const mounted = mount({ redirectUri: 'https://app.example.com/sso/callback' })
    const response = await respond(mounted.route(SSO_AUTHORIZE_PATH), {
      method: 'GET',
      url: SSO_AUTHORIZE_PATH,
      headers: { host: 'app.internal:3080' },
    })
    expect(response.status).toBe(200)
    // Mock mode targets the registration itself, so the redirect a provider
    // would follow carries the configured URL rather than the request Host.
    expect((JSON.parse(response.body) as SsoAuthorize).authorizeUrl)
      .toMatch(/^https:\/\/app\.example\.com\/sso\/callback\?code=mock-code-[0-9a-f]{32}&state=[0-9a-f]{32}$/u)
  })

  it('refuses a redirect URI that is not a usable absolute URL', () => {
    const ctx = { effect: () => () => {}, webServer: { register: () => () => {} } } as unknown as Context
    expect((): void => {
      Sso.apply(ctx, defaultConfig({ redirectUri: 'app.example.com/sso/callback' }))
    }).toThrow('is not an absolute URL')
    expect((): void => {
      Sso.apply(ctx, defaultConfig({ redirectUri: 'ftp://app.example.com/cb' }))
    }).toThrow('must use http or https')
    expect((): void => {
      Sso.apply(ctx, defaultConfig({ redirectUri: 'https://app.example.com/cb#frag' }))
    }).toThrow('no credentials and no fragment')
  })

  it('answers 502 when the callback carries an authorization error', async () => {
    const mounted = mount()
    const response = await respond(mounted.route(SSO_CALLBACK_PATH), {
      method: 'GET',
      url: `${SSO_CALLBACK_PATH}?error=access_denied`,
    })
    expect(response.status).toBe(502)
    expect(jsonBody(response)['code']).toBe('authorization-denied')
  })

  it('answers 400 when the callback lacks code or state', async () => {
    const mounted = mount()
    const none = await respond(mounted.route(SSO_CALLBACK_PATH), { method: 'GET', url: SSO_CALLBACK_PATH })
    expect(none.status).toBe(400)
    const codeOnly = await respond(mounted.route(SSO_CALLBACK_PATH), { method: 'GET', url: `${SSO_CALLBACK_PATH}?code=c` })
    expect(codeOnly.status).toBe(400)
  })

  it('answers 400 for an unknown state and consumes a state exactly once', async () => {
    const mounted = mount()
    const unknown = await respond(mounted.route(SSO_CALLBACK_PATH), {
      method: 'GET',
      url: `${SSO_CALLBACK_PATH}?code=c&state=not-issued`,
    })
    expect(unknown.status).toBe(400)
    expect(jsonBody(unknown)['code']).toBe('bad-state')

    // A completed round trip consumes its state; replaying the callback fails.
    await mockRoundTrip(mounted)
    const replay = await respond(mounted.route(SSO_CALLBACK_PATH), {
      method: 'GET',
      url: `${SSO_CALLBACK_PATH}?code=c&state=stale`,
    })
    expect(replay.status).toBe(400)
  })

  it('consumes a pending attempt that a previous Host process minted', async () => {
    const first = mount()
    const authorize = await respond(first.route(SSO_AUTHORIZE_PATH), {
      method: 'GET',
      url: SSO_AUTHORIZE_PATH,
      headers: { host: 'app.internal:3080' },
    })
    const callbackUrl = new URL((JSON.parse(authorize.body) as SsoAuthorize).authorizeUrl)
    // The durable half survives the restart; the process that minted the state
    // does not, so the attempt has to come back out of the store.
    const durable = [...stored.records.entries()]
    const second = mount()
    for (const [key, record] of durable) stored.records.set(key, record)

    const callback = await respond(second.route(SSO_CALLBACK_PATH), {
      method: 'GET',
      url: `${callbackUrl.pathname}${callbackUrl.search}`,
      headers: { host: 'app.internal:3080' },
    })
    expect(callback.status).toBe(200)
    expect(storedGrant()).toBeDefined()

    // Single use still holds across the restart boundary.
    const replay = await respond(second.route(SSO_CALLBACK_PATH), {
      method: 'GET',
      url: `${callbackUrl.pathname}${callbackUrl.search}`,
    })
    expect(replay.status).toBe(400)
    expect(jsonBody(replay)['code']).toBe('bad-state')
    expect(stored.records.has(`sso/default-pending-${new URLSearchParams(callbackUrl.search).get('state') ?? ''}`)).toBe(false)
  })

  it('refuses and removes an attempt whose deadline passed', async () => {
    const mounted = mount()
    const state = 'a'.repeat(32)
    stored.records.set(`sso/default-pending-${state}`, {
      kind: 'grant',
      payload: { verifier: 'v', expiresAt: Date.now() - 1 },
    })
    const callback = await respond(mounted.route(SSO_CALLBACK_PATH), {
      method: 'GET',
      url: `${SSO_CALLBACK_PATH}?code=c&state=${state}`,
    })
    expect(callback.status).toBe(400)
    expect(jsonBody(callback)['code']).toBe('bad-state')
    expect(stored.records.has(`sso/default-pending-${state}`)).toBe(false)
  })

  it('reports unauthenticated status before any round trip and authenticated after', async () => {
    const mounted = mount()
    const before = await respond(mounted.route(SSO_STATUS_PATH), { method: 'GET', url: SSO_STATUS_PATH })
    expect(JSON.parse(before.body)).toEqual({ authenticated: false })

    await mockRoundTrip(mounted)
    const after = await respond(mounted.route(SSO_STATUS_PATH), { method: 'GET', url: SSO_STATUS_PATH })
    const status = JSON.parse(after.body) as SsoStatus
    expect(status.authenticated).toBe(true)
    expect(status.expiresAt).toBe(storedGrant()!.expiresAt)
  })

  it('refreshes the grant inside the expiry skew window and reprojects', async () => {
    const mounted = mount({ expirySkewMs: 3_600_000 })
    await mockRoundTrip(mounted)
    const before = storedGrant()!
    // The mock lifetime is one hour; a skew of one hour always refreshes.
    const response = await respond(mounted.route(SSO_STATUS_PATH), { method: 'GET', url: SSO_STATUS_PATH })
    expect(response.status).toBe(200)
    const after = storedGrant()!
    expect(after.accessToken).not.toBe(before.accessToken)
    expect(mounted.credentials.set).toHaveBeenLastCalledWith('DSH_ERP_ACCESS_TOKEN', after.accessToken)
    expect(jsonBody(response)['authenticated']).toBe(true)
  })

  it('keeps the stored grant when the token endpoint cannot be reached', async () => {
    const mounted = mount({ mode: 'remote', tokenUrl: 'http://127.0.0.1:1/token', authorizeUrl: 'http://127.0.0.1:1/a', clientId: 'cli' })
    // Seed a stored grant whose refresh faces an unreachable endpoint.
    stored.records.set('sso/default', {
      kind: 'grant',
      payload: { accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() - 1 },
    })
    stored.refs.set('DSH_ERP_ACCESS_TOKEN', 'a')
    const response = await respond(mounted.route(SSO_STATUS_PATH), { method: 'GET', url: SSO_STATUS_PATH })
    expect(response.status).toBe(200)
    expect(JSON.parse(response.body)).toEqual({ authenticated: false })
    // A transient failure is not a logout: the renewal root survives, and the
    // next call (status poll, tool call) retries the refresh.
    expect(storedGrant()).toBeDefined()
    expect(mounted.credentials.unset).not.toHaveBeenCalled()
    expect(mounted.warns.some(line => line.includes('could not be completed, keeping the stored grant'))).toBe(true)
  })

  it('withdraws the grant when the token endpoint refuses the refresh grant', async () => {
    const mounted = mount({ mode: 'remote', tokenUrl: 'http://idp.internal/token', authorizeUrl: 'http://idp.internal/a', clientId: 'cli' })
    stored.records.set('sso/default', {
      kind: 'grant',
      payload: { accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() - 1 },
    })
    stored.refs.set('DSH_ERP_ACCESS_TOKEN', 'a')
    // RFC 6749 §5.2 refusal: the endpoint names the error, and no retry fixes it.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'invalid_grant' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    })))
    const response = await respond(mounted.route(SSO_STATUS_PATH), { method: 'GET', url: SSO_STATUS_PATH })
    expect(response.status).toBe(200)
    expect(JSON.parse(response.body)).toEqual({ authenticated: false })
    expect(storedGrant()).toBeUndefined()
    expect(mounted.credentials.unset).toHaveBeenCalledWith('DSH_ERP_ACCESS_TOKEN')
    expect(mounted.warns.some(line => line.includes('token refresh refused, withdrawing the grant'))).toBe(true)
  })

  it('removes the grant and withdraws the projection on logout', async () => {
    const mounted = mount()
    await mockRoundTrip(mounted)
    const response = await respond(mounted.route(SSO_LOGOUT_PATH), { method: 'POST', url: SSO_LOGOUT_PATH })
    expect(response.status).toBe(200)
    expect(JSON.parse(response.body)).toEqual({ authenticated: false })
    expect(storedGrant()).toBeUndefined()
    expect(mounted.credentials.unset).toHaveBeenCalledWith('DSH_ERP_ACCESS_TOKEN')
  })

  it('answers 502 when the callback exchange fails', async () => {
    const mounted = mount({ mode: 'remote', tokenUrl: 'http://127.0.0.1:1/token', authorizeUrl: 'http://127.0.0.1:1/a', clientId: 'cli' })
    const authorize = await respond(mounted.route(SSO_AUTHORIZE_PATH), {
      method: 'GET',
      url: SSO_AUTHORIZE_PATH,
      headers: { host: 'app.internal:3080' },
    })
    const payload = JSON.parse(authorize.body) as SsoAuthorize
    // The identity provider would redirect back carrying code and state.
    const state = new URL(payload.authorizeUrl).searchParams.get('state') ?? ''
    const response = await respond(mounted.route(SSO_CALLBACK_PATH), {
      method: 'GET',
      url: `${SSO_CALLBACK_PATH}?code=remote-code&state=${encodeURIComponent(state)}`,
      headers: { host: 'app.internal:3080' },
    })
    expect(response.status).toBe(502)
    expect(jsonBody(response)['code']).toBe('exchange-failed')
    expect(storedGrant()).toBeUndefined()
  })
})

// ---- Real Loader composition ----

describe('single sign-on (real Loader composition)', () => {
  it('serves the mock round trip through the webServer', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-sso-'))
    try {
      const configPath = join(root, 'cordis.yml')
      await writeFile(configPath, [
        "- name: '@deepseek-ai/dsh-host-webserver'",
        '  config:',
        "    host: '127.0.0.1'",
        '    port: 0',
        "- name: '@deepseek-ai/dsh-host-sso'",
        '',
      ].join('\n'))
      const context = new Context()
      context.provide('connection', { requestRejection: () => trust.rejection })
      const granted = new Map<string, unknown>()
      context.provide('credentials', {
        set: async () => {},
        unset: async () => {},
        readRecord: async (key: string) => granted.get(key),
        modifyRecord: async (key: string, mutate: (current: undefined) => Promise<unknown>) => {
          const next = await mutate(granted.get(key) as never)
          if (next !== undefined) granted.set(key, next)
          return granted.get(key)
        },
        deleteRecord: async () => {},
        listRecords: async () => [],
      })
      await context.plugin(Loader)
      context.loader.builtins.include = Include
      const modules = new Map<string, unknown>([
        ['@deepseek-ai/dsh-host-webserver', WebServer],
        ['@deepseek-ai/dsh-host-sso', Sso],
      ])
      context.loader.internal = {
        version: 'v2',
        async import(specifier: string) {
          if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
          return modules.get(specifier)
        },
      } as unknown as NonNullable<typeof context.loader.internal>
      await context.loader.create({
        name: 'cordis:include',
        config: { path: pathToFileURL(configPath).href },
      })
      await context.loader.await()
      expect([...context.loader.entries()].filter(entry => entry.fiber === undefined && !entry.disabled)).toEqual([])
      const base = `http://127.0.0.1:${String(context.webServer.port)}`

      const authorize = await fetch(`${base}${SSO_AUTHORIZE_PATH}`, { headers: { host: '127.0.0.1' } })
      expect(authorize.status).toBe(200)
      const { authorizeUrl } = await authorize.json() as SsoAuthorize
      expect(authorizeUrl).toContain(SSO_CALLBACK_PATH)

      const callback = await fetch(authorizeUrl, { redirect: 'manual' })
      expect(callback.status).toBe(200)
      await callback.text()

      const status = await fetch(`${base}${SSO_STATUS_PATH}`)
      const state = await status.json() as SsoStatus
      expect(state.authenticated).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
