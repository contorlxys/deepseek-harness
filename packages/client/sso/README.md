---
description: "Browser half of Web single sign-on: a frame-wide sign-in notice that prompts authorization while the Host holds no grant, starting the Host's PKCE round trip"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-sso

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-client-sso` is the browser half of Web single sign-on. It registers one entry into the `shell.overlay` layer that polls the Host's authorization state (`GET /sso/status`) and, while the grant is absent, holds a frame-wide notice whose action starts the round trip. The component fetches `GET /sso/authorize`, navigates to the answered URL, and otherwise stays out of the way — the Host owns every secret, the token exchange, and the credential projection. See [`@deepseek-ai/dsh-host-sso`](../../host/sso/README.md) for the Host-side behavior and the wire contract.

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

<a id="understanding-the-implementation"></a>
## Understanding the implementation

The component is self-contained: it owns its `useEffect` poll loop and its action, registering only an `id` into `shell.overlay` so it never displaces another entry. The wire boundary is narrowed at each fetch (`isSsoStatus`, `isSsoAuthorize`), so a malformed Host answer fails loudly instead of rendering a blank banner. The action never touches a secret — it fetches an already-constructed `authorizeUrl` and calls `window.location.assign` on it; the PKCE verifier and the code exchange stay on the Host. Once the Host's completion page returns the browser and the next poll observes the grant, the component withdraws itself, and the Host's `credentials/reference-updated` fan-out is what makes consumers (MCP transports) reconnect with the fresh token.

## Model Experience

None, as the package is a browser overlay prompt; it renders no model-facing context, tool schema, or prompt text.

#### KV Cache effect

No model request depends on this package. Its sign-in notice is a frame-wide UI element whose presence or absence does not alter any model prompt or tool schema.

## Known Limitations and Deferred Work

- The notice is a prompt, not a gate: it depends on `@deepseek-ai/dsh-host-sso` being mounted and serving `/sso/status`. With the Host absent the poll reports an error state rather than a silent stall, so the banner stays visible instead of vanishing — the intended configuration always pairs the two entries.
- The poll cadence is a fixed UX constant, so a deployment that needs a different rhythm must change the component, not the configuration.
- Token freshness for consumers is bounded by that polling cadence plus the Host's refresh window, described in the Host package.
