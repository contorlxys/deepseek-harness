/**
 * Tests for per-request bearer authentication: the config block, its load-time
 * validation, the credential read that precedes every request, and the rotation
 * that reaches a live server without a reconnect. The rotation case runs the
 * real MCP SDK against a local Streamable HTTP fixture, so the wire behavior is
 * observed rather than assumed.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { CredentialProvider, credentialRef } from '@deepseek-ai/dsh-credentials'
import type {
  CredentialInfo, CredentialKey, CredentialRecord, CredentialRecordEntry,
  CredentialRecordInfo, CredentialRef, ResolvedCredential,
} from '@deepseek-ai/dsh-credentials'
import { apply, Config as ConfigSchema } from '@deepseek-ai/dsh-mcp-client/src/index.ts'
import { createRequestAuth } from '@deepseek-ai/dsh-mcp-client/src/request-auth.ts'
import type { Config } from '@deepseek-ai/dsh-mcp-client'
import { startHttpMcpFixture, type HttpMcpFixture } from './http-fixture.ts'

type HttpConfig = Extract<Config, { transport: 'streamable-http' }>
type StdioConfig = Extract<Config, { transport: 'stdio' }>

// ---- In-memory credential provider ----

/** Minimal provider: resolve/set plus the reference-update event are the surfaces this suite exercises. */
class MemoryCredentials extends CredentialProvider {
  private readonly store = new Map<string, string>()

  override resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    const value = this.store.get(ref)
    return Promise.resolve(value === undefined ? undefined : { value, source: 'memory' })
  }

  override set(ref: CredentialRef, value: string): Promise<void> {
    this.store.set(ref, value)
    this.ctx.emit('credentials/reference-updated', ref)
    return Promise.resolve()
  }

  override describe(): Promise<CredentialInfo> {
    return Promise.resolve({ configured: false, writable: true })
  }

  override unset(): Promise<void> { return Promise.resolve() }

  override readRecord(_key: CredentialKey): Promise<CredentialRecord | undefined> {
    return Promise.resolve(undefined)
  }

  override describeRecord(): Promise<CredentialRecordInfo> {
    return Promise.resolve({ configured: false, writable: true })
  }

  override listRecords(): Promise<readonly CredentialRecordEntry[]> { return Promise.resolve([]) }

  override modifyRecord(): Promise<CredentialRecord | undefined> { return Promise.resolve(undefined) }

  override deleteRecord(): Promise<void> { return Promise.resolve() }
}

// ---- Helpers ----

function httpConfig(overrides: Partial<HttpConfig> = {}): HttpConfig {
  return {
    transport: 'streamable-http',
    serverName: 'srv',
    url: 'http://127.0.0.1:1/mcp',
    headers: {},
    toolCallTimeoutMs: 60_000,
    failOnStartupError: false,
    ...overrides,
  }
}

function stdioConfig(overrides: Partial<StdioConfig> = {}): StdioConfig {
  return {
    transport: 'stdio',
    serverName: 'srv',
    command: 'echo',
    args: [],
    env: {},
    cwd: '',
    toolCallTimeoutMs: 60_000,
    failOnStartupError: false,
    ...overrides,
  }
}

async function mountRegistry(withCredentials: boolean): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  if (withCredentials) await ctx.plugin(MemoryCredentials)
  return ctx
}

/** Capture the supervisor's logger lines by level on one context. */
function captureLogs(ctx: Context): { warns: string[]; errors: string[] } {
  const warns: string[] = []
  const errors: string[] = []
  ctx.logger.warn = ((message: unknown) => { warns.push(String(message)) }) as typeof ctx.logger.warn
  ctx.logger.error = ((message: unknown) => { errors.push(String(message)) }) as typeof ctx.logger.error
  return { warns, errors }
}

// ---- Tests ----

