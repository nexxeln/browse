import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { McpSchema } from "effect/ai"
import "../src/mcp.ts"
import { buildRegisteredMcpTools, callerSessionId, createMcpToolContext } from "../src/mcp/registry.ts"
import type * as RelayClient from "../src/relay/client.ts"
import { FakeExtension, startRelay, stopRelay, until } from "./relay-harness.ts"
import { manageCall, mcpStdio, resultJson, resultText, type McpReply } from "./support/mcp-stdio.ts"

// OpenCode runs one MCP server per server config and process, shared by every agent session and subagent, and names
// the calling agent in each tools/call's _meta. Each named agent gets its own current session; calls that name no
// agent share one, as when a client runs a parent agent and its subagents through one server without naming them.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "browse-mcp-callers-"))
afterAll(() => fs.rmSync(home, { recursive: true, force: true }))

const modernMeta = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": { name: "test", version: "0" },
}
const agent = (sessionID: string) => ({ "ai.opencode/sessionID": sessionID })
/** The JSON a tool behind `manage` answered with. */
const answered = (reply: McpReply) => {
  expect(reply.result?.isError, JSON.stringify(reply)).toBe(false)
  return resultJson(reply)
}

/** A paired fake browser whose every new tab gets its own id and target, and that records each cleanup it's asked for. */
async function browser(port: number) {
  let next = 10
  const cleanups: Array<Record<string, unknown> | undefined> = []
  const frame = (tabId: unknown) => ({ id: `T${tabId}`, loaderId: "L", url: "about:blank", securityOrigin: "null", mimeType: "text/html" })
  const extension = new FakeExtension(home, port)
    .on("tabs.create", () => ({ tabId: ++next }))
    .on("Target.getTargetInfo", (command) => ({
      targetInfo: { targetId: `T${command.params?.tabId}`, type: "page", title: "", url: "about:blank", attached: true, browserContextId: "CTX" },
    }))
    .on("Page.getFrameTree", (command) => ({ frameTree: { frame: frame(command.params?.tabId) } }))
    .on("tabs.cleanup", (command) => {
      cleanups.push(command.params)
      return { closed: [] }
    })
  expect(await extension.pair()).toBe(true)
  return { extension, cleanups }
}

