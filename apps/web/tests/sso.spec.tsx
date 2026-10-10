// @vitest-environment jsdom
/**
 * Single sign-on surface coverage: the authorization URL, the callback read,
 * the round-trip storage, and the gate's user-visible behavior.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { loadSsoConfigFile, resolveSsoConfig, sanitizeSsoConfig, type SsoConfig } from '../src/sso/config.ts'
import {
  buildAuthorizeUrl,
  createSsoState,
  defaultRedirectUri,
  joinUrl,
  readSsoCallback,
  withoutCallbackParams,
} from '../src/sso/flow.ts'
import { createSsoTranslator } from '../src/sso/locales.ts'
import { runSsoGate } from '../src/sso/gate.ts'
import { SsoScreen } from '../src/sso/SsoScreen.tsx'
import { createSsoCodeStore, createSsoStateStore, type SsoStorage } from '../src/sso/storage.ts'

class MemoryStorage implements SsoStorage {
  readonly entries = new Map<string, string>()

  getItem(key: string): string | null {
    return this.entries.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.entries.set(key, value)
  }

  removeItem(key: string): void {
    this.entries.delete(key)
  }
}

const CONFIG: SsoConfig = {
  enabled: true,
  apiBaseUrl: 'http://127.0.0.1:9005',
  authorizePath: '/oauth2/authorize',
  clientId: 'IOT',
  scope: 'read',
  redirectUri: '',
  responseType: 'code',
  persistCode: true,
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' }, status })
}

afterEach(() => {
  cleanup()
})

describe('authorization flow', () => {
  it('builds the authorization URL with the state and the redirect target', () => {
    const url = buildAuthorizeUrl(CONFIG, { state: 'st-1', redirectUri: 'http://app.test/' })

    expect(url).toBe(
      'http://127.0.0.1:9005/oauth2/authorize?client_id=IOT&response_type=code'
      + '&redirect_uri=http%3A%2F%2Fapp.test%2F&state=st-1&scope=read',
    )
  })

  it('omits the scope when the deployment requests none', () => {
    const url = buildAuthorizeUrl({ ...CONFIG, scope: '' }, { state: 'st-1', redirectUri: 'http://app.test/' })

    expect(url).not.toContain('scope=')
  })

  it('reads the code and its state off the callback URL', () => {
    expect(readSsoCallback('?code=c-1&state=st-1')).toEqual({ kind: 'code', code: 'c-1', state: 'st-1' })
  })

  it('reads a refused authorization as an error', () => {
    expect(readSsoCallback('?error=access_denied&error_description=no+consent')).toEqual({
      description: 'no consent',
      error: 'access_denied',
      kind: 'error',
    })
  })

  it('ignores an error without a description', () => {
    expect(readSsoCallback('?error=access_denied')).toEqual({ error: 'access_denied', kind: 'error' })
  })

  it('finds nothing on a URL without a callback', () => {
    expect(readSsoCallback('')).toBeUndefined()
    expect(readSsoCallback('?foo=bar')).toBeUndefined()
    expect(readSsoCallback('?code=')).toBeUndefined()
  })

  it('strips the callback parameters so a reload cannot replay a code', () => {
    expect(withoutCallbackParams('https://app.test/?code=c-1&state=st-1&keep=1#top')).toBe('/?keep=1#top')
  })

  it('derives the redirect target from the current document', () => {
    expect(defaultRedirectUri({ origin: 'http://app.test', pathname: '/' })).toBe('http://app.test/')
  })

  it('makes an opaque state value from random bytes', () => {
    const state = createSsoState(length => new Uint8Array(length).fill(7))

    expect(state).toBe('07'.repeat(16))
  })

  it('keeps same-origin paths when no backend origin is configured', () => {
    expect(joinUrl('', '/oauth2/authorize')).toBe('/oauth2/authorize')
  })
})

describe('round-trip storage', () => {
  it('consumes the pending state once', () => {
    const store = createSsoStateStore({ storage: null })
    store.save('st-1')

    expect(store.consume()).toBe('st-1')
    expect(store.consume()).toBeUndefined()
  })

  it('reloads the captured code from the same storage', () => {
    const storage = new MemoryStorage()
    createSsoCodeStore({ storage }).write({ code: 'c-1', state: 'st-1' })

    expect(createSsoCodeStore({ storage }).read()).toEqual({ code: 'c-1', state: 'st-1' })
  })

  it('drops the captured code on request', () => {
    const store = createSsoCodeStore({ storage: null })
    store.write({ code: 'c-1', state: 'st-1' })
    store.clear()

    expect(store.read()).toBeUndefined()
  })

  it('ignores a corrupt record instead of failing to boot', () => {
    const storage = new MemoryStorage()
    storage.setItem('dsh.sso.code', '{not json')

    expect(createSsoCodeStore({ storage }).read()).toBeUndefined()
  })
})

describe('single sign-on card', () => {
  const t = createSsoTranslator('zh-CN')

  it('tells the user the page is going to the authorization server', () => {
    render(<SsoScreen locale="zh-CN" phase="redirecting" />)

    expect(screen.getByRole('status')).toHaveProperty('textContent', t('sso.redirecting'))
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('shows the authorization server copy verbatim and offers a retry', () => {
    const onRetry = vi.fn()
    render(<SsoScreen detail="no consent" locale="zh-CN" phase="error" onRetry={onRetry} />)

    expect(screen.getByRole('alert')).toHaveProperty('textContent', 'no consent')
    fireEvent.click(screen.getByRole('button', { name: t('sso.retry') }))

    expect(onRetry).toHaveBeenCalledOnce()
  })
})

describe('single sign-on gate', () => {
  it('stays out of the page when disabled', async () => {
    const container = document.createElement('div')

    await expect(runSsoGate({
      config: { enabled: false },
      configFile: null,
      container,
      onAuthorized: vi.fn(),
    })).resolves.toBeUndefined()

    expect(container.childElementCount).toBe(0)
  })

  it('skips the round trip for a code captured earlier in this tab', async () => {
    const codeStore = createSsoCodeStore({ storage: null })
    codeStore.write({ code: 'c-1', state: 'st-1' })
    const onAuthorized = vi.fn()

    await expect(runSsoGate({
      config: CONFIG,
      configFile: null,
      container: document.createElement('div'),
      codeStore,
      onAuthorized,
      stateStore: createSsoStateStore({ storage: null }),
    })).resolves.toEqual({ code: 'c-1', state: 'st-1' })

    expect(onAuthorized).toHaveBeenCalledWith({ code: 'c-1', state: 'st-1' })
  })

  it('captures the returned code, clears the URL, and hands the page over', async () => {
    const stateStore = createSsoStateStore({ storage: null })
    stateStore.save('st-1')
    const codeStore = createSsoCodeStore({ storage: null })
    const replaceUrl = vi.fn()
    const onAuthorized = vi.fn()
    const container = document.createElement('div')

    const code = await runSsoGate({
      codeStore,
      config: CONFIG,
      configFile: null,
      container,
      href: 'https://app.test/?code=c-1&state=st-1',
      onAuthorized,
      replaceUrl,
      search: '?code=c-1&state=st-1',
      stateStore,
    })

    expect(code).toEqual({ code: 'c-1', state: 'st-1' })
    expect(codeStore.read()).toEqual({ code: 'c-1', state: 'st-1' })
    expect(replaceUrl).toHaveBeenCalledWith('/')
    expect(onAuthorized).toHaveBeenCalledWith({ code: 'c-1', state: 'st-1' })
    expect(container.childElementCount).toBe(0)
  })

  it('refuses a code whose state does not match and starts over on retry', async () => {
    const stateStore = createSsoStateStore({ storage: null })
    stateStore.save('st-expected')
    const navigate = vi.fn()
    const container = document.createElement('div')
    document.body.append(container)
    const t = createSsoTranslator('zh-CN')

    const pending = runSsoGate({
      config: CONFIG,
      configFile: null,
      container,
      locale: 'zh-CN',
      navigate,
      redirectUri: 'http://app.test/',
      search: '?code=c-1&state=st-other',
      stateStore,
    })

    await waitFor(() => { expect(screen.getByRole('alert')).toHaveProperty('textContent', t('sso.error.state')) })
    fireEvent.click(screen.getByRole('button', { name: t('sso.retry') }))

    await waitFor(() => { expect(navigate).toHaveBeenCalledOnce() })
    expect(String(navigate.mock.calls[0]?.[0])).toContain('state=')
    void pending
  })

  it('sends the browser to the authorization URL and never settles', async () => {
    const navigate = vi.fn()
    const stateStore = createSsoStateStore({ storage: null })
    const container = document.createElement('div')

    const pending = runSsoGate({
      config: CONFIG,
      configFile: null,
      container,
      navigate,
      redirectUri: 'http://app.test/',
      search: '',
      stateStore,
    })

    await waitFor(() => { expect(navigate).toHaveBeenCalledOnce() })
    const state = stateStore.consume()
    expect(state).toMatch(/^[\da-f]{32}$/u)
    expect(navigate).toHaveBeenCalledWith(
      buildAuthorizeUrl(CONFIG, { redirectUri: 'http://app.test/', state: state ?? '' }),
    )
    // The browser is leaving this document, so the gate keeps the page.
    await expect(Promise.race([pending.then(() => 'settled'), Promise.resolve('pending')])).resolves.toBe('pending')
  })
})

describe('single sign-on configuration', () => {
  it('reads the public build environment through direct member access', () => {
    const savedEnabled = process.env['DSH_CLIENT_SSO_ENABLED']
    const savedClientId = process.env['DSH_CLIENT_SSO_CLIENT_ID']
    process.env['DSH_CLIENT_SSO_ENABLED'] = 'true'
    process.env['DSH_CLIENT_SSO_CLIENT_ID'] = 'IOT'
    try {
      const config = resolveSsoConfig()
      expect(config.enabled).toBe(true)
      expect(config.clientId).toBe('IOT')
      expect(config.authorizePath).toBe('/oauth2/authorize')
      expect(config.responseType).toBe('code')
    } finally {
      process.env['DSH_CLIENT_SSO_ENABLED'] = savedEnabled
      process.env['DSH_CLIENT_SSO_CLIENT_ID'] = savedClientId
    }
  })

  it('keeps only known, well-typed keys from a runtime source', () => {
    expect(sanitizeSsoConfig({
      apiBaseUrl: 'http://127.0.0.1:9005',
      clientId: 3,
      enabled: 'yes',
      unknown: true,
    })).toEqual({ apiBaseUrl: 'http://127.0.0.1:9005' })
  })

  it('loads the runtime configuration file when the deployment ships one', async () => {
    const fetchStub = vi.fn(async () => json({ apiBaseUrl: 'http://127.0.0.1:9005', enabled: true, nonsense: 'ignored' }))
    vi.stubGlobal('fetch', fetchStub)
    try {
      await expect(loadSsoConfigFile('https://page.test/dsh-sso.config.json')).resolves.toEqual({
        apiBaseUrl: 'http://127.0.0.1:9005',
        enabled: true,
      })
      expect(fetchStub).toHaveBeenCalledWith('https://page.test/dsh-sso.config.json', { cache: 'no-store' })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('ignores a missing runtime configuration file', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ message: 'not found' }, 404)))
    try {
      await expect(loadSsoConfigFile('https://page.test/dsh-sso.config.json')).resolves.toBeUndefined()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
