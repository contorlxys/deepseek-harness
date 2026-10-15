---
description: "Browser half of Web single sign-on: a frame-wide sign-in notice that prompts authorization while the Host holds no grant, plus a settings section reporting the live state and dropping the grant"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-sso

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-client-sso` is the browser half of Web single sign-on. It registers one entry into the `shell.overlay` layer that polls the Host's authorization state (`GET /sso/status`) and, while the grant is absent, holds a frame-wide notice whose action starts the round trip. The component fetches `GET /sso/authorize`, navigates to the answered URL, and otherwise stays out of the way — the Host owns every secret, the token exchange, and the credential projection. It also registers one `settings.section` entry that reports the live state with the access token's expiry and offers the one action that state allows: signing in, or signing out through `POST /sso/logout`. See [`@deepseek-ai/dsh-host-sso`](../../host/sso/README.md) for the Host-side behavior and the wire contract.

## Sections

- [Using this package](#using-this-package)
- [Understanding the implementation](#understanding-the-implementation)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="using-this-package"></a>
## Using this package

Mount the package in a Web composition that already mounts `@deepseek-ai/dsh-host-sso` (both appear as `sso` / `client-sso` roster entries in the Web bundle). The browser app needs no bespoke code: the notice appears and disappears on its own.

The notice polls on a fixed cadence and answers one of three render states:

- **signed out** — a frame-wide banner with a "Sign in" action;
- **error** — the same banner with a "Retry" action when the status query fails;
- **signed in** — nothing; the banner unmounts the moment the grant exists.

The polling cadence is a UX constant, not a deployment knob, so it stays in the component rather than in `Config`.

The settings section is where the state stays visible after the notice withdraws itself: it reports signed in (with the access token's expiry) or not signed in, and its button signs out through the Host — one `POST /sso/logout` removes the stored grant and withdraws the projected token, so consumers lose their authorization on their next request. Nothing but an action label lives in the browser: the section never holds a token, and a gateway-side revocation stays the identity provider's own concern.

<a id="understanding-the-implementation"></a>
## Understanding the implementation

The components are self-contained: the notice owns its `useEffect` poll loop, the section reads the state once on mount and re-reads it after an action, and each registers only an `id` (into `shell.overlay` and `settings.section` respectively) so neither displaces another entry. The wire boundary lives in one module, `wire.ts`: both components narrow every answer there (`isSsoStatus`, `isSsoAuthorize`), so a malformed Host answer fails loudly instead of rendering a blank surface. The action never touches a secret — it fetches an already-constructed `authorizeUrl` and calls `window.location.assign` on it; the PKCE verifier and the code exchange stay on the Host. Once the Host's completion page returns the browser and the next poll observes the grant, the component withdraws itself, and the Host's `credentials/reference-updated` fan-out is what makes consumers (MCP transports) reconnect with the fresh token.

## Model Experience

None, as the package is a browser overlay prompt; it renders no model-facing context, tool schema, or prompt text.

#### KV Cache effect

No model request depends on this package. Its sign-in notice is a frame-wide UI element whose presence or absence does not alter any model prompt or tool schema.

## Known Limitations and Deferred Work

- The notice is a prompt, not a gate: it depends on `@deepseek-ai/dsh-host-sso` being mounted and serving `/sso/status`. With the Host absent the poll reports an error state rather than a silent stall, so the banner stays visible instead of vanishing — the intended configuration always pairs the two entries.
- The poll cadence is a fixed UX constant, so a deployment that needs a different rhythm must change the component, not the configuration.
- Token freshness for consumers is bounded by that polling cadence plus the Host's refresh window, described in the Host package.