async function initialized(port: number) {
  const mcp = mcpStdio({ home, port })
  await mcp.request("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "opencode", version: "0" } })
  mcp.notify("notifications/initialized")
  return mcp
}

describe("one MCP server shared by several agents", () => {
  test("tabs_cleanup only sends established sessions that haven't been deleted", async () => {
    const relay = {
      sessions: Effect.succeed([{ id: "one" }, { id: "two" }]),
      sessionDelete: (id: string) => Effect.succeed({ id, deleted: true }),
      tabsCleanup: (_minutes: number, sessions: string[]) => Effect.succeed(sessions),
    } as unknown as RelayClient.Interface
    const ctx = createMcpToolContext({ relay, currentSession: { id: "implicit", established: false }, packageRoot: home })
    const tools = buildRegisteredMcpTools(ctx)
    expect(tools.map((tool) => tool.name)).toEqual(["execute", "manage"])
    // The session tools sit behind manage, which answers with the tool that handled the call and its value.
    const manage = tools.find((tool) => tool.name === "manage")!
    const call = (name: string, args = {}, id = "agent-a") => Effect.runPromise(manage.handle({ tool: name, args }).pipe(
      Effect.map((value) => manage.route!(value)),
      Effect.tap((routed) => Effect.sync(() => expect(routed.spec.name).toBe(name))),
      Effect.map((routed) => routed.value),
      Effect.provideService(McpSchema.McpRequestContext, { clientId: 1, protocolVersion: "2025-11-25", clientCapabilities: {}, requestMetadata: agent(id) }),
    ))
    expect(await call("tabs_cleanup")).toEqual([])
    await call("session_use", { id: "one" })
    await call("session_use", { id: "one" }, "agent-b")
    await call("session_use", { id: "two" })
    await call("session_delete", { id: "one" })
    expect(await call("tabs_cleanup")).toEqual(["two"])
    expect(await call("tabs_cleanup", {}, "agent-b")).toEqual([])
    await call("session_delete")
    expect(await call("tabs_cleanup")).toEqual([])
  })

  test("recent callers keep their selected session while stale callers fall back to their own implicit id", async () => {
    const ctx = createMcpToolContext({ relay: {} as RelayClient.Interface, currentSession: { id: "implicit", established: false }, packageRoot: home })
    const caller = (id: string) => Effect.runSync(ctx.caller.pipe(Effect.provideService(McpSchema.McpRequestContext, {
      clientId: 1, protocolVersion: "2025-11-25", clientCapabilities: {}, requestMetadata: agent(id),
    })))
    ctx.establishCurrentSession(caller("stale"), "old-work")
    ctx.establishCurrentSession(caller("active"), "current-work")
    for (let i = 0; i < 2048; i++) { caller(String(i)); caller("active") }
    expect(caller("active").id).toBe("current-work")
    expect(caller("stale").id).toBe(callerSessionId("stale"))
  })

  test("each agent session has its own current session, derived from its id on every server", async () => {
    const relay = await startRelay(home)
    const servers: Array<ReturnType<typeof mcpStdio>> = []
    try {
      const first = await initialized(relay.port)
      servers.push(first)
      const status = async (mcp: ReturnType<typeof mcpStdio>, meta?: Record<string, unknown>) =>
        answered(await mcp.request("tools/call", { ...manageCall("status"), ...(meta ? { _meta: meta } : {}) })).currentSession
      const a = await status(first, agent("ses_agent_a"))
      const b = await status(first, agent("ses_agent_b"))
      const shared = await status(first)
      expect(a).toBe(callerSessionId("ses_agent_a"))
      expect(b).toBe(callerSessionId("ses_agent_b"))
      expect(a).toMatch(/^mcp-[0-9a-f]{8}$/)
      expect(new Set([a, b, shared]).size).toBe(3)
      expect(await status(first)).toBe(shared)
      // A new server (an update swap, or opencode restarting) derives the same session for the same agent.
      const second = mcpStdio({ home, port: relay.port })
      servers.push(second)
      expect(await status(second, { ...modernMeta, ...agent("ses_agent_a") })).toBe(a)
    } finally {
      for (const mcp of servers) mcp.close()
      await stopRelay(relay.child)
    }
  }, 30_000)

  test("bare calls, session_new and tabs_cleanup stay with the calling agent", async () => {
    const relay = await startRelay(home)
    const { extension, cleanups } = await browser(relay.port)
    const mcp = await initialized(relay.port)
    const call = async (tool: string, args: Record<string, unknown>, sessionID?: string) =>
      answered(await mcp.request("tools/call", { ...manageCall(tool, args), ...(sessionID ? { _meta: agent(sessionID) } : {}) }))
    // An execute result no longer names its session, so each bare execute marks the state of the session it runs in
    // and the session list says where the mark landed.
    const ranIn = async (mark: string, sessionID?: string) => {
      const reply = await mcp.request("tools/call", {
        name: "execute",
        arguments: { code: `state.${mark} = true; return "${mark}"` },
        ...(sessionID ? { _meta: agent(sessionID) } : {}),
      })
      expect(reply.result?.isError, JSON.stringify(reply)).toBe(false)
      expect(reply.result).not.toHaveProperty("structuredContent")
      const text = resultText(reply)
      expect(text.split("\n")[0]).toBe(mark)
      expect(text).not.toMatch(/mcp-[0-9a-f]{8}|a-work/)
      const { sessions } = await call("session_list", {}) as { sessions: Array<{ id: string; stateKeys: string[] }> }
      return sessions.filter((session) => session.stateKeys.includes(mark)).map((session) => session.id)
    }
    try {
      // status says whether this caller shares its current session with every other unnamed caller.
      expect(await call("status", {}, "ses_a")).toMatchObject({ sharedSession: false })
      expect(await call("status", {})).toMatchObject({ sharedSession: true })

      // Two agents' bare executes land in two sessions, each on its own tab.
      expect(await ranIn("one", "ses_a")).toEqual([callerSessionId("ses_a")])
      expect(await ranIn("two", "ses_b")).toEqual([callerSessionId("ses_b")])
      const tabs = extension.commands.filter((command) => command.method === "tabs.create")
      expect(tabs).toHaveLength(2)

      // One agent's session_new is its own: the other's bare execute stays where it was.
      expect(await call("session_new", { id: "a-work" }, "ses_a")).toMatchObject({ session: { id: "a-work" } })
      expect(await ranIn("three", "ses_b")).toEqual([callerSessionId("ses_b")])
      expect(await ranIn("four", "ses_a")).toEqual(["a-work"])

      // Calls that name no agent keep sharing one session, which session_use moves for all of them, as before.
      expect(await call("session_use", { id: "a-work" })).toEqual({ currentSession: "a-work" })
      expect(await ranIn("five")).toEqual(["a-work"])
      expect(await ranIn("six", "ses_b")).toEqual([callerSessionId("ses_b")])

      // idleMinutes: 0 from agent A covers A's tabs only (its first session's and a-work's); B's wait for the setting.
      await call("tabs_cleanup", { idleMinutes: 0 }, "ses_a")
      expect(await until(() => cleanups.length === 1)).toBe(true)
      const own = cleanups[0]?.own as { tabIds: number[]; idleMinutes?: number }
      expect(cleanups[0]).not.toHaveProperty("idleMinutes")
      expect(own.idleMinutes).toBe(0)
      expect([...own.tabIds].sort((a, b) => a - b)).toEqual([11, 13])
      // The CLI and the status page have no agent: theirs stays a sweep of every agent tab.
      await fetch(`http://127.0.0.1:${relay.port}/tabs/cleanup`, {
        method: "POST",
        headers: { authorization: `Bearer ${relay.token}`, "content-type": "application/json" },
        body: JSON.stringify({ idleMinutes: 0 }),
      })
      expect(await until(() => cleanups.length === 2)).toBe(true)
      expect(cleanups[1]).toEqual({ idleMinutes: 0 })
    } finally {
      extension.close()
      mcp.close()
      await stopRelay(relay.child)
    }
    // Each execute ends by reading the page for its page view. The fake browser never answers that read, so every
    // execute here waits out the read's budget (about 6 s) before it answers.
  }, 90_000)
})
