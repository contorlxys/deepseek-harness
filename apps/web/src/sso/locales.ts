/**
 * Locale-owned copy for the Web single sign-on surface. This is the only file
 * allowed to own the surface's translated text; components reach it through
 * `createSsoTranslator`.
 */

export const SSO_LOCALES = ['zh-CN', 'en'] as const

/** Supported single sign-on locale. */
export type SsoLocale = (typeof SSO_LOCALES)[number]

const ZH_CN = {
  'sso.title': '正在跳转到统一认证',
  'sso.redirecting': '认证页面跳转中…',
  'sso.completed': '授权完成，正在进入…',
  'sso.error.state': 'state 校验失败，请重新发起认证',
  'sso.error.denied': '认证被拒绝或已取消',
  'sso.error.generic': '认证失败，请重新发起认证',
  'sso.retry': '重新认证',
} as const

/** Every copy key the single sign-on surface can render. */
export type SsoCopyKey = keyof typeof ZH_CN

const EN: Record<SsoCopyKey, string> = {
  'sso.title': 'Redirecting to single sign-on',
  'sso.redirecting': 'Opening the authorization page…',
  'sso.completed': 'Authorized, entering…',
  'sso.error.state': 'The state check failed, please start authorization again',
  'sso.error.denied': 'Authorization was denied or cancelled',
  'sso.error.generic': 'Authorization failed, please start it again',
  'sso.retry': 'Authorize again',
}

const DICTIONARIES: Record<SsoLocale, Record<SsoCopyKey, string>> = { 'zh-CN': ZH_CN, en: EN }

/** Translator bound to one locale. */
export type SsoTranslator = (key: SsoCopyKey) => string

/**
 * Build the single sign-on surface's translator.
 * @param locale - target locale.
 * @returns a `t(key)` function.
 */
export function createSsoTranslator(locale: SsoLocale): SsoTranslator {
  return key => DICTIONARIES[locale][key]
}

/**
 * Pick the surface locale from the browser's language preferences.
 * @param languages - ordered language tags, most preferred first.
 * @returns the supported locale matching the preference list.
 */
export function defaultSsoLocale(languages: readonly string[] = browserLanguages()): SsoLocale {
  const preferred = languages[0] ?? ''
  return preferred.startsWith('en') ? 'en' : 'zh-CN'
}

function browserLanguages(): readonly string[] {
  if (typeof navigator === 'undefined') return []
  return navigator.languages
}