describe('per-request authentication config', () => {
  it('materializes the block with an empty reference when it is omitted', () => {
    // Schemastery materializes a nested object, so "no per-request
    // authentication" is the empty reference rather than an absent key.
    const resolved = ConfigSchema({
      transport: 'streamable-http',
      serverName: 'srv',
      url: 'http://127.0.0.1:1/mcp',
    })
    expect(resolved.auth).toEqual({ credentialRef: '' })
  })

  it('rejects authentication on the stdio transport', async () => {
    const ctx = await mountRegistry(false)
    try {
      await expect(apply(ctx, stdioConfig({ auth: { credentialRef: 'TOK' } })))
        .rejects.toThrow('auth requires the streamable-http transport')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('rejects a reference that is not a credential name', async () => {
    const ctx = await mountRegistry(false)
    try {
      await expect(apply(ctx, httpConfig({ auth: { credentialRef: 'BAD NAME' } })))
        .rejects.toThrow('is not a valid credential name')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('rejects authentication beside a configured Authorization header', async () => {
    // The SDK writes that header from the token source, so the configured copy
    // would never be sent: the pair is a load-time error rather than a silent
    // configuration that does nothing.
    const ctx = await mountRegistry(false)
    try {
      await expect(apply(ctx, httpConfig({
        headers: { authorization: 'Bearer static' },
        auth: { credentialRef: 'TOK' },
      })))
        .rejects.toThrow('auth owns the "Authorization" header')
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('per-request authentication callbacks', () => {
  it('reports an unchanged value after a rejection and accepts a rotated one', async () => {
    const ctx = new Context()
    const { errors } = captureLogs(ctx)
    const store = new Map([['TOK', 'first']])
    const auth = createRequestAuth(ctx, 'srv', 'TOK', async (name) => {
      const value = store.get(name)
      if (value === undefined) throw new Error(`credential "${name}" is referenced but not configured`)
      return value
    })

    expect(await auth.token()).toBe('first')
    // A rotated value needs no report: the SDK's retry carries the new token.
    store.set('TOK', 'second')
    await auth.onUnauthorized()
    expect(errors).toEqual([])
    expect(await auth.token()).toBe('second')

    // An unchanged value is a rejection the operator must act on.
    await auth.onUnauthorized()
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('credential "TOK" was rejected with HTTP 401')
  })

  it('fails the request that asked for an unconfigured credential', async () => {
    const ctx = new Context()
    const auth = createRequestAuth(ctx, 'srv', 'MISSING', async (name) => {
      throw new Error(`mcp-client(srv): credential "${name}" is referenced but not configured`)
    })
    await expect(auth.token()).rejects.toThrow('is referenced but not configured')
  })
})

describe('per-request authentication over a live connection', () => {
  let fixture: HttpMcpFixture

  beforeAll(async () => {
    fixture = await startHttpMcpFixture()
  })

  afterAll(async () => {
    await fixture.close()
  })

  it('reads the credential before every request, so a rotation needs no reconnect', async () => {
    const ctx = await mountRegistry(true)
    try {
      const provider = ctx.get('credentials')!
      await provider.set(credentialRef('TOK'), 'first-token')
      await apply(ctx, httpConfig({
        url: fixture.url,
        headers: { 'x-static': 'kept' },
        failOnStartupError: true,
        auth: { credentialRef: 'TOK' },
      }))

      expect(ctx.tools.get('mcp__srv__ping')).toBeDefined()
      expect(fixture.authorization.length).toBeGreaterThan(0)
      expect(new Set(fixture.authorization)).toEqual(new Set(['Bearer first-token']))

      // Rotate mid-connection: a per-connection snapshot would keep sending the
      // first value forever, so the next request carrying the second value is
      // the per-request read.
      await provider.set(credentialRef('TOK'), 'second-token')
      const call = await ctx.tools.execute({
        name: 'mcp__srv__ping', arguments: {},
        callId: ToolCallId('rotated-token'), signal: new AbortController().signal,
      })

      expect(call.isError).toBe(false)
      expect(fixture.calls).toEqual(['ping'])
      expect(fixture.authorization[fixture.authorization.length - 1]).toBe('Bearer second-token')
      expect(new Set(fixture.authorization)).toEqual(new Set(['Bearer first-token', 'Bearer second-token']))
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('fails the connection attempt loudly when no credentials provider is loaded', async () => {
    const ctx = await mountRegistry(false)
    const { warns } = captureLogs(ctx)
    const requestsBefore = fixture.authorization.length
    const callsBefore = fixture.calls.length
    try {
      await apply(ctx, httpConfig({
        url: fixture.url,
        reconnect: { maxAttempts: 1, initialDelayMs: 2, maxDelayMs: 8 },
        auth: { credentialRef: 'TOK' },
      }))
      await vi.waitFor(() => {
        expect(warns.some(line => line.includes('is referenced but no credentials provider is loaded'))).toBe(true)
      })
      // No request reached the server: the token read precedes it.
      expect(fixture.authorization.length).toBe(requestsBefore)
      expect(fixture.calls.length).toBe(callsBefore)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
