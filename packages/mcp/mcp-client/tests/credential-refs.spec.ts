/**
 * Tests for credential-reference templates in MCP transport configuration:
 * name scanning and substitution, the optional-provider resolution path, and
 * the event-driven connection recycle that re-resolves references when a
 * referenced credential changes. Isolated file so vi.mock of the MCP SDK
 * doesn't pollute other test suites.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { CredentialProvider, credentialRef } from '@deepseek-ai/dsh-credentials'
import type {
  CredentialInfo, CredentialKey, CredentialRecord, CredentialRecordEntry,
  CredentialRecordInfo, CredentialRef, ResolvedCredential,
} from '@deepseek-ai/dsh-credentials'
import type { Config } from '@deepseek-ai/dsh-mcp-client'

// ---- Mock MCP SDK ----

// vi.mock factories are hoisted above every import/const, so the mock fns and
// class must be created inside vi.hoisted to exist when the factories run.
const { mockConnect, mockClose, mockListTools, MockClient, instances, stdioConstructions } = vi.hoisted(() => {
  const mockConnect = vi.fn<() => Promise<void>>()
  const mockClose = vi.fn<() => Promise<void>>()
  const mockListTools = vi.fn<(_params?: Record<string, unknown>) => Promise<unknown>>()
  class MockClient {
    transport: object | undefined = {}
    onclose: (() => void) | undefined
    connect = mockConnect
    close = mockClose
    getServerCapabilities = () => ({ tools: {} })
    getInstructions(): string | undefined { return undefined }
    listTools = mockListTools
    constructor(_info: unknown, _options: unknown) { instances.push(this) }
  }
  const instances: MockClient[] = []
  // Every transport construction records the env the supervisor resolved.
  const stdioConstructions: Array<{ env?: Record<string, string> }> = []
  return { mockConnect, mockClose, mockListTools, MockClient, instances, stdioConstructions }
})

vi.mock('@modelcontextprotocol/client', async importOriginal => ({
  ...await importOriginal<typeof import('@modelcontextprotocol/client')>(),
  Client: MockClient,
}))

vi.mock('@modelcontextprotocol/client/stdio', () => ({
  StdioClientTransport: vi.fn(function (_options: { env?: Record<string, string> }) {
    stdioConstructions.push(_options)
    return { close: () => Promise.resolve() }
  }),
}))

// vi.mock is hoisted above static imports, so the modules under test see the
// mocked SDK even through a static import.
import { apply } from '@deepseek-ai/dsh-mcp-client/src/index.ts'
import { referencedCredentialNames, resolveCredentialTemplates } from '@deepseek-ai/dsh-mcp-client/src/credential-refs.ts'

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

function stdioConfig(env: Record<string, string>, reconnect?: Config['reconnect']): Extract<Config, { transport: 'stdio' }> {
  return {
    transport: 'stdio',
    serverName: 'srv',
    command: 'echo',
    args: [],
    env,
    cwd: '',
    toolCallTimeoutMs: 60_000,
    failOnStartupError: false,
    ...reconnect === undefined ? {} : { reconnect },
  }
}

function httpConfig(headers: Record<string, string>): Extract<Config, { transport: 'streamable-http' }> {
  return {
    transport: 'streamable-http',
    serverName: 'srv',
    url: 'http://127.0.0.1:1/mcp',
    headers,
    toolCallTimeoutMs: 60_000,
    failOnStartupError: false,
  }
}

/** The tool list the mock server advertises after a successful (re)connect. */
function listing(...names: string[]): { tools: { name: string; inputSchema: { type: string } }[]; nextCursor: undefined } {
  return {
    tools: names.map(name => ({ name, inputSchema: { type: 'object' } })),
    nextCursor: undefined,
  }
}

/** Capture the supervisor's logger lines by level on one context. */
function captureLogs(ctx: Context): { warns: string[]; errors: string[]; infos: string[] } {
  const warns: string[] = []
  const errors: string[] = []
  const infos: string[] = []
  ctx.logger.warn = ((message: unknown) => { warns.push(String(message)) }) as typeof ctx.logger.warn
  ctx.logger.error = ((message: unknown) => { errors.push(String(message)) }) as typeof ctx.logger.error
  ctx.logger.info = ((message: unknown) => { infos.push(String(message)) }) as typeof ctx.logger.info
  return { warns, errors, infos }
}

async function mountRegistry(withCredentials: boolean): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  if (withCredentials) await ctx.plugin(MemoryCredentials)
  return ctx
}

// ---- Tests ----

describe('credential-reference scanning', () => {
  it('reports no references for a literal configuration', () => {
    expect(referencedCredentialNames(stdioConfig({ TOKEN: 'literal' }))).toEqual(new Set())
    expect(referencedCredentialNames(stdioConfig({}))).toEqual(new Set())
  })

  it('collects env references on stdio and header references on streamable-http', () => {
    expect(referencedCredentialNames(stdioConfig({ TOKEN: '${cred:MY_TOKEN}', OTHER: 'x' })))
      .toEqual(new Set(['MY_TOKEN']))
    expect(referencedCredentialNames(httpConfig({ authorization: 'Bearer ${cred:TOK}' })))
      .toEqual(new Set(['TOK']))
  })

  it('deduplicates repeated references', () => {
    expect(referencedCredentialNames(stdioConfig({
      A: '${cred:X}', B: '${cred:X}', C: '${cred:Y}',
    }))).toEqual(new Set(['X', 'Y']))
  })

  it('rejects an invalid reference name at load', () => {
    expect(() => referencedCredentialNames(stdioConfig({ A: '${cred:BAD NAME}' }))).toThrow('not a valid credential name')
    expect(() => referencedCredentialNames(httpConfig({ A: '${cred:9X}' }))).toThrow('not a valid credential name')
  })

  it('leaves non-template text untouched by the scan', () => {
    expect(referencedCredentialNames(stdioConfig({ A: '${cred:' }))).toEqual(new Set())
    expect(referencedCredentialNames(stdioConfig({ A: 'cred:X' }))).toEqual(new Set())
  })
})

