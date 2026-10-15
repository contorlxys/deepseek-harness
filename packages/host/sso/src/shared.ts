/**
 * Route paths and wire payloads shared by the host routes and the browser
 * client, published as the `./shared` subpath. Browser-safe: constants and
 * types only. The callback route is an authorization-server redirect target
 * rather than a fetch API, so it carries only the absolute pathname.
 */

/** GET route answering the current authorization state. */
export const SSO_STATUS_PATH = '/sso/status'

/** GET route producing one authorization redirect. */
export const SSO_AUTHORIZE_PATH = '/sso/authorize'

/** Authorization-server redirect target exchanging one code for tokens. */
export const SSO_CALLBACK_PATH = '/sso/callback'

/** POST route removing the stored grant. */
export const SSO_LOGOUT_PATH = '/sso/logout'

/** Browser fetch form of the status route, rooted at the document origin. */
export const SSO_STATUS_ROUTE = SSO_STATUS_PATH
/** Browser fetch form of the authorize route, rooted at the document origin. */
export const SSO_AUTHORIZE_ROUTE = SSO_AUTHORIZE_PATH
/** Browser fetch form of the logout route, rooted at the document origin. */
export const SSO_LOGOUT_ROUTE = SSO_LOGOUT_PATH

/** GET `/sso/status` answer: the authorization state without secret values. */
export interface SsoStatus {
  /** Whether a usable authorization grant is stored. */
  readonly authenticated: boolean
  /** When authenticated: epoch milliseconds the access token expires at. */
  readonly expiresAt?: number
}

/** GET `/sso/authorize` answer: where the browser navigates next. */
export interface SsoAuthorize {
  readonly authorizeUrl: string
}
