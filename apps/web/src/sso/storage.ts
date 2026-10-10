/**
 * Tab-scoped persistence for the authorization round trip.
 *
 * The state value defends the redirect against cross-site request forgery, and
 * the code is held only long enough for the shell to hand it to the backend
 * that exchanges it. Both live in `sessionStorage`: neither should outlive the
 * tab, and neither is readable by another origin.
 */

import type { SsoAuthorizationCode } from './flow.ts'

/** Minimal storage face the round trip persists through. */
export interface SsoStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/** Storage key holding the pending state value. */
export const SSO_STATE_STORAGE_KEY = 'dsh.sso.state'

/** Storage key holding the captured authorization code. */
export const SSO_CODE_STORAGE_KEY = 'dsh.sso.code'

/**
 * Resolve the browser's tab storage, or undefined when this realm has none.
 * @returns the `sessionStorage` face, or undefined outside a browser.
 */
export function browserSsoStorage(): SsoStorage | undefined {
  try {
    return globalThis.sessionStorage
  } catch {
    // Some privacy modes throw on the property access itself; fall back below.
    return undefined
  }
}

/** Pending-state store: written before the redirect, read back once. */
export interface SsoStateStore {
  save(state: string): void
  consume(): string | undefined
}

/** Captured-code store: written once the redirect returns. */
export interface SsoCodeStore {
  read(): SsoAuthorizationCode | undefined
  write(code: SsoAuthorizationCode): void
  clear(): void
}

/** Build options for the round-trip stores. */
export interface SsoStorageOptions {
  /** Storage backing the store; `null` keeps the value in memory only. Omitted selects `sessionStorage` when available. */
  readonly storage?: SsoStorage | null
  /** Storage key; the defaults separate the state from the code. */
  readonly key?: string
}

/**
 * Create the pending-state store.
 * @param options - storage and key choices.
 * @returns the store the gate saves to before redirecting and consumes after.
 */
export function createSsoStateStore(options: SsoStorageOptions = {}): SsoStateStore {
  const key = options.key ?? SSO_STATE_STORAGE_KEY
  const storage = options.storage === undefined ? browserSsoStorage() : options.storage
  let pending: string | undefined
  return {
    save(state: string): void {
      pending = state
      writeRaw(storage, key, state)
    },
    consume(): string | undefined {
      const state = pending ?? readRaw(storage, key)
      pending = undefined
      dropRaw(storage, key)
      return state === null || state === '' ? undefined : state
    },
  }
}

/**
 * Create the captured-code store.
 * @param options - storage and key choices.
 * @returns the store holding the code until the backend exchange takes it.
 */
export function createSsoCodeStore(options: SsoStorageOptions = {}): SsoCodeStore {
  const key = options.key ?? SSO_CODE_STORAGE_KEY
  const storage = options.storage === undefined ? browserSsoStorage() : options.storage
  let cached = parseCode(readRaw(storage, key))
  return {
    read(): SsoAuthorizationCode | undefined {
      return cached
    },
    write(code: SsoAuthorizationCode): void {
      cached = code
      writeRaw(storage, key, JSON.stringify(code))
    },
    clear(): void {
      cached = undefined
      dropRaw(storage, key)
    },
  }
}

function readRaw(storage: SsoStorage | null | undefined, key: string): string | null {
  if (storage === null || storage === undefined) return null
  try {
    return storage.getItem(key)
  } catch {
    /* v8 ignore next -- a hostile or disabled storage is handled as empty below. */
    return null
  }
}

function writeRaw(storage: SsoStorage | null | undefined, key: string, value: string): void {
  if (storage === null || storage === undefined) return
  try {
    storage.setItem(key, value)
  } catch {
    // Storage quota or privacy mode: the in-memory value remains usable.
  }
}

function dropRaw(storage: SsoStorage | null | undefined, key: string): void {
  if (storage === null || storage === undefined) return
  try {
    storage.removeItem(key)
  } catch {
    // Nothing persisted can be reclaimed either way.
  }
}

/** Validate one stored record; anything unusable is treated as absent. */
function parseCode(raw: string | null): SsoAuthorizationCode | undefined {
  if (raw === null) return undefined
  let decoded: unknown
  try {
    decoded = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (typeof decoded !== 'object' || decoded === null) return undefined
  const record = decoded as Record<string, unknown>
  const code = record['code']
  if (typeof code !== 'string' || code === '') return undefined
  const state = record['state']
  return { code, state: typeof state === 'string' ? state : '' }
}
