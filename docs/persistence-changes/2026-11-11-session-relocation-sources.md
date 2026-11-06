---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-11-session-relocation-sources

English | [中文](2026-11-11-session-relocation-sources.zh.md)

## Summary

Adds the session-move, session-copy and session-import attribution kinds for the next-step notices that moved, copied and imported Sessions leave for their Agent.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-11-session-relocation-sources
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-13-liveshare-share-viewer-principal"
    after: "7b2d8afa6eab67b72621b0f45e6440003b07885a153f815881fbbf1c5be3c1ca"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-13-liveshare-share-viewer-principal"
    after: "93b5bf5ea40025ee79805a110c516872f1b39b3b0d6edc77e6d172da4a1a5afe"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-13-liveshare-share-viewer-principal"
    after: "f80b76d060368545abf40b2a582fddee0e06e9544274d59509518263f32024d5"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-13-liveshare-share-viewer-principal"
    after: "e658e5487b7222b373e79a7e4801f1e6d6e1bb5fcb377ecdb2efda9c134d3c6f"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing logs are unchanged and never require these kinds; the new reader treats their absence as no pending notice. All three kinds are qualified with @persistenceAttribution: they are notices whose text is the model-visible content, and they impose no validation, replay, or authority requirement. Only the move producer reads its own kind, to replace a move notice that is still pending. An older V4 reader accepts any non-empty user or developer source kind and keeps the source unchanged. Chat renders the notice form with the kind as its label. Title derivation considers only user-kind messages, and provider adapters send only the content. A moved, copied or imported log therefore stays readable, and the Agent still sees the notice. SESSION_FORMAT_VERSION stays 4.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/api/session-controller/tests/move.host.spec.ts packages/api/session-controller/tests/copy.host.spec.ts packages/api/session-controller/tests/import.host.spec.ts packages/session/session-persistence-jsonl/tests/relocate.spec.ts packages/core/session/tests/session.spec.ts: 5 files and 106 tests passed, including strict restore of imported logs with the notice and replacement of a pending move notice. pnpm exec vitest run packages/session-query/session-log-export/tests/import.host.spec.ts packages/session-query/session-log-export/tests/route.host.spec.ts packages/client/ui-chat/tests/event-projection.client.spec.ts: 3 files and 17 tests passed.

<a id="dev-note"></a>
## Dev Note

None.
