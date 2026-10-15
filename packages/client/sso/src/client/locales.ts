/** Single sign-on copy: the frame-wide sign-in notice and the settings section. */

/** Simplified Chinese dictionary and key source of truth. */
export const zh = {
  notice: '单点登录未完成，网关能力不可用',
  action: '去认证',
  retry: '重试',
  error: '无法读取登录状态',
  sectionTitle: '单点登录',
  signedIn: '已登录',
  signedOut: '未登录',
  expiresAt: '到期',
  checking: '检查中…',
  signOut: '退出登录',
} as const

/** English dictionary. */
export const en = {
  notice: 'Single sign-on is not complete; gateway capability is unavailable',
  action: 'Sign in',
  retry: 'Retry',
  error: 'The sign-in state could not be read',
  sectionTitle: 'Single sign-on',
  signedIn: 'Signed in',
  signedOut: 'Not signed in',
  expiresAt: 'expires',
  checking: 'Checking…',
  signOut: 'Sign out',
} as const

/** Dictionary keys of this plugin's locale namespace. */
export type SsoLocaleKey = keyof typeof zh
