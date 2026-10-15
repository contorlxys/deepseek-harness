/** Single sign-on notice copy. */

/** Simplified Chinese dictionary and key source of truth. */
export const zh = {
  notice: '单点登录未完成，网关能力不可用',
  action: '去认证',
  retry: '重试',
  error: '无法读取登录状态',
} as const

/** English dictionary. */
export const en = {
  notice: 'Single sign-on is not complete; gateway capability is unavailable',
  action: 'Sign in',
  retry: 'Retry',
  error: 'The sign-in state could not be read',
} as const

/** Dictionary keys of this plugin's locale namespace. */
export type SsoLocaleKey = keyof typeof zh
