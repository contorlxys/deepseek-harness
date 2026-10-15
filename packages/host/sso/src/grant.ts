/**
 * Grant and pending-attempt storage on the credential seam's record half. The
 * authorization grant (tokens and expiry) is this plugin's private record —
 * the payload format is nobody else's — committed only through the serialized
 * read-modify-write so a concurrent refresh rotates safely. An in-flight
 * authorization round trip is stored the same way, under a key derived from its
 * state, so a Host restart cannot lose a sign-in that is already under way.
 * The current access token is projected onto a credential reference, the
 * surface consumers (MCP transports) resolve; every projection fans
 * `credentials/reference-updated`, which is what recycles their connections.
 *
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import {
  credentialKey, credentialKeyId, credentialRef,
  type CredentialKey, type CredentialRecord, type CredentialRef, type GrantRecord,
} from '@deepseek-ai/dsh-credentials'

/** This plugin's record scope; the payload format is private to it. */
const SCOPE = 'sso'

/** One stored authorization grant in this plugin's payload format. */
export interface SsoGrant {
  readonly accessToken: string
  readonly refreshToken: string
  /** Epoch milliseconds the access token expires at. */
  readonly expiresAt: number
}

/**
 * Narrow a stored record to this plugin's grant. The record half crosses a
 * durable boundary — the value on disk is untrusted shape — so every member
 * is re-validated here.
 * @param record - the record read from the seam.
 * @returns the grant, or undefined when none is stored in this plugin's format.
 */
export function parseGrantRecord(record: CredentialRecord | undefined): SsoGrant | undefined {
  if (record === undefined || record.kind !== 'grant') return undefined
  const payload: unknown = record.payload
  if (typeof payload !== 'object' || payload === null) return undefined
  const candidate = payload as Record<string, unknown>
  const accessToken = candidate['accessToken']
  const refreshToken = candidate['refreshToken']
  const expiresAt = candidate['expiresAt']
  if (typeof accessToken !== 'string' || accessToken === '') return undefined
  if (typeof refreshToken !== 'string' || refreshToken === '') return undefined
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) return undefined
  return { accessToken, refreshToken, expiresAt }
}

/** Wrap one grant as this plugin's stored record. */
function grantRecord(grant: SsoGrant): GrantRecord {
  return { kind: 'grant', payload: { ...grant } }
}

/** Serialized read-modify-write access to this plugin's grant record. */
export interface GrantStore {
  /** Read the currently stored grant. */
  read(): Promise<SsoGrant | undefined>
  /**
   * Commit one read-modify-write over the grant record. `mutate` sees the
   * grant at the moment the write is exclusive; returning undefined leaves
   * the record untouched.
   * @param mutate - receives the current grant and returns its replacement.
   * @returns the grant after the write, or the current one when mutate declined.
   */
  commit(mutate: (current: SsoGrant | undefined) => Promise<SsoGrant | undefined>): Promise<SsoGrant | undefined>
  /** Remove the stored grant; removing an absent grant is a no-op. */
  remove(): Promise<void>
}

/**
 * Create the grant store over the composition's credential provider.
 * @param ctx - plugin context carrying the credentials service.
 * @param id - this plugin's own addressing unit for the record.
 * @returns the store bound to `<scope>/<id>`.
 */
export function createGrantStore(ctx: Context, id: string): GrantStore {
  const key: CredentialKey = credentialKey(SCOPE, id)
  return {
    read: () => ctx.credentials.readRecord(key).then(parseGrantRecord),
    async commit(mutate) {
      const next = await ctx.credentials.modifyRecord(key, async (record) => {
        const replacement = await mutate(parseGrantRecord(record))
        return replacement === undefined ? undefined : grantRecord(replacement)
      })
      return parseGrantRecord(next)
    },
    remove: () => ctx.credentials.deleteRecord(key),
  }
}

/**
 * Project the current access token onto one credential reference.
 * @param ctx - plugin context carrying the credentials service.
 * @param ref - the reference consumers resolve.
 * @param token - the non-empty access token.
 * @returns after the value is durably stored; the provider fans the update event.
 */
export function projectToken(ctx: Context, ref: CredentialRef, token: string): Promise<void> {
  return ctx.credentials.set(ref, token)
}

