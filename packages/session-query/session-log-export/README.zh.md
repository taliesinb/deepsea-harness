---
description: "Web 会话日志 ZIP 导出：Host 流式传输、认证下载路由、Session Header 操作与 /export 命令。"
kind: "package-reference"
---

# @deepseek-ai/dsh-session-log-export

[English](README.md) | 中文

## 概述

`dsh-session-log-export` 让 Web 界面可以下载会话的完整历史：Session Header 更多操作按钮下的 `下载 Session 日志` 菜单项与 `/export` 斜杠命令都会把会话树——会话本身、其子会话与附件——作为 ZIP 交给浏览器下载。本包拥有 Host 归档流、经过认证的 Fetch 路由以及浏览器控件和反馈。下载目标位置由浏览器选择。设置与用法在前，随后说明实现细节。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

当 Web bundle 需要让用户导出会话日志时使用本包。它需要 Connection、命令注册表、Session 查询与持久化以及附件服务。挂载插件，然后在 Session Header 的更多操作菜单中选择 `下载 Session 日志` 或输入 `/export`；浏览器会下载 `dsh-session-<id>.zip`。

挂载 `ui-message-feedback` 时，同一菜单还提供“反馈”，打开已有的 Session 反馈弹窗。打开或关闭该弹窗不会导出 Session 或提交反馈。反馈入口随反馈插件的可用状态显示；导出功能保持独立可用。

### 何时选择

为需要带可见下载弹窗的面向用户的会话导出的 Web 部署选择它。需要程序化或 Host 侧导出时避免使用：本包产生的是浏览器下载，而非 Host 路径写入。日志从持久化读句柄序列化而来，因此任何已挂载后端都受支持。

### 组合

```yaml
- id: session-log-download
  name: '@deepseek-ai/dsh-session-log-export'
```

Web bundle 将本包与 Connection、`dsh-commands`、`dsh-client-ui-commands` 和 `dsh-client-ui-conversation` 一起挂载。

### 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `compressionLevel` | `6` | 每个 ZIP 条目的 DEFLATE 级别，范围为 0 到 9。 |

### 命令约定

| 输入 | 结果 |
|---|---|
| `/export` | 记录用户命令的生命周期；提交命令的浏览器下载文档相对的 `api/session.export?sessionId=<id>&includeDescendants=true`（Host 路由 `/api/session.export`） |
| `/export <path>` | 错误；浏览器下载通过浏览器的普通下载行为选择目标位置 |

### 导入路由

同一插件还挂载跨主机移动的接收端：`POST /api/session.import?workspaceId=<id>`（或 `?cwd=<dir>`，途中把已有目录注册为 Workspace），请求体为导出的 ZIP。路由解压归档后交给 [Session Controller](../../api/session-controller/README.zh.md)，由它解码、重新标识并存储日志，因此该路由还需要 Session Controller、Workspace 注册表与附件服务。任何受支持格式 generation 的日志都会被严格还原，并以该 Workspace 的路径作为 cwd 存为其 Session；历史 generation 会借助同一归档中其子孙的目录证据迁移。`media/` 与 `files/` 条目经附件存储保存，内容寻址保证日志中的引用仍然有效。导出的 id 若在本机已存在，则换成新 id（`keepIds=false` 替换所有 id），并对整个家族重新标识：子孙重新挂到新父会话下，父会话的 `subagent/catalog` 事实改为新的子 id，而为旧 id 记录的当前 generation `session-log-deepseek/delivery-accepted` 水位在同一 seq 上变成可忽略的 `session-transfer/foreign-delivery-accepted` 记录，使新 id 的日志从头开始上传。根 Session 会收到一条 `agent/inbox/spliced` next-step 通知（来源 kind 为 `session-import`），说明来源（`origin=`，默认 "another DSH host"），让其 Agent 知道先前的文件引用可能无法解析；`notify=false` 省略该通知。`mode=copy` 把归档存为一个副本，原会话继续存在：所有 id 都是新的，进行中的回合以中断方式闭合，或在 `truncate=true` 时被丢弃，`title=` 为副本命名，通知说明这是一个副本。响应为 `{ sessionId, imported: [{ sessionId, exportedId, parentSessionId? }], attachments, truncated }`。格式错误的归档回答 422，未知 Workspace 回答 404，超过 256 MiB 的归档回答 413。`importSessionZip(ctx, zip, target)` 以函数形式提供同一导入，`storeSessionLogs(ctx, { root, children }, target)` 则把已解析的日志交给同一存储半部。

