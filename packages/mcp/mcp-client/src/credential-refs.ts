/**
 * Credential-reference templates for MCP transport configuration: `env` and
 * `headers` values may carry `${cred:NAME}` occurrences that the credential
 * seam resolves at every connection attempt. A transport snapshots its env
 * and headers for the life of one connection, so references re-resolve on
 * every connect and reconnect — and a `credentials/reference-updated` event
 * for a referenced name recycles the live connection, which is what lets a
 * rotated token reach the server without a Host restart.
 *
 * @module
 */

import { isCredentialRefName } from '@deepseek-ai/dsh-credentials'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { Config } from './index.ts'

/** One `${cred:NAME}` occurrence in a configured string value. */
const TEMPLATE = /\$\{cred:([^}]*)\}/g

/**
 * Resolves one referenced credential name to its current value. Rejection
 * (or a thrown error) is one connection-attempt failure; the supervisor logs
 * it and retries per its reconnect policy.
 */
export type CredentialRefResolver = (name: string) => Promise<string>

/**
 * Every configured string a credential reference may appear in.
 * @param config - resolved plugin config.
 * @returns stdio env values, or Streamable HTTP header values.
 */
function credentialValueSlots(config: Config): string[] {
  switch (config.transport) {
    case 'stdio':
      return Object.values(config.env)
    case 'streamable-http':
      return Object.values(config.headers)
    default:
      return assertNever(config)
  }
}

/**
 * Validate one configured value and collect the names its references name.
 * @param value - one configured env or header value.
 * @returns the referenced names; empty when the value is literal.
 * @throws Error when a `${cred:...}` occurrence names an invalid credential reference.
 */
function namesInValue(value: string): string[] {
  const names: string[] = []
  for (const match of value.matchAll(TEMPLATE)) {
    const name = match[1] ?? ''
    if (!isCredentialRefName(name)) {
      throw new Error(`credential reference "\${cred:${name}}" is not a valid credential name`)
    }
    names.push(name)
  }
  return names
}

/**
 * Every credential name the transport configuration references.
 * @param config - resolved plugin config.
 * @returns the referenced names; empty when the configuration is fully literal.
 * @throws Error when a `${cred:...}` occurrence names an invalid credential reference.
 */
export function referencedCredentialNames(config: Config): Set<string> {
  const names = new Set<string>()
  for (const value of credentialValueSlots(config)) {
    for (const name of namesInValue(value)) names.add(name)
  }
  return names
}

/**
 * Substitute every `${cred:NAME}` occurrence in one record's values.
 * @param values - configured env or header values.
 * @param resolved - every referenced name mapped to its current value.
 * @returns a new record; the input record is left untouched.
 */
function substituteValues(values: Record<string, string>, resolved: ReadonlyMap<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(values)) {
    out[key] = value.replace(TEMPLATE, (_occurrence: string, name: string): string => {
      const replacement = resolved.get(name)
      // Every referenced name is resolved into the map first, so a miss here
      // is an internal inconsistency; it fails loud instead of substituting
      // the template text into a live request.
      /* v8 ignore next 3 -- unreachable by construction: namesInValue and this
         callback share one TEMPLATE, so every captured name was resolved. */
      if (replacement === undefined) {
        throw new Error(`credential "${name}" was not resolved before substitution`)
      }
      return replacement
    })
  }
  return out
}

/**
 * Resolve every credential reference in the transport configuration. The
 * returned config carries literal values only, so a transport built from it
 * observes exactly one resolution per connection attempt.
 * @param config - resolved plugin config.
 * @param resolve - resolves one referenced name to its current value.
 * @returns a new config with templates substituted, or the input config when
 *   it references no credentials.
 * @throws Error when a referenced credential name fails to resolve.
 */
export async function resolveCredentialTemplates(config: Config, resolve: CredentialRefResolver): Promise<Config> {
  const names = [...referencedCredentialNames(config)]
  if (names.length === 0) return config
  const resolved = new Map<string, string>()
  await Promise.all(names.map(async (name) => {
    resolved.set(name, await resolve(name))
  }))
  switch (config.transport) {
    case 'stdio':
      return { ...config, env: substituteValues(config.env, resolved) }
    case 'streamable-http':
      return { ...config, headers: substituteValues(config.headers, resolved) }
    default:
      return assertNever(config)
  }
}
