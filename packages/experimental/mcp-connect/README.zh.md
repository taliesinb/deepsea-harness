---
description: "在用户批准后把 MCP 服务器连接到单个 Session 的模型工具，包括项目 .mcp.json 声明的服务器。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-mcp-connect

[English](README.md) | 中文

## 概述

让模型把 MCP 服务器连接到自己的 Session（会话），而不是整个 profile（配置档）。`mcp_connect` 在用户批准后启动模型描述的服务器，或项目 `.mcp.json` 声明的服务器；其工具只对调用它的 Agent 可见，并在 Session 恢复时重新连接。`mcp_list` 列出已连接、profile 提供和项目声明的服务器，`mcp_disconnect` 停止其中一个。

## 目录

- [使用本包](#use-this-package)
- [了解实现](#understand-the-implementation)
- [深入探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与待办工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在 `dsh.profile.bundles` 中选择此 bundle，或在工具注册表、Agent 注册表、工作目录服务和 Session projection（投影）注册表之后挂载此函数插件。profile 还需要带应答者的[用户批准](../../interaction/user-approval/README.zh.md)；没有应答者时每次连接都会被拒绝。

```yaml
- name: '@deepseek-ai/dsh-experimental-mcp-connect'
  config:
    startupTimeoutMs: 120000
    projectFiles: true
```

| 配置 | 默认值 | 含义 |
|---|---|---|
| `startupTimeoutMs` | `120000` | 等待服务器启动并列出工具的最长时间；超时后服务器被停止。 |
| `projectFiles` | `true` | 读取 `.mcp.json`，使 `mcp_connect` 可按名称连接声明的服务器，`mcp_list` 可列出它们。 |

`mcp_connect({ name })` 连接最近的 `.mcp.json` 中名为 `name` 的服务器。搜索范围是 Session 工作目录及其祖先目录，直到最近的含 `.git` 的目录（没有时只搜索工作目录本身）；较近文件中的条目遮蔽较远文件中的同名条目。文件采用 Claude Code 和 Cursor 的 `mcpServers` 格式：stdio 为 `{ command, args?, env?, cwd? }`，Streamable HTTP 为 `{ type: "http", url, headers? }`。声明的服务器在其文件所在目录中运行。

`mcp_connect({ name, command, args?, env?, cwd? })` 或 `mcp_connect({ name, url, headers? })` 内联定义服务器；除非给出 `cwd`，stdio 服务器在 Session 工作目录中运行。两种形式中，字符串都可以用 `${NAME}` 或 `${NAME:-default}` 引用 Host 环境变量；引用的变量无值且无默认值时调用失败。裸命令名在子进程的 `PATH`（给出 `env.PATH` 时使用它）上查找。无论沙箱模式如何，每次连接都会询问用户：请求显示命令行或 URL、目录、声明文件以及环境变量和请求头的名称，字面值被隐藏。

工具以 `mcp__<name>__<tool>` 的名称从模型的下一步开始出现，同时出现 [MCP 资源工具](../../mcp/mcp-resources/README.zh.md)和服务器说明。不符合 `[A-Za-z0-9_-]{1,32}` 的名称会变成带哈希后缀的 slug。与 profile 服务器同名的 Session 服务器会对该 Agent 遮蔽 profile 的工具。确切的 schema 以[生成的工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-experimental-mcp-connect)为准。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现细节 — 点击展开</summary>

[`src/index.ts`](src/index.ts) 以 `failOnStartupError: true` 在调用者 Agent 的作用域中（`agent.ctx.plugin`）挂载一个 [`@deepseek-ai/dsh-mcp-client`](../../mcp/mcp-client/README.zh.md) 实例，因此启动失败的服务器不注册任何内容，其名称仍可使用。取消轮次和 `startupTimeoutMs` 会销毁该实例并停止其进程。Agent 销毁时停止该 Agent 的所有服务器；卸载本插件时停止它连接的所有服务器，因为这些实例属于 Agent 作用域而不属于本插件的 fiber。

[`src/spec.ts`](src/spec.ts) 校验声明、在每次连接时按 Host 环境展开 `${NAME}` 引用、解析命令并生成批准文本。[`src/project.ts`](src/project.ts) 查找并解析 `.mcp.json`。

每次成功连接追加一条 `plugin:mcp-connect/server` 记录（[`src/records.ts`](src/records.ts)），断开连接再追加一条。内联记录按模型所写保存声明，引用不展开。项目记录只保存文件、名称和已批准声明的 SHA-256，因为文件可能含有字面密钥。一个仅 Host 的 Session projection 折叠这些记录。在来源为 `resume` 的 `agent/created` 时，以及插件加载时对已存在的 Agent，插件重新连接每个已记录的服务器而不再询问；项目服务器仅在文件仍声明相同哈希时重新连接。重连失败会被记录日志并由 `mcp_list` 显示，不会使恢复失败。fork（分叉）继承的记录被忽略，因此 fork 从没有 Session 服务器的状态开始。

</details>

-----

<a id="further-exploration"></a>
## 深入探索

- [MCP 子系统](../../../docs/subsystems/mcp.zh.md) — 客户端、工具命名、资源和限制。
- [MCP 客户端](../../mcp/mcp-client/README.zh.md) — 传输、重连和清理后的子进程环境。
- [用户批准](../../../docs/subsystems/approval.zh.md) — 策略、应答者和审计事件。

-----

<a id="model-experience"></a>
## 模型体验

### 连接工具

#### 模型看到什么

插件挂载期间有三个工具 schema。`mcp_connect` 返回公开服务器名称及其工具名称，或返回附带下一步的错误：缺失的变量、搜索过的目录、拒绝或启动失败。`mcp_list` 返回含 `session`、`profile` 和 `project` 数组的 JSON。`mcp_disconnect` 返回被移除的工具名称。

#### Token 影响

三个 schema 每次请求有固定开销。每个已连接服务器增加其工具 schema、Agent 第一个服务器带来的资源工具，以及系统提示词中的服务器说明。

#### KV Cache 影响

连接会增加工具声明并改变系统提示词，因为资源段落列出每个已连接服务器。同时支持在历史中追加工具更新和系统提示词更新的路由会追加变更并保留缓存前缀；只支持工具更新的路由会开始新的请求序列，缓存未命中一次。

## 已知限制与待办工作

<a id="known-limitations-and-deferred-work"></a>

- **服务器不受限制** — MCP SDK 直接启动 stdio 服务器，不经过 DSH 沙箱；批准是唯一的控制。
- **未暴露给 PTC** — 已连接的工具未在 PTC 模式下测试。
- **子 Agent** — 子 Agent 看不到父 Agent 的 Session 服务器，必须自行连接。
- **恢复信任日志** — 恢复时重新连接不会再次询问用户。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
