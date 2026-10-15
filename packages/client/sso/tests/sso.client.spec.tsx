// @vitest-environment jsdom
/** SsoNotice component: poll-driven sign-in prompt and its action. */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { SsoNotice } from '../src/client/SsoNotice.tsx'
import { SsoSection } from '../src/client/SsoSection.tsx'
import { en, zh } from '../src/client/locales.ts'
// Side-effect type import: the locale namespace this notice's props derive from.
import type {} from '../src/client/index.ts'

/** The framework-injected translate seat, resolved through the declared namespace. */
type SsoTranslate = PropsLocale<'sso'>['t']

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

/** Dictionary lookup standing in for the framework's locale seat. */
function translate(dictionary: Readonly<Record<string, string>>): SsoTranslate {
  return key => dictionary[key] ?? key
}

/** Mount the notice with the stubbed locale seat. */
function mount(): void {
  render(<SsoNotice t={translate(en)} />)
}

describe('SsoNotice', () => {
  it('prompts sign-in when the Host reports signed-out', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ authenticated: false }), { status: 200 })))
    await act(async () => { mount() })
    await waitFor(() => { expect(screen.queryByText(en.notice)).not.toBeNull() })
    expect(screen.queryByText(en.action)).not.toBeNull()
  })

  it('renders nothing while signed in', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ authenticated: true, expiresAt: Date.now() + 3600_000 }), { status: 200 })))
    await act(async () => { mount() })
    await waitFor(() => { expect(screen.queryByText(en.notice)).toBeNull() })
  })

  it('renders the error copy when the status query fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network') }))
    await act(async () => { mount() })
    await waitFor(() => { expect(screen.queryByText(en.error)).not.toBeNull() })
  })

  it('starts the round trip when the action is pressed', async () => {
    const authorizeUrl = 'https://idp.example/authorize?code=abc&state=xyz'
    let calls = 0
    const requested: string[] = []
    // Both calls the component makes address the Host with a path string.
    const fetchMock = vi.fn(async (input: string) => {
      requested.push(input)
      calls += 1
      // The status poll comes first (signed-out); the action's authorize call follows.
      if (calls === 1) return new Response(JSON.stringify({ authenticated: false }), { status: 200 })
      return new Response(JSON.stringify({ authorizeUrl }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const assign = vi.fn()
    Object.defineProperty(window, 'location', { configurable: true, writable: true, value: { assign } })
    await act(async () => { mount() })
    await waitFor(() => { expect(screen.queryByText(en.action)).not.toBeNull() })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.action })) })
    await waitFor(() => {
      expect(requested.some(url => url.endsWith('/sso/authorize'))).toBe(true)
    })
    await waitFor(() => { expect(assign).toHaveBeenCalledWith(authorizeUrl) })
  })

  it('uses the Chinese copy under the zh dictionary', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ authenticated: false }), { status: 200 })))
    await act(async () => { render(<SsoNotice t={translate(zh)} />) })
    await waitFor(() => { expect(screen.queryByText(zh.notice)).not.toBeNull() })
  })
})

describe('SsoSection', () => {
  /** The section reads no global slot source; any of those hooks reaching it is a bug. */
  function unusedHook(): never {
    throw new Error('This section does not read global slot sources')
  }

  /** Mount the section with the stubbed locale seat, the shell's close seat, and inert global hooks. */
  function mountSection(): void {
    render(
      <SsoSection
        close={() => {}}
        usePanelInfo={unusedHook}
        useSessions={unusedHook}
        useSessionStatus={unusedHook}
        useSessionRetainInfo={unusedHook}
        useWorkspaces={unusedHook}
        useResource={unusedHook}
        t={translate(en)}
      />,
    )
  }

  it('reports the signed-in state with its expiry and offers signing out', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ authenticated: true, expiresAt: Date.UTC(2026, 0, 2, 3, 4, 5) }),
      { status: 200 },
    )))
    await act(async () => { mountSection() })
    await waitFor(() => { expect(screen.queryByText(en.signedIn, { exact: false })).not.toBeNull() })
    expect(screen.queryByRole('button', { name: en.signOut })).not.toBeNull()
  })

  it('drops the grant through the Host when signing out, then reports signed out', async () => {
    const requested: string[] = []
    let authenticated = true
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      requested.push(`${init?.method ?? 'GET'} ${input}`)
      if (input === '/sso/logout') {
        authenticated = false
        return new Response('{}', { status: 200 })
      }
      return new Response(JSON.stringify({ authenticated }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    await act(async () => { mountSection() })
    await waitFor(() => { expect(screen.queryByRole('button', { name: en.signOut })).not.toBeNull() })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.signOut })) })
    await waitFor(() => { expect(screen.queryByText(en.signedOut)).not.toBeNull() })
    // The section owns no token: signing out is one POST to the Host.
    expect(requested).toContain('POST /sso/logout')
  })

  it('offers signing in while the Host holds no grant', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ authenticated: false }), { status: 200 })))
    await act(async () => { mountSection() })
    await waitFor(() => { expect(screen.queryByRole('button', { name: en.action })).not.toBeNull() })
  })

  it('reports the error copy when the status query fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network') }))
    await act(async () => { mountSection() })
    await waitFor(() => { expect(screen.queryByText(en.error)).not.toBeNull() })
  })
})
