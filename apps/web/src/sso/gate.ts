/**
 * Single sign-on gate for the Web shell: send the page to the authorization
 * server, take the authorization code back, then hand the page to the shell.
 *
 * React and the card are loaded lazily so a disabled gate adds no bundle
 * weight to the ordinary page. The gate stops at the code: exchanging it needs
 * the client secret, which belongs to the backend, not to this page.
 */

import { createElement } from 'react'
import { loadSsoConfigFile, resolveSsoConfig, type SsoConfig } from './config.ts'
import {
  buildAuthorizeUrl,
  createSsoState,
  defaultRedirectUri,
  readSsoCallback,
  withoutCallbackParams,
  type SsoAuthorizationCode,
} from './flow.ts'
import { createSsoTranslator, defaultSsoLocale, type SsoLocale } from './locales.ts'
import { SsoScreen, type SsoPhase } from './SsoScreen.tsx'
import {
  createSsoCodeStore,
  createSsoStateStore,
  type SsoCodeStore,
  type SsoStateStore,
} from './storage.ts'

/** Boot options for the single sign-on gate. */
export interface SsoGateOptions {
  /** Element mounting the card; usually the shell's own root. */
  readonly container: HTMLElement
  /** Build-environment overrides, applied on top of the resolved configuration. */
  readonly config?: Partial<SsoConfig>
  /** Runtime configuration file URL; defaults to `dsh-sso.config.json` beside the page, null skips the lookup. */
  readonly configFile?: string | null
  /** Rendered locale of the card. */
  readonly locale?: SsoLocale
  /** Query string to read the callback from; defaults to the current document's. */
  readonly search?: string
  /** Absolute URL to strip callback parameters from; defaults to the current document's. */
  readonly href?: string
  /** Redirect target override; defaults to the configured one, then the current document. */
  readonly redirectUri?: string
  /** Navigation sink; defaults to assigning `window.location`. */
  readonly navigate?: (url: string) => void
  /** URL replacement sink; defaults to `history.replaceState`. */
  readonly replaceUrl?: (url: string) => void
  /** Pending-state store override. */
  readonly stateStore?: SsoStateStore
  /** Captured-code store override. */
  readonly codeStore?: SsoCodeStore
  /** Called with the authorization code once the shell may start. */
  readonly onAuthorized?: (code: SsoAuthorizationCode) => void
}

/**
 * Gate the shell behind authorization.
 *
 * @param options - container, overrides, and lifecycle callbacks.
 * @returns the authorization code; undefined means the gate is disabled and
 *   the caller must start the shell itself. The promise never settles when the
 *   gate redirects, because the browser leaves the document instead.
 */
export async function runSsoGate(options: SsoGateOptions): Promise<SsoAuthorizationCode | undefined> {
  const fileConfig = options.configFile === null
    ? undefined
    : await loadSsoConfigFile(options.configFile ?? undefined)
  const config: SsoConfig = { ...resolveSsoConfig(), ...fileConfig, ...options.config }
  if (!config.enabled) return undefined

  const stateStore = options.stateStore ?? createSsoStateStore()
  const codeStore = options.codeStore ?? createSsoCodeStore(config.persistCode ? {} : { storage: null })
  const stored = codeStore.read()
  if (stored !== undefined) {
    options.onAuthorized?.(stored)
    return stored
  }

  const screen = await mount({
    container: options.container,
    ...(options.locale === undefined ? {} : { locale: options.locale }),
  })
  const finish = (code: SsoAuthorizationCode): SsoAuthorizationCode => {
    screen.unmount()
    options.onAuthorized?.(code)
    return code
  }

  const callback = readSsoCallback(options.search ?? currentSearch())
  if (callback !== undefined && callback.kind === 'error') {
    screen.show('error', callback.description ?? callback.error)
    await screen.waitForRetry()
  } else if (callback !== undefined) {
    const expected = stateStore.consume()
    if (expected !== undefined && expected === callback.state) {
      const code: SsoAuthorizationCode = { code: callback.code, state: callback.state }
      codeStore.write(code)
      replaceUrl(options.replaceUrl, options.href ?? currentHref())
      return finish(code)
    }
    const translate = createSsoTranslator(options.locale ?? defaultSsoLocale())
    screen.show('error', translate('sso.error.state'))
    await screen.waitForRetry()
  }

  const state = createSsoState()
  stateStore.save(state)
  redirect(options.navigate, buildAuthorizeUrl(config, {
    state,
    redirectUri: config.redirectUri !== '' ? config.redirectUri : options.redirectUri ?? defaultRedirectUri(),
  }))
  // The browser is leaving this document; the gate never hands the page over.
  return new Promise<SsoAuthorizationCode>(() => undefined)
}

interface MountOptions {
  readonly container: HTMLElement
  readonly locale?: SsoLocale | undefined
}

/** Live handle on the mounted card. */
interface SsoScreenHandle {
  show(phase: SsoPhase, detail?: string): void
  waitForRetry(): Promise<void>
  unmount(): void
}

/** Render the card into a child element of the shell's root. */
async function mount(options: MountOptions): Promise<SsoScreenHandle> {
  const { createRoot } = await import('react-dom/client')
  const host = document.createElement('div')
  options.container.append(host)
  const root = createRoot(host)
  let notifyRetry: (() => void) | undefined
  const retry = new Promise<void>((resolve) => { notifyRetry = resolve })
  let view: { phase: SsoPhase; detail?: string } = { phase: 'redirecting' }
  const draw = (): void => {
    root.render(createElement(SsoScreen, {
      phase: view.phase,
      ...(view.detail === undefined ? {} : { detail: view.detail }),
      ...(options.locale === undefined ? {} : { locale: options.locale }),
      onRetry: () => { notifyRetry?.() },
    }))
  }
  draw()
  return {
    show(phase, detail) {
      view = detail === undefined ? { phase } : { phase, detail }
      draw()
    },
    waitForRetry: () => retry,
    unmount() {
      root.unmount()
      host.remove()
    },
  }
}

function currentSearch(): string {
  return typeof window === 'undefined' ? '' : window.location.search
}

function currentHref(): string {
  return typeof window === 'undefined' ? 'https://localhost/' : window.location.href
}

function redirect(navigate: ((url: string) => void) | undefined, url: string): void {
  if (navigate !== undefined) {
    navigate(url)
    return
  }
  window.location.assign(url)
}

function replaceUrl(sink: ((url: string) => void) | undefined, href: string): void {
  const cleaned = withoutCallbackParams(href)
  if (sink !== undefined) {
    sink(cleaned)
    return
  }
  history.replaceState(null, '', cleaned)
}
