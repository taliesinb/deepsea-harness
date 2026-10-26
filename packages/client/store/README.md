---
description: "Observable browser state stores with explicit snapshots, subscriptions, and lifecycle ownership."
kind: "package-library"
---
# @deepseek-ai/dsh-client-store

English | [中文](README.zh.md)

## Summary

React-free observable and snapshot-store primitives shared by Client controllers and renderer adapters. The package owns synchronous and animation-frame publication, Immer-backed updates, shallow equality, and optional browser persistence; React hook construction remains in `@deepseek-ai/dsh-client-ui-renderer`. Use it when Client state must publish stable snapshots without depending on React.

The package also carries the page presentation mode. The web boot kernel calls `setEmbedPresentation({ sessionId })` before any plugin activates when the page URL selects one embedded Session (`?embed=<sessionId>`); `embedPresentation()` reports it to shell plugins, and `persistenceKey(name)` prefixes every persisted store name with `embed:<sessionId>:` while it is set. An embedded shell shares its framer's origin, and therefore `localStorage`, so this namespace keeps its selection, drafts, and preferences apart from the framing page's; the ordinary shell keeps names verbatim.

## Table of Contents

- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="model-experience"></a>
## Model Experience

None, as this package provides browser-side state primitives and registers nothing model-facing.

#### KV Cache effect

None; the stores neither assemble nor send model requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Persistence is browser-local** — persisted stores use JSON in `localStorage`; non-browser runtimes disable persistence, and the package provides no cross-device synchronization.
- **Web-shell build input** — the static ESM retains third-party imports for Vite; independent consumers supply its development dependencies ([dependency rules](../AGENTS.md#dependency-declaration)).


<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