/**
 * Withdraw the projected token.
 * @param ctx - plugin context carrying the credentials service.
 * @param ref - the reference consumers resolved.
 * @returns after the value is removed.
 */
export function withdrawToken(ctx: Context, ref: CredentialRef): Promise<void> {
  return ctx.credentials.unset(ref)
}

/**
 * Build the credential reference this plugin projects the current access token onto.
 * @param name - the configured credential reference name.
 * @returns the credential reference named by `name`.
 */
export function tokenRef(name: string): CredentialRef {
  return credentialRef(name)
}

/** One in-flight authorization round trip, persisted so a restart cannot lose it. */
export interface SsoPending {
  /** PKCE verifier bound to the round trip's challenge. */
  readonly verifier: string
  /** Epoch milliseconds the attempt stops being consumable. */
  readonly expiresAt: number
}

/**
 * How long an in-flight attempt stays consumable. The window has to cover a
 * human sign-in — a login form, a second factor, and a detour through a
 * front-end relay page — because an attempt that expires mid-login costs the
 * whole round trip.
 */
export const PENDING_TTL_MS = 30 * 60_000

/**
 * Narrow a stored record to this plugin's pending attempt. Like the grant, the
 * payload crosses a durable boundary, so every member is re-validated here.
 * @param record - the record read from the seam.
 * @returns the attempt, or undefined when none is stored in this plugin's format.
 */
export function parsePendingRecord(record: CredentialRecord | undefined): SsoPending | undefined {
  if (record === undefined || record.kind !== 'grant') return undefined
  const payload: unknown = record.payload
  if (typeof payload !== 'object' || payload === null) return undefined
  const candidate = payload as Record<string, unknown>
  const verifier = candidate['verifier']
  const expiresAt = candidate['expiresAt']
  if (typeof verifier !== 'string' || verifier === '') return undefined
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) return undefined
  return { verifier, expiresAt }
}

/** Serialized access to this plugin's pending-attempt records. */
export interface PendingStore {
  /**
   * Record one in-flight attempt under a key derived from its state.
   * @param state - the state the callback has to present.
   * @param attempt - the verifier and deadline to store.
   */
  put(state: string, attempt: SsoPending): Promise<void>
  /**
   * Consume one attempt: read it and remove it in the same call, so a replayed
   * callback — in this process or the next one — finds nothing.
   * @param state - the state the callback presented.
   * @returns the stored attempt, or undefined when none is stored.
   */
  take(state: string): Promise<SsoPending | undefined>
  /**
   * Remove attempts whose deadline has passed.
   * @param now - the instant to compare deadlines against.
   */
  drain(now: number): Promise<void>
}

/**
 * Create the pending-attempt store over the composition's credential provider.
 * Attempts live on the record half — the same durable home as the grant — so an
 * attempt minted before a Host restart is still consumable after it. That is
 * what keeps a sign-in started in one Host process from dying with it.
 * @param ctx - plugin context carrying the credentials service.
 * @param id - this plugin's own addressing unit for the record.
 * @returns the store bound to `<scope>/<id>-pending-<state>`.
 */
export function createPendingStore(ctx: Context, id: string): PendingStore {
  const prefix = `${id}-pending-`
  const keyFor = (state: string): CredentialKey => credentialKey(SCOPE, `${prefix}${state}`)
  return {
    async put(state, attempt) {
      const record: GrantRecord = { kind: 'grant', payload: { ...attempt } }
      await ctx.credentials.modifyRecord(keyFor(state), () => Promise.resolve(record))
    },
    async take(state) {
      const key = keyFor(state)
      const attempt = parsePendingRecord(await ctx.credentials.readRecord(key))
      if (attempt !== undefined) await ctx.credentials.deleteRecord(key)
      return attempt
    },
    async drain(now) {
      for (const entry of await ctx.credentials.listRecords()) {
        if (entry.kind !== 'grant' || !credentialKeyId(entry.key).startsWith(prefix)) continue
        const attempt = parsePendingRecord(await ctx.credentials.readRecord(entry.key))
        if (attempt !== undefined && attempt.expiresAt <= now) await ctx.credentials.deleteRecord(entry.key)
      }
    },
  }
}
