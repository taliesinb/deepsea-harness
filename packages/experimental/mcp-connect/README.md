---
description: "Model tools that connect MCP servers to one Session after user approval, including servers a project's .mcp.json declares."
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-mcp-connect

English | [中文](README.zh.md)

## Summary

Let a model connect an MCP server to its own Session instead of the whole profile. `mcp_connect` starts a server the model describes, or one a project `.mcp.json` declares, after the user approves it; its tools reach only the calling Agent and return when the Session resumes. `mcp_list` shows connected, profile, and declared servers, and `mcp_disconnect` stops one.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Select the bundle in `dsh.profile.bundles`, or mount the function plugin after the tool registry, Agent registry, working-directory service, and Session projection registry. The profile also needs [user approval](../../interaction/user-approval/README.md) with an answerer; without one every connection is refused.

```yaml
- name: '@deepseek-ai/dsh-experimental-mcp-connect'
  config:
    startupTimeoutMs: 120000
    projectFiles: true
```

| Config | Default | Meaning |
|---|---|---|
| `startupTimeoutMs` | `120000` | Longest wait for a server to start and list its tools; the server is stopped when it passes. |
| `projectFiles` | `true` | Read `.mcp.json` files so `mcp_connect` accepts a declared server by name and `mcp_list` lists them. |

`mcp_connect({ name })` connects the server `name` from the nearest `.mcp.json`. The search covers the Session working directory and its ancestors up to the nearest directory holding `.git` (only the working directory when there is none); a nearer file's entry hides a farther one. The file uses the `mcpServers` format of Claude Code and Cursor: `{ command, args?, env?, cwd? }` for stdio, `{ type: "http", url, headers? }` for Streamable HTTP. A declared server runs in the directory of its file.

`mcp_connect({ name, command, args?, env?, cwd? })` or `mcp_connect({ name, url, headers? })` defines a server inline; a stdio server runs in the Session working directory unless `cwd` says otherwise. In both forms, strings may reference Host environment variables as `${NAME}` or `${NAME:-default}`; a reference without a value or default fails the call. A bare command is looked up on the child's `PATH` (its `env.PATH` when given). Each connection asks the user, whatever the sandbox mode: the request shows the command line or URL, the directory, the declaring file, and environment and header names, with literal values hidden.

The tools appear as `mcp__<name>__<tool>` from the model's next step, alongside the [MCP resource tools](../../mcp/mcp-resources/README.md) and any server instructions. A name outside `[A-Za-z0-9_-]{1,32}` becomes a slug with a hash suffix. A Session server whose name matches a profile server hides the profile's tools for that Agent. The [generated tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-experimental-mcp-connect) owns the exact schemas.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

[`src/index.ts`](src/index.ts) mounts one [`@deepseek-ai/dsh-mcp-client`](../../mcp/mcp-client/README.md) instance in the calling Agent's scope (`agent.ctx.plugin`) with `failOnStartupError: true`, so a server that fails to start registers nothing and leaves its name free. Turn cancellation and `startupTimeoutMs` dispose the instance, which stops its process. Agent disposal stops every server of that Agent; unloading this plugin stops every server it connected, because the instances belong to Agent scopes rather than to this plugin's fiber.

[`src/spec.ts`](src/spec.ts) validates declarations, expands `${NAME}` references against the Host environment at each connection, resolves commands, and builds the approval text. [`src/project.ts`](src/project.ts) finds and parses `.mcp.json` files.

A successful connection appends one `plugin:mcp-connect/server` record ([`src/records.ts`](src/records.ts)); a disconnection appends another. An inline record keeps the declaration as the model wrote it, references unexpanded. A project record keeps only the file, the name, and a SHA-256 of the approved declaration, because the file may hold literal secrets. A host-only Session projection folds the records. On `agent/created` with source `resume`, and for live Agents when the plugin loads, the plugin reconnects each recorded server without asking again; a project server reconnects only when its file still declares the same hash. A failed reconnection is logged and shown by `mcp_list` without failing the resume. Records a fork inherits are ignored, so a fork starts with no Session servers.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [MCP subsystem](../../../docs/subsystems/mcp.md) — the client, tool naming, resources, and limits.
- [MCP client](../../mcp/mcp-client/README.md) — transports, reconnection, and the scrubbed child environment.
- [User approval](../../../docs/subsystems/approval.md) — policies, answerers, and audit events.

-----

<a id="model-experience"></a>
## Model Experience

### Connection tools

#### What the model sees

Three tool schemas while the plugin is mounted. `mcp_connect` returns the public server name and its tool names, or an error with the next step: the missing variable, the searched directories, the refusal, or the startup failure. `mcp_list` returns JSON with `session`, `profile`, and `project` arrays. `mcp_disconnect` returns the removed tool names.

#### Token effect

The three schemas cost a fixed amount per request. Each connected server adds its tool schemas, the resource tools for the first server of an Agent, and any server instructions in the system prompt.

#### KV Cache effect

A connection adds tool declarations and changes the system prompt, because the resource section lists every connected server. Routes that accept both tool and system-prompt updates in history append the change and keep the cached prefix. Routes that accept only tool updates start a new request series and miss the cache once.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Unconfined servers** — the MCP SDK starts stdio servers directly, outside the DSH sandbox; approval is the only control.
- **No PTC exposure** — connected tools are untested in PTC mode.
- **Subagents** — a child Agent does not see its parent's Session servers and must connect its own.
- **Resume trusts the log** — reconnection on resume does not ask the user again.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
