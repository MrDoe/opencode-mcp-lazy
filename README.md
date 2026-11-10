# opencode-mcp-lazy

OpenCode V2 plugin: **MCP servers connect on demand, not at startup.**

OpenCode connects to every enabled MCP server when a location opens — local
(stdio) servers spawn a child process each, remote ones get a connection and a
tool-catalog fetch. Most sessions use zero or one of the configured servers.
This plugin keeps every configured server **disconnected** until an agent
explicitly loads it, and can disconnect it again after idle time.

Built on the public plugin API only: `ctx.mcp.transform` + `ctx.mcp.reload()`
(`disabled` reconciliation), `ctx.tool.transform`, `ctx.tool.hook`.

## What you get

| Tool | Purpose |
| --- | --- |
| `mcp.load` | Connect a configured server by name. Waits until connected, then tells the agent where its tools live. |
| `mcp.unload` | Disconnect it again — child process dies, tools vanish, RAM freed. |
| `mcp.status` | Every configured server with lazy state, live status, and idle minutes. |

Servers are exposed through OpenCode's default Code Mode, so the tools appear
as `tools.mcp.load(...)` / `tools.mcp.unload(...)` / `tools.mcp.status()` and
cost nothing in the prompt beyond one catalog line. After `mcp.load`, the
loaded server's own namespace (e.g. `tools.mssql.execute_sql`) appears in the
catalog mid-session — OpenCode hot-reconciles from the transformed config.

## Setup

```sh
git clone https://github.com/MrDoe/opencode-mcp-lazy
cd opencode-mcp-lazy && npm install
```

Add to `~/.config/opencode/opencode.jsonc` (global) or a project config:

```jsonc
{
  "plugins": [
    {
      "package": "C:/path/to/opencode-mcp-lazy",
      "options": {
        "alwaysOn": ["starlims"],
        "lazyOnly": ["mssql", "mssqlProd"],
        "ttlMinutes": 45
      }
    }
  ]
}
```

Config changes hot-apply — no restart needed.

### Options

| Option | Default | Meaning |
| --- | --- | --- |
| `alwaysOn` | `[]` | Server names the plugin never disconnects (e.g. the one you use every session). |
| `lazyOnly` | *(all)* | If set, only these names go lazy; everything else is left alone. |
| `ttlMinutes` | `0` | Auto-disconnect a loaded server after this many idle minutes. `0` = keep loaded until unloaded manually. |

Any server already `disabled`/`enabled: false` in your config is left as is.
Uninstall = remove the plugin entry: your original config semantics return.

## Agent guidance (minimal, copy-paste for AGENTS.md)

```markdown
MCP fleet is lazy: if `tools.<server>.*` is missing from the Code Mode catalog, call
`tools.mcp.load({server:"<server>"})` first; `tools.mcp.status()` lists servers, `tools.mcp.unload` frees RAM.
```

That single line is all an agent needs — the tool descriptions carry the rest.

## Interaction notes

- The plugin's transform replays its loaded-set on every `reload()`, including
  after config hot-reloads, so lazy state survives config edits.
- A connect failure keeps the server lazy-off; the load result says so and the
  agent can retry.
- `/mcps` UI disconnects are runtime-only in core, this plugin's state is
  per-location and per-service-restart: after a service restart everything is
  lazy again. That is the point.
- Subagents inherit their session's location, so they see the same state.

## License

MIT
