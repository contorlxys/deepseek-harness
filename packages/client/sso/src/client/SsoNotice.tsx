/** Frame-wide sign-in notice hosted in `shell.overlay`. */
import { useEffect, useState, type ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { beginSsoSignIn, readSsoStatus } from './wire.ts'
import styles from './SsoNotice.module.css'

/** Render inputs: the locale seat the slot injects. */
export type SsoNoticeProps = PropsLocale<'sso'>

/** Status polling cadence; the freshness bound the Host documents for its refresh. */
const POLL_INTERVAL_MS = 30_000

/** One live authorization state. */
type SsoPhase = 'checking' | 'signed-in' | 'signed-out' | 'error'

/**
 * Poll the Host's authorization state and, while signed out, hold a frame-wide
 * notice whose action starts the PKCE round trip. The Host's completion page
 * returns the browser here; the next poll observes the grant.
 * @param props - the locale seat the slot injects.
 * @returns the notice, or null while signed in or still checking.
 */
export function SsoNotice({ t }: SsoNoticeProps): ReactNode {
  const [phase, setPhase] = useState<SsoPhase>('checking')

  useEffect(() => {
    // One bag for the loop's lifecycle facts: the poll reads both on every pass
    // and the cleanup writes the same object the loop closes over.
    const live: { stopped: boolean; timer: ReturnType<typeof setTimeout> | undefined } = {
      stopped: false,
      timer: undefined,
    }
    const poll = async (): Promise<void> => {
      try {
        const status = await readSsoStatus()
        if (live.stopped) return
        setPhase(status.authenticated ? 'signed-in' : 'signed-out')
      } catch {
        if (live.stopped) return
        setPhase('error')
      }
      // Both branches above return when the effect is cancelled.
      live.timer = setTimeout(() => { void poll() }, POLL_INTERVAL_MS)
    }
    void poll()
    return () => {
      live.stopped = true
      if (live.timer !== undefined) clearTimeout(live.timer)
    }
  }, [])

  if (phase === 'signed-in' || phase === 'checking') return null
  return (
    <div className={styles.notice} role="status">
      <span className={styles.text}>{phase === 'error' ? t('error') : t('notice')}</span>
      {phase === 'error'
        ? <Button variant="outline" onClick={() => { setPhase('checking') }}>{t('retry')}</Button>
        : <Button variant="primary" onClick={() => { void beginSsoSignIn() }}>{t('action')}</Button>}
    </div>
  )
}
