/** Single sign-on settings section: the live state, the token's expiry, and the actions the state allows. */
import { useCallback, useEffect, useState } from 'react'
import { SSO_LOGOUT_ROUTE } from '@deepseek-ai/dsh-host-sso/shared'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { beginSsoSignIn, readSsoStatus } from './wire.ts'
import css from './SsoSection.module.css'

/** Props assembled by the settings renderer: the section's owner share plus this namespace. */
export type SsoSectionProps = PropsRuntime<'settings.section'> & PropsLocale<'sso'>

/** One live authorization state. */
type SsoSectionPhase = 'checking' | 'signed-in' | 'signed-out' | 'error'

/**
 * Render the single sign-on section: whether the Host holds a grant, when its
 * access token expires, and the one action that state allows — signing in
 * through the Host's PKCE round trip, or dropping the grant.
 * @param props - composed slot props; the settings shell owns the frame.
 * @returns the section element tree.
 */
export function SsoSection({ t }: SsoSectionProps) {
  const [phase, setPhase] = useState<SsoSectionPhase>('checking')
  const [expiresAt, setExpiresAt] = useState<number | undefined>(undefined)
  const [busy, setBusy] = useState(false)

  const read = useCallback(async (): Promise<void> => {
    try {
      const status = await readSsoStatus()
      setExpiresAt(status.expiresAt)
      setPhase(status.authenticated ? 'signed-in' : 'signed-out')
    } catch {
      setPhase('error')
    }
  }, [])

  useEffect(() => {
    void read()
  }, [read])

  /**
   * Drop the stored grant. The Host removes the record and withdraws the
   * projected token, which is what makes consumers lose their authorization
   * on the next request; a gateway-side revocation is the identity provider's
   * own concern and out of scope here.
   */
  const signOut = async (): Promise<void> => {
    setBusy(true)
    try {
      const response = await fetch(SSO_LOGOUT_ROUTE, { method: 'POST' })
      if (!response.ok) throw new Error(`sso: logout answered HTTP ${String(response.status)}`)
      await read()
    } catch {
      setPhase('error')
    } finally {
      setBusy(false)
    }
  }

  /** Start the Host's PKCE round trip; the browser navigates and comes back to the completion page. */
  const signIn = async (): Promise<void> => {
    setBusy(true)
    try {
      await beginSsoSignIn()
    } catch {
      setPhase('error')
    } finally {
      setBusy(false)
    }
  }

  const state = phase === 'signed-in'
    ? `${t('signedIn')}${expiresAt === undefined ? '' : ` · ${t('expiresAt')} ${new Date(expiresAt).toLocaleString()}`}`
    : phase === 'signed-out'
      ? t('signedOut')
      : phase === 'error' ? t('error') : t('checking')

  // One action per state, chosen here so the render tree stays a flat pair.
  const action = phase === 'signed-in'
    ? <Button variant="outline" disabled={busy} onClick={() => { void signOut() }}>{t('signOut')}</Button>
    : <Button variant="primary" disabled={busy || phase === 'checking'} onClick={() => { void signIn() }}>{t('action')}</Button>

  return (
    <div className={css.section}>
      <div className={css.card}>
        <div className={css.text}>
          <div className={css.title}>{t('sectionTitle')}</div>
          <div className={css.state}>{state}</div>
        </div>
        <div className={css.actions}>{action}</div>
      </div>
    </div>
  )
}
