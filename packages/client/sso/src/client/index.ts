/**
 * Single sign-on, browser half: a frame-wide `shell.overlay` notice that the
 * Host holds no authorization grant. The notice's action starts the Host's
 * PKCE round trip (`GET /sso/authorize` answers a URL; the browser only
 * navigates); the component polls the Host's status and withdraws itself once
 * the grant exists.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: the `shell.overlay` slot this entry registers into, declared by
// ui-layout, and the locale service the dictionaries register through.
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the settings shell's SlotMap merge (the 'settings.section' entry).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { SsoNotice } from './SsoNotice.tsx'
import { SsoSection } from './SsoSection.tsx'
import { en, zh, type SsoLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Single sign-on notice copy. */
    'sso': SsoLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'sso'

/** Services required by the overlay registration and the locale dictionaries. */
export const inject = ['slots', 'locale']

/**
 * Contribute the sign-in notice to the frame-wide overlay under this plugin's
 * own id, replacing no one, and one settings section where the signed-in state
 * can be inspected and dropped.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'client-sso: dictionaries')
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'sso.notice',
    locale: NS,
  }, SsoNotice))
  // Ordered last: sign-in state is an account-level concern, and the settings
  // nav reads top-down from routine choices to deployment-shaped ones.
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'sso',
    order: 30,
    label: () => ctx.locale.bind(NS)('sectionTitle'),
    locale: NS,
  }, SsoSection))
}

export type { SsoNoticeProps } from './SsoNotice.tsx'
export type { SsoLocaleKey } from './locales.ts'
// Re-exported so the `ctx.slots` Context augmentation (declared by the renderer)
// is loaded whenever this module's types are imported.
export type { SlotRegistry }
