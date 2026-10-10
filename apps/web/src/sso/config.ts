/**
 * Single sign-on configuration owned by the Web frontend.
 *
 * Layers, highest priority first: the gate caller's `config` overrides, the
 * deployment-owned runtime file `dsh-sso.config.json` served beside the page
 * (see `loadSsoConfigFile`), the `globalThis.dshSsoConfig` boot override, the
 * public `DSH_CLIENT_SSO_*` build environment, and the built-in defaults.
 * Build-environment names are read as direct `process.env` member accesses so
 * the bundler can inline them; indirect reads would observe the empty browser
 * `process.env` stub.
 */

/** Deployment choices for the single sign-on gate. */
export interface SsoConfig {
  /** Whether the gate redirects the Web shell through the authorization server. */
  readonly enabled: boolean
  /** Backend origin prefixed to the authorize path; empty keeps same-origin paths. */
  readonly apiBaseUrl: string
  /** Authorization endpoint path. */
  readonly authorizePath: string
  /**
   * OAuth2 client identifier. It is public by design: only the authorization
   * server's secret can exchange the code, and that exchange belongs to the
   * backend, never to this page.
   */
  readonly clientId: string
  /** Requested scope; empty omits the parameter. */
  readonly scope: string
  /** Redirect target receiving the authorization code; empty uses the current document. */
  readonly redirectUri: string
  /** OAuth2 response type; `code` is the only flow this gate implements. */
  readonly responseType: string
  /** Whether the captured authorization code survives a reload of this tab. */
  readonly persistCode: boolean
}

/** Runtime configuration file served beside index.html; edit without rebuilding. */
export const SSO_CONFIG_FILE = 'dsh-sso.config.json'

/** Boot-time override surface, set before module evaluation by the deployer. */
interface SsoConfigGlobal {
  dshSsoConfig?: Partial<SsoConfig>
}

/** One configuration layer whose members may be absent. */
interface SsoConfigOverrides {
  readonly apiBaseUrl?: string | undefined
  readonly authorizePath?: string | undefined
  readonly clientId?: string | undefined
  readonly enabled?: boolean | undefined
  readonly persistCode?: boolean | undefined
  readonly redirectUri?: string | undefined
  readonly responseType?: string | undefined
  readonly scope?: string | undefined
}

const DEFAULT_SSO_CONFIG: SsoConfig = {
  enabled: false,
  apiBaseUrl: '',
  authorizePath: '/oauth2/authorize',
  clientId: '',
  scope: '',
  redirectUri: '',
  responseType: 'code',
  persistCode: true,
}

/**
 * Keep only the known keys with the right types from one untrusted source.
 * @param value - decoded JSON of a runtime source (config file or boot override).
 * @returns the recognized subset; unrecognized or mistyped keys are ignored.
 */
export function sanitizeSsoConfig(value: unknown): Partial<SsoConfig> {
  if (typeof value !== 'object' || value === null) return {}
  const record = value as Record<string, unknown>
  const enabled = record['enabled']
  const apiBaseUrl = record['apiBaseUrl']
  const authorizePath = record['authorizePath']
  const clientId = record['clientId']
  const scope = record['scope']
  const redirectUri = record['redirectUri']
  const responseType = record['responseType']
  const persistCode = record['persistCode']
  return {
    ...(typeof enabled === 'boolean' ? { enabled } : {}),
    ...(typeof apiBaseUrl === 'string' ? { apiBaseUrl } : {}),
    ...(typeof authorizePath === 'string' ? { authorizePath } : {}),
    ...(typeof clientId === 'string' ? { clientId } : {}),
    ...(typeof scope === 'string' ? { scope } : {}),
    ...(typeof redirectUri === 'string' ? { redirectUri } : {}),
    ...(typeof responseType === 'string' ? { responseType } : {}),
    ...(typeof persistCode === 'boolean' ? { persistCode } : {}),
  }
}

function environmentConfig(): SsoConfigOverrides {
  const flag = (raw: string | undefined): boolean | undefined =>
    raw === 'true' || raw === '1' ? true : raw === 'false' || raw === '0' ? false : undefined
  return {
    enabled: flag(process.env.DSH_CLIENT_SSO_ENABLED),
    apiBaseUrl: process.env.DSH_CLIENT_SSO_API_BASE_URL,
    authorizePath: process.env.DSH_CLIENT_SSO_AUTHORIZE_PATH,
    clientId: process.env.DSH_CLIENT_SSO_CLIENT_ID,
    scope: process.env.DSH_CLIENT_SSO_SCOPE,
    redirectUri: process.env.DSH_CLIENT_SSO_REDIRECT_URI,
    responseType: process.env.DSH_CLIENT_SSO_RESPONSE_TYPE,
    persistCode: flag(process.env.DSH_CLIENT_SSO_PERSIST_CODE),
  }
}

/**
 * Resolve the configuration from the boot override, the public build
 * environment, and the built-in defaults.
 * @returns the complete configuration before runtime-file and caller overrides.
 */
export function resolveSsoConfig(): SsoConfig {
  const env = environmentConfig()
  const override = sanitizeSsoConfig((globalThis as SsoConfigGlobal).dshSsoConfig)
  return {
    enabled: override.enabled ?? env.enabled ?? DEFAULT_SSO_CONFIG.enabled,
    apiBaseUrl: override.apiBaseUrl ?? env.apiBaseUrl ?? DEFAULT_SSO_CONFIG.apiBaseUrl,
    authorizePath: override.authorizePath ?? env.authorizePath ?? DEFAULT_SSO_CONFIG.authorizePath,
    clientId: override.clientId ?? env.clientId ?? DEFAULT_SSO_CONFIG.clientId,
    scope: override.scope ?? env.scope ?? DEFAULT_SSO_CONFIG.scope,
    redirectUri: override.redirectUri ?? env.redirectUri ?? DEFAULT_SSO_CONFIG.redirectUri,
    responseType: override.responseType ?? env.responseType ?? DEFAULT_SSO_CONFIG.responseType,
    persistCode: override.persistCode ?? env.persistCode ?? DEFAULT_SSO_CONFIG.persistCode,
  }
}

/**
 * Fetch the deployment's runtime configuration file.
 * @param url - file URL; defaults to `dsh-sso.config.json` beside the page.
 * @returns the recognized subset, or undefined when the file is absent, unreachable, or not JSON.
 */
export async function loadSsoConfigFile(url?: string): Promise<Partial<SsoConfig> | undefined> {
  const target = url ?? (typeof document === 'undefined'
    ? SSO_CONFIG_FILE
    : new URL(SSO_CONFIG_FILE, document.baseURI).href)
  try {
    const response = await fetch(target, { cache: 'no-store' })
    if (!response.ok) return undefined
    return sanitizeSsoConfig(await response.json())
  } catch {
    // No runtime config file in this deployment: the build environment stays
    // authoritative and the fetch failure must not block the shell.
    return undefined
  }
}