### 预期行为

弹窗报告三个阶段：准备中、开始下载或失败。关闭弹窗不会取消正在进行的下载，该操作随后结束时弹窗也不会重新打开。每个会话同时只允许一项下载，重复操作共用该任务。导出包含实时会话的最新事件：Host 端点在读取前会 flush 活动的根会话，因此斜杠命令触发的 ZIP 会包含启动下载的 `command/run` 与 `command/done` 事件对；非活动的持久化会话不需要 flush。每份逻辑日志在归档中使用当前 generation 的规范文件名（v0 为 `session.jsonl`，其他版本为 `session.vN.jsonl`），每个子会话目录下也遵循同一规则。图片使用 `media/<attachmentId>.<ext>`，通用文件使用 `files/<digest-prefix>/<digest>/<name>`。通用文件以有界分块读取并压缩，因此导出大型上传文件时不会把它完整缓冲进内存。

附件收集读取内置 Session 事件声明的内容字段与已完成的 assistant 流块，包括扁平的 V4 tool 角色消息。未知事件载荷与无关字段在导出日志中保持不变，但不会触发附件读取。

### 失败

当 ZIP 流式传输开始前的预检失败时——例如 Host 端点不可达或配置错误——弹窗显示准备阶段错误。浏览器接受 GET 后发生的子会话或附件读取失败由浏览器下载管理器报告，不通过弹窗报告。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释本包如何接入导出控件，并指出实现它的代码位置；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计拆分

本包分为两部分。Host 半包（[`src/index.ts`](src/index.ts)）注册 `/export` 命令，并向 Connection 贡献精确的 `GET`/`HEAD /api/session.export` Fetch 路由；[`src/archive.ts`](src/archive.ts) 构建有界 ZIP 流。浏览器半包（[`src/client/index.ts`](src/client/index.ts)）提供共享下载控制器和 UI，并观察 `command/executed`，因此只有提交命令的浏览器会启动下载。

Header 的更多操作入口使用公共紧凑 Button，点击区域为 28px 正方形，与右侧栏展开控件共用圆角和 hover 底色。

### 下载流程

两条入口都会先向文档相对的 `api/session.export?...` 发出 `HEAD` 预检请求，然后把 GET 路由交给浏览器下载管理器，JavaScript 不缓冲 ZIP。一个控制器按会话持有一项进行中的下载，把并发操作折叠进该任务，并在插件释放时取消预检。弹窗状态存放在按会话键控的快照存储中，因此按钮与命令按会话共享一个弹窗。

Host 路由是由该功能拥有的精确 Fetch 路由贡献。Connection 应用 Host/Origin 与浏览器会话检查并桥接流式 `Response`；本包拥有查询校验、活动会话 flush、基于句柄的日志读取与附件读取、ZIP 生成和 HTTP 状态语义。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从 Web 控件逐步进入 Host 端点及相关的命令与会话接口。

- [dsh-client-connection](../../client/connection/README.zh.md)——Host 端点使用的认证 Fetch 路由载体。
- [命令子系统参考](../../../docs/subsystems/commands.zh.md)——`/export` 命令注册的用户命令注册表。
- [dsh-client-ui-commands](../../client/ui-commands/README.zh.md)——渲染并确认 `/export` 的浏览器命令界面。
- [会话查询包映射](../README.zh.md)——本包所属的检索包族。

-----

<a id="model-experience"></a>
## 模型体验

### 用户 `/export` 控制

#### 模型看到什么

无。`/export` 留在用户命令平面，ZIP 下载不会进入模型历史。

#### Token 影响

为零。该命令不创建模型轮次。

#### KV Cache 影响

无。仅日志命令生命周期与浏览器下载不会改变派生请求前缀。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明本包何时不合适，或何时需要特别的运维注意。它们是当前包约束，不是任务积压。

- **浏览器下载，而非 Host 路径写入**——目标位置由浏览器选择；不会返回 Host 路径或原生文件夹操作。
- **预检只报告流式传输前的失败**——浏览器接受 GET 后发生的子会话或附件读取失败由浏览器下载管理器报告，不通过弹窗报告。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文：开放设计问题与尚未决定的探索方向。它明确不具权威性——已交付的行为、限制与既定理由以上文、包代码和相关页面为准。

#### 未来：浏览器之外的导出目标

下载刻意限定在浏览器范围；Host 路径或原生文件夹导出需要新的端点约定，并决定 ZIP 的落盘位置。

</details>
