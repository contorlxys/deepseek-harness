/**
 * Single sign-on surface: one card telling the user where the page is going,
 * or why authorization failed and how to start over.
 */

import type { ReactElement } from 'react'
import { createSsoTranslator, defaultSsoLocale, type SsoLocale } from './locales.ts'
import './sso.css'

/** What the round trip is doing right now. */
export type SsoPhase = 'redirecting' | 'completed' | 'error'

/** Render options for the single sign-on card. */
export interface SsoScreenProps {
  /** Current step of the round trip. */
  readonly phase: SsoPhase
  /** Rendered locale; defaults to the browser preference. */
  readonly locale?: SsoLocale
  /** Authorization server's own explanation, shown verbatim on failure. */
  readonly detail?: string
  /** Invoked when the user asks to start over after a failure. */
  readonly onRetry?: () => void
}

const STATUS_KEY: Record<SsoPhase, 'sso.redirecting' | 'sso.completed' | 'sso.error.generic'> = {
  redirecting: 'sso.redirecting',
  completed: 'sso.completed',
  error: 'sso.error.generic',
}

/**
 * Render the single sign-on card.
 * @param props - phase, locale, and optional failure detail with retry.
 * @returns the card element.
 */
export function SsoScreen(props: SsoScreenProps): ReactElement {
  const t = createSsoTranslator(props.locale ?? defaultSsoLocale())
  return (
    <div className="dsh-sso">
      <div className="dsh-sso__card">
        <h1 className="dsh-sso__title">{t('sso.title')}</h1>
        <p className="dsh-sso__status" role="status">{t(STATUS_KEY[props.phase])}</p>
        {props.phase === 'error' && props.detail !== undefined
          ? <p className="dsh-sso__detail" role="alert">{props.detail}</p>
          : null}
        {props.phase === 'error' && props.onRetry !== undefined
          ? <button className="dsh-sso__retry" onClick={props.onRetry} type="button">{t('sso.retry')}</button>
          : null}
      </div>
    </div>
  )
}
