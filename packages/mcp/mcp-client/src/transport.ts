/**
 * Transport factory: creates the appropriate MCP transport based on the
 * plugin's resolved config. Stdio spawns a child process (with credential
 * scrubbing); Streamable HTTP connects to a URL and carries the server's
 * per-request authentication when the config names one.
 *
 * @module
 */

import type { Transport } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import { withoutAuthorization, type TransportAuth } from './request-auth.ts'
import type { Config } from './index.ts'

/**
 * The subprocess seam's scrubbed parent env (credential-shaped and stale
 * `DSH_*` names dropped), plus the spec's explicit env. The MCP SDK owns the
 * actual spawn, so this transport shares the scrub definition rather than the
 * spawn path.
 */
function buildChildEnv(extra: Record<string, string>): Record<string, string> {
  return { ...scrubbedParentEnv(), ...extra }
}

/**
 * Create an MCP transport from the resolved plugin config.
 *
 * @param config - Resolved plugin config discriminated on `transport`.
 * @param requestAuth - Per-request authentication for a Streamable HTTP
 *   transport; stdio carries its credential in the spawned env instead, which
 *   is resolved once per connection attempt.
 * @returns A connected-ready MCP Transport (stdio or Streamable HTTP).
 */
export function createTransport(config: Config, requestAuth?: TransportAuth): Transport {
  switch (config.transport) {
    case 'stdio':
      return new StdioClientTransport({
        command: config.command,
        args: config.args,
        env: buildChildEnv(config.env),
        cwd: config.cwd,
      })
    case 'streamable-http':
      return new StreamableHTTPClientTransport(
        new URL(config.url),
        {
          // The SDK writes the bearer header itself and overrides a configured
          // Authorization value (probed against @modelcontextprotocol/client
          // 2.2.0), so the configured copy is dropped here instead of riding
          // along as a header the transport never sends. Configuring both is
          // rejected at load, in apply().
          requestInit: {
            headers: requestAuth === undefined ? config.headers : withoutAuthorization(config.headers),
          },
          ...requestAuth === undefined ? {} : {
            authProvider: {
              /** Read before every request, so a rotated token needs no reconnect. */
              token: (): Promise<string> => requestAuth.token(),
              onUnauthorized: (): Promise<void> => requestAuth.onUnauthorized(),
            },
          },
        },
      )
  }
}
