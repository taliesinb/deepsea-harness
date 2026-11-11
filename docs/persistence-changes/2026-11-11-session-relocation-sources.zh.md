---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-11-session-relocation-sources

[English](2026-11-11-session-relocation-sources.md) | 中文

## 概述

新增 session-move、session-copy 和 session-import 三种归属来源类型，用于会话被移动、复制或导入后留给其 Agent 的下一步通知。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

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
## 兼容性

已有日志不变，也从不需要这些类型；新读取方把它们的缺失视为没有待处理的通知。三种类型都带有 @persistenceAttribution 限定：它们是通知，其文本就是模型可见的内容，不施加任何校验、回放或权限要求。只有移动的写入方会读取自己的类型，用于替换仍待处理的移动通知。较旧的 V4 读取方接受任意非空的 user 或 developer 来源类型，并原样保留来源。Chat 按 notice 形式渲染，并以类型作为标签。标题推导只考虑 user 类型的消息，提供方适配器只发送内容。因此被移动、复制或导入的日志仍可读取，Agent 仍能看到通知。SESSION_FORMAT_VERSION 保持为 4。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/api/session-controller/tests/move.host.spec.ts packages/api/session-controller/tests/copy.host.spec.ts packages/api/session-controller/tests/import.host.spec.ts packages/session/session-persistence-jsonl/tests/relocate.spec.ts packages/core/session/tests/session.spec.ts：5 个文件、106 个测试通过，包括带通知的导入日志的严格恢复，以及替换待处理的移动通知。pnpm exec vitest run packages/session-query/session-log-export/tests/import.host.spec.ts packages/session-query/session-log-export/tests/route.host.spec.ts packages/client/ui-chat/tests/event-projection.client.spec.ts：3 个文件、17 个测试通过。

<a id="dev-note"></a>
## 开发备注

无。
