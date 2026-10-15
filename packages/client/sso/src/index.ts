/**
 * Node half of `@deepseek-ai/dsh-client-sso`: the empty `apply` gives Loader a
 * host-side row while the browser half ships through `exports["./client"]`. The
 * re-exported types are the wire surface this package shares with
 * `@deepseek-ai/dsh-host-sso`, importable from either plane.
 */

export type { SsoAuthorize, SsoStatus } from '@deepseek-ai/dsh-host-sso/shared'

/** Host plugin body — this package contributes browser presentation only. */
export function apply(): void {}
