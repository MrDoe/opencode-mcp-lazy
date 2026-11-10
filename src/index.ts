import { Plugin } from "@opencode/plugin"

/**
 * mcp-lazy: keep configured MCP servers disconnected until explicitly loaded.
 *
 * How it works: a ctx.mcp.transform forces `disabled: true` on every lazy
 * server. OpenCode reconciles the server lifecycle from the transformed
 * config, so nothing spawns/ connects at startup. The `load` tool flips the
 * flag via state + reload(); OpenCode then connects and the tool catalog
 * hot-updates. Optional TTL disconnects servers again after inactivity.
 *
 * Options (plugin entry in opencode.json(c)):
 *   alwaysOn:   string[]  — server names the plugin never touches
 *   lazyOnly:   string[]  — if set, only these names are lazy (whitelist)
 *   ttlMinutes: number    — auto-unload after this idle time; 0 = never
 */

type ServerState = { loadedAt: number; lastUsed: number }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export default Plugin.define({
  id: "mcp-lazy",
  async setup(ctx) {
    const opts = (ctx.options ?? {}) as {
      alwaysOn?: string[]
      lazyOnly?: string[]
      ttlMinutes?: number
    }
    const alwaysOn = new Set(opts.alwaysOn ?? [])
    const lazyOnly =
      opts.lazyOnly && opts.lazyOnly.length ? new Set(opts.lazyOnly) : null
    const ttlMs = (opts.ttlMinutes ?? 0) * 60_000

    const loaded = new Map<string, ServerState>()
    const known = new Set<string>()

    const isLazy = (name: string) =>
      !alwaysOn.has(name) && (lazyOnly ? lazyOnly.has(name) : true)

    // Effective "disconnected" state tolerates both V2 `disabled` and V1 `enabled`.
    const isOff = (cfg: any) => cfg?.disabled === true || cfg?.enabled === false

    // Single source of truth for lazy state: transform replays `loaded` map.
    await ctx.mcp.transform((editor: any) => {
      known.clear()
      for (const [name, cfg] of editor.list() as readonly (readonly [string, any])[]) {
        known.add(name)
        if (!isLazy(name)) continue
        const wantOff = !loaded.has(name)
        if (isOff(cfg) !== wantOff) {
          editor.update(name, (c: any) => {
            c.disabled = wantOff
            if (c.enabled !== undefined) c.enabled = !wantOff
          })
        }
      }
    })

    const serverStatus = async (
      name: string,
    ): Promise<{ found: boolean; raw: any }> => {
      const out: any = await ctx.mcp.list()
      const servers: any[] = out?.data ?? (Array.isArray(out) ? out : [])
      const entry = servers.find((s: any) => s?.name === name)
      return { found: !!entry, raw: entry }
    }

    const anyStatusString = (raw: any): string => {
      if (!raw) return "unknown"
      for (const k of ["status", "state", "connection", "lifecycle"]) {
        if (typeof raw[k] === "string") return raw[k]
      }
      if (raw?.status && typeof raw.status === "object") {
        for (const v of Object.values(raw.status)) {
          if (typeof v === "string") return v
        }
      }
      return JSON.stringify(raw)
    }

    const doLoad = async (name: string, timeoutMs = 40_000) => {
      if (!known.has(name)) {
        return {
          ok: false,
          text: `Unknown MCP server "${name}". Configured servers: ${[...known].join(", ") || "(none)"}.`,
        }
      }
      const now = Date.now()
      loaded.set(name, { loadedAt: now, lastUsed: now })
      await ctx.mcp.reload()
      // Wait for the connect to finish (startup timeout default is 30 s).
      let raw: any
      const deadline = Date.now() + timeoutMs
      for (;;) {
        const st = await serverStatus(name)
        raw = st.raw
        const s = anyStatusString(raw).toLowerCase()
        if (s.includes("connect") && !s.includes("disconnect") && !s.includes("failed")) break
        if (s.includes("failed") || s.includes("error")) break
        if (Date.now() > deadline) break
        await sleep(500)
      }
      const status = anyStatusString(raw)
      const ok = status.toLowerCase().includes("connect") && !status.toLowerCase().includes("disconnect")
      return {
        ok,
        text: ok
          ? `MCP server "${name}" connected. Its tools are now available: Code Mode namespace "${name}.*" (discover via the Code Mode search) or native tools "${name}_*".`
          : `MCP server "${name}" requested to connect; current status: ${status}. Retry or check ~/.local/share/opencode/log/opencode.log.`,
      }
    }

    const doUnload = async (name: string) => {
      if (!loaded.has(name)) {
        return { ok: false, text: `MCP server "${name}" is not loaded by mcp-lazy (never loaded or already unloaded).` }
      }
      loaded.delete(name)
      await ctx.mcp.reload()
      const st = await serverStatus(name)
      return {
        ok: true,
        text: `MCP server "${name}" unloaded (disconnect requested). Status: ${anyStatusString(st.raw)}. Its tools and processes are gone; call mcp.load to bring it back.`,
      }
    }

    // Register the broker tools (Code Mode by default — zero prompt cost otherwise).
    await ctx.tool.transform((editor: any) => {
      editor.namespace({
        name: "mcp",
        description:
          "Lazy MCP fleet control (mcp-lazy plugin): configured servers start disconnected; load them on demand.",
      })
      editor.add({
        name: "load",
        description:
          "Connect a configured MCP server that mcp-lazy keeps disconnected. Call this before using tools.<server>.* when that namespace is missing from the Code Mode catalog. Optional timeoutSeconds for slow local spawns (default 40).",
        input: {
          type: "object",
          properties: {
            server: { type: "string", description: "Exact MCP server name, e.g. mssql." },
            timeoutSeconds: { type: "number" },
          },
          required: ["server"],
          additionalProperties: false,
        },
        options: { namespace: "mcp" },
        execute: async (input: any) => {
          const r = await doLoad(String(input.server), (input.timeoutSeconds ?? 40) * 1000)
          return { content: r.text }
        },
      })
      editor.add({
        name: "unload",
        description:
          "Disconnect an MCP server previously loaded via mcp.load. Kills its local process, frees RAM, removes its tools until reloaded.",
        input: {
          type: "object",
          properties: {
            server: { type: "string", description: "Exact MCP server name." },
          },
          required: ["server"],
          additionalProperties: false,
        },
        options: { namespace: "mcp" },
        execute: async (input: any) => {
          const r = await doUnload(String(input.server))
          return { content: r.text }
        },
      })
      editor.add({
        name: "status",
        description:
          "List all configured MCP servers with their lazy state and live connection status.",
        input: { type: "object", properties: {}, additionalProperties: false },
        options: { namespace: "mcp" },
        execute: async () => {
          const out: any = await ctx.mcp.list()
          const servers: any[] = out?.data ?? (Array.isArray(out) ? out : [])
          const lines = servers.map((s: any) => {
            const name = s?.name ?? "?"
            const lazy = isLazy(name)
            const err = s?.status?.error ? ` — ${String(s.status.error).slice(0, 120)}` : ""
            const idleMin = loaded.has(name)
              ? Math.round((Date.now() - loaded.get(name)!.lastUsed) / 60_000)
              : null
            return `- ${name}: ${anyStatusString(s)}${err}${
              lazy ? ` [lazy${loaded.has(name) ? `, loaded, idle ${idleMin} min` : ""}]` : " [always-on]"
            }`
          })
          return {
            content:
              `mcp-lazy (ttl=${opts.ttlMinutes ?? 0} min, alwaysOn=[${[...alwaysOn].join(", ")}]):\n` +
              (lines.join("\n") || "(no MCP servers configured)"),
          }
        },
      })
    })

    // Activity tracking: any tool call that mentions a loaded server refreshes it.
    await ctx.tool.hook("execute.before", (event: any) => {
      if (loaded.size === 0) return
      let hay = ""
      try {
        hay = String(event?.tool ?? "") + JSON.stringify(event?.input ?? "")
      } catch {
        return
      }
      const now = Date.now()
      for (const [name, st] of loaded) {
        if (
          hay.includes(`${name}_`) ||
          hay.includes(`${name}.`) ||
          hay.includes(`"${name}"`)
        ) {
          st.lastUsed = now
        }
      }
    })

    let timer: ReturnType<typeof setInterval> | undefined
    if (ttlMs > 0) {
      timer = setInterval(() => {
        const now = Date.now()
        for (const [name, st] of [...loaded]) {
          if (now - st.lastUsed > ttlMs) {
            console.log(`mcp-lazy: unloading idle server "${name}"`)
            void doUnload(name).catch(() => {})
          }
        }
      }, 60_000)
      ;(timer as any).unref?.()
    }

    console.log(
      `mcp-lazy loaded: lazy servers will be disconnected; ttl=${opts.ttlMinutes ?? 0}min alwaysOn=[${[...alwaysOn].join(",")}]`,
    )

    return () => {
      if (timer) clearInterval(timer)
    }
  },
})