describe('template substitution', () => {
  it('returns the input config unchanged when nothing is referenced', async () => {
    const config = stdioConfig({ TOKEN: 'literal' })
    await expect(resolveCredentialTemplates(config, () => { throw new Error('must not resolve') }))
      .resolves.toBe(config)
  })

  it('substitutes env references, including inside a larger value', async () => {
    const config = stdioConfig({ TOKEN: 'Bearer ${cred:TOK}', OTHER: '${cred:TOK}' })
    const resolved = await resolveCredentialTemplates(config, async name => `v-${name}`)
    expect(resolved).toEqual({ ...config, env: { TOKEN: 'Bearer v-TOK', OTHER: 'v-TOK' } })
    // The configured record itself is left untouched.
    expect(config.env['TOKEN']).toBe('Bearer ${cred:TOK}')
  })

  it('substitutes header references on streamable-http', async () => {
    const config = httpConfig({ authorization: 'Bearer ${cred:TOK}' })
    const resolved = await resolveCredentialTemplates(config, async () => 'secret')
    expect(resolved).toEqual({ ...config, headers: { authorization: 'Bearer secret' } })
  })

  it('propagates a resolver failure as the attempt failure', async () => {
    const config = stdioConfig({ TOKEN: '${cred:TOK}' })
    await expect(resolveCredentialTemplates(config, () => Promise.reject(new Error('refused'))))
      .rejects.toThrow('refused')
  })
})

describe('credential-resolving connection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    instances.length = 0
    stdioConstructions.length = 0
    mockConnect.mockResolvedValue(undefined)
    mockClose.mockImplementation(function (this: { onclose?: () => void }) {
      this.onclose?.()
      return Promise.resolve()
    })
    mockListTools.mockResolvedValue(listing('remote'))
  })

  it('fails the attempt loudly when no credentials provider is loaded', async () => {
    const ctx = await mountRegistry(false)
    const { warns } = captureLogs(ctx)
    try {
      await apply(ctx, stdioConfig({ TOKEN: '${cred:TOK}' }, { initialDelayMs: 2, maxDelayMs: 8, maxAttempts: 1 }))
      await vi.waitFor(() => {
        expect(warns.some(line => line.includes('is referenced but no credentials provider is loaded'))).toBe(true)
      })
      // No transport was ever built from the unresolved reference.
      expect(stdioConstructions).toHaveLength(0)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('fails the attempt loudly when the referenced credential is not configured', async () => {
    const ctx = await mountRegistry(true)
    const { warns } = captureLogs(ctx)
    try {
      await apply(ctx, stdioConfig({ TOKEN: '${cred:TOK}' }, { initialDelayMs: 2, maxDelayMs: 8, maxAttempts: 1 }))
      await vi.waitFor(() => {
        expect(warns.some(line => line.includes('is referenced but not configured'))).toBe(true)
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('resolves references into each transport construction', async () => {
    const ctx = await mountRegistry(true)
    try {
      await ctx.get('credentials')!.set(credentialRef('TOK'), 'first-secret')
      await apply(ctx, stdioConfig({ TOKEN: '${cred:TOK}' }))
      await vi.waitFor(() => { expect(ctx.tools.get('mcp__srv__remote')).toBeDefined() })
      // The transport env merges scrubbed ambient vars; the reference landed.
      expect(stdioConstructions[0]!.env?.['TOKEN']).toBe('first-secret')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('recycles the live connection when a referenced credential changes', async () => {
    const ctx = await mountRegistry(true)
    const { infos } = captureLogs(ctx)
    try {
      const provider = ctx.get('credentials')!
      await provider.set(credentialRef('TOK'), 'first-secret')
      await apply(ctx, stdioConfig({ TOKEN: '${cred:TOK}' }, { initialDelayMs: 2, maxDelayMs: 8 }))
      await vi.waitFor(() => { expect(ctx.tools.get('mcp__srv__remote')).toBeDefined() })
      expect(stdioConstructions).toHaveLength(1)

      await provider.set(credentialRef('TOK'), 'rotated-secret')
      await vi.waitFor(() => { expect(stdioConstructions).toHaveLength(2) })
      // The recycled generation resolved the updated credential.
      expect(stdioConstructions[1]!.env?.['TOKEN']).toBe('rotated-secret')
      expect(infos.some(line => line.includes('credential "TOK" changed; recycling connection'))).toBe(true)

      // An unrelated reference update leaves the live connection alone.
      await provider.set(credentialRef('OTHER'), 'unrelated')
      await new Promise(resolve => setTimeout(resolve, 30))
      expect(stdioConstructions).toHaveLength(2)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
