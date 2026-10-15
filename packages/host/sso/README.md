---
description: "Host half of Web single sign-on: runs the PKCE authorization-code round trip against the identity provider, stores the grant in the credential seam, refreshes tokens, and projects the current token onto a credential reference for consumers."
kind: "package-reference"
---

# @deepseek-ai/dsh-host-sso

English | [中文](README.zh.md)

## Summary

Use `dsh-host-sso` to run the Web single sign-on round trip and credential lifetime on the Host side. The browser asks `/sso/authorize` for a URL and navigates; the identity provider redirects to `/sso/callback`, which this package validates, exchanges with the PKCE verifier it kept, commits the authorization grant as a private `GrantRecord` in the credential seam, and projects the access token onto a credential reference whose `credentials/reference-updated` event recycles consumer connections with the new token. The browser never touches a secret.

## Sections

- [Using this package](#using-this-package)
- [Understanding the implementation](#understanding-the-implementation)
- [Known limitations and deferred work](#known-limitations-and-deferred-work)

-----

<a id="using-this-package"></a>
## Using this package

Mount the package in a Web composition that provides `webServer`, `connection`, and a credential provider (usually `dsh-credentials-local`).

### Minimal configuration

```yaml
- name: '@deepseek-ai/dsh-host-sso'
```

| Field | Default | Meaning |
|---|---|---|
| `mode` | `mock` | `mock` derives deterministic tokens without network; `remote` runs the real PKCE round trip. |
| `authorizeUrl` | `''` | Authorization endpoint, or the front-end relay page that forwards to it; required exactly when `mode` is `remote`. With a fragment (`https://idp/#/oauth2/`) the parameters ride inside the fragment (`#/oauth2/?…`), where the relay reads them from the full href. |
| `tokenUrl` | `''` | Token endpoint; required exactly when `mode` is `remote`. |
| `clientId` | `''` | Public client identifier; required exactly when `mode` is `remote`. |
| `clientSecret` | `''` | Confidential-client secret posted to the token endpoint; empty keeps the exchange a public-client PKCE one. Falls back to `$DSH_SSO_CLIENT_SECRET` and stays host-side (never logged, never sent to the browser). |
| `scope` | `''` | Requested scope; empty omits the parameter. |
| `redirectPath` | `/sso/callback` | Callback path the authorize redirect targets. |
| `redirectUri` | `''` (derived from the request Host) | Absolute callback URL registered with the identity provider; set it when TLS or a proxy makes the derived `http://<Host><redirectPath>` differ from the registration. |
| `credentialKey` | `default` | This plugin's own addressing unit on the seam's record half. |
| `credentialRef` | `DSH_ERP_ACCESS_TOKEN` | Credential reference the access token is projected onto. |
| `expirySkewMs` | `60000` | How long before expiry a refresh starts, in milliseconds. |
| `exchangeTimeoutMs` | `15000` | Deadline for one remote exchange in milliseconds. |

The generated [config catalog](../../../docs/config-catalog.md#deepseek-aidsh-host-sso) is the exhaustive source of truth for every supported field.

### Expected behavior

`GET /sso/authorize` produces state and a PKCE verifier and answers the navigate URL (in `mock` mode it points straight back at this Host's callback carrying a mock code, so the browser-side flow is identical to the real one); both ride the credential seam's record half, so a Host restart between the two legs does not strand the sign-in. `GET /sso/callback` is the identity provider's redirect target: after the state validates it exchanges, commits the grant, projects the access token, and answers a 302 back to the application (the callback's own parent path, so a deployment that proxies the app under a prefix returns to that prefix) — the browser lands on the home screen instead of a dead end. `GET /sso/status` reports the authorization state and renews inside the refresh window; `POST /sso/logout` removes the grant and withdraws the projection. `authorize`/`status`/`logout` are browser fetches behind the connection trust fence; `callback` is a redirect target that cannot require the browser login cookie — the state value carries its CSRF protection.

<a id="understanding-the-implementation"></a>
## Understanding the implementation

The grant is this package's private `GrantRecord`: the payload format is interpretable only here, the record half has no environment to layer, and presence is the whole fact. Writes go only through `modifyRecord`'s serialized read-modify-write — two processes rotating one refresh token concurrently lose no write, the exact path the seam documents for token refresh. The refresh runs inside the write lock: concurrent callers rotate once and re-read the winner's grant; a refused grant withdraws outside the lock (removing a record from inside its own read-modify-write would deadlock the seam), while a transient failure — an unreachable endpoint, a 5xx — keeps the record so the next call retries the refresh instead of costing the operator a login. Every token change `set`s the current access token onto the configured reference; the projection fact fans out as `credentials/reference-updated`, on which consumers (`dsh-mcp-client`'s `${cred:NAME}` templates) reconnect and re-resolve. PKCE is mandatory for a public client: the verifier is generated and kept on the Host, and the authorize URL carries only the `S256` challenge.

## Model Experience

None, as the package manages the identity-provider round trip and the credential seam; it exposes no model-facing context, tool schema, or prompt text.

#### KV Cache effect

No model request depends on this package. The access token it projects onto a credential reference reaches consumers through their own read path, so any cache effect belongs to those consumers, not here.

## Known Limitations and Deferred Work

- Refresh is driven by `status` queries and plugin-activation recovery; without a query there is no refresh, so the freshness bound for consumer tokens is the client's polling cadence.
- `remote` mode assumes the identity provider accepts the callback URL this Host presents — the configured `redirectUri`, or `http://<Host><redirectPath>` when none is configured (dynamic ports need the IdP to accept them). If the provider accepts neither, the fallback is a browser-side code relay, which regains browser-JavaScript exposure.
- When the identity provider does not rotate refresh tokens, the stored `refreshToken` stands; `mock` mode derives fixtures, not credentials — it exists so the whole round trip is exercisable before the IdP ships its endpoints.
