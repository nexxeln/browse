import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Schema } from "effect"
import { StatusToolOutput } from "../src/mcp/schema.ts"
import { startRelay, stopRelay } from "./relay-harness.ts"
import { manageCall, mcpStdio, resultJson, resultText } from "./support/mcp-stdio.ts"
import { freePort } from "./support/ports.ts"

// Agents see two tools: `execute`, and `manage`, which fronts every other tool and prints their arguments on request.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "browse-mcp-manage-"))
afterAll(() => fs.rmSync(home, { recursive: true, force: true }))

/** The tools `manage` routes to, in the order they are registered: the order help and the unknown-tool error list them. */
const managed = [
  "status",
  "session_new",
  "session_allowlist",
  "session_list",
  "session_use",
  "session_reset",
  "session_delete",
  "session_adopt",
  "network",
  "recording",
  "tabs_cleanup",
  "settings",
  "flight_recorder",
  "secrets_list",
  "secrets_status",
  "secrets_refresh",
  "secrets_run",
] as const

async function initialized(port: number) {
  const mcp = mcpStdio({ home, port })
  await mcp.request("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "0" } })
  mcp.notify("notifications/initialized")
  return mcp
}

describe("the manage tool", () => {
  test("the server lists exactly execute and manage, with no output schemas", async () => {
    // Nothing listens on this port: listing tools needs no relay.
    const mcp = await initialized(await freePort())
    try {
      const tools = (await mcp.request("tools/list")).result?.tools as Array<{
        name: string
        description: string
        inputSchema: Record<string, unknown>
        outputSchema?: unknown
      }>
      expect(tools.map((tool) => tool.name)).toEqual(["execute", "manage"])
      for (const tool of tools) expect(tool.outputSchema, tool.name).toBeUndefined()
      const manage = tools[1]!
      expect(manage.inputSchema).toEqual({
        type: "object",
        properties: { tool: { type: "string" }, args: { type: "object" } },
        required: ["tool"],
        additionalProperties: false,
      })
      // The description is the only place an agent learns the names before asking for help.
      for (const name of managed) expect(manage.description, name).toContain(name)
      expect(manage.description).toContain('tool "help", args { "tool": "<name>" }')
    } finally { mcp.close() }
  }, 30_000)

  test("help describes one tool and its arguments, or every tool when none is named", async () => {
    const mcp = await initialized(await freePort())
    try {
      const one = await mcp.request("tools/call", manageCall("help", { tool: "session_new" }))
      expect(one.result?.isError, JSON.stringify(one)).toBe(false)
      expect(one.result).not.toHaveProperty("structuredContent")
      const text = resultText(one)
      expect(text).toStartWith("session_new: Create a browse session and make it your current one.")
      expect(text).toContain("\nargs:\n")
      expect(text).toContain('- id: {"type":"string"} Optional lowercase session id.')
      expect(text).toContain('- allowedOrigins: {"type":"array","items":{"type":"string"}} Optional domain allowlist')
      expect(text).not.toContain("session_delete:")

      // A required argument is marked, and a tool that takes none says so.
      expect(resultText(await mcp.request("tools/call", manageCall("help", { tool: "session_use" }))))
        .toContain('- id (required): {"type":"string"} Existing browse session id.')
      expect(resultText(await mcp.request("tools/call", manageCall("help", { tool: "status" }))))
        .toBe("status: Return relay, extension, target, session, and connected browser status.\nargs: none")

      // No name, with or without `args`: every tool.
      for (const params of [manageCall("help"), { name: "manage", arguments: { tool: "help" } }]) {
        const all = await mcp.request("tools/call", params)
        expect(all.result?.isError, JSON.stringify(all)).toBe(false)
        const entries = resultText(all).split("\n\n").map((entry) => entry.slice(0, entry.indexOf(":")))
        expect(entries).toEqual([...managed])
      }
    } finally { mcp.close() }
  }, 30_000)

  test("an unknown tool is an error result naming the valid tools", async () => {
    const mcp = await initialized(await freePort())
    try {
      for (const [tool, shown] of [["session_create", "session_create"], ["execute", "execute"], ["", ""]] as const) {
        const reply = await mcp.request("tools/call", manageCall(tool))
        expect(reply.error, JSON.stringify(reply)).toBeUndefined()
        expect(reply.result?.isError, JSON.stringify(reply)).toBe(true)
        expect(resultText(reply)).toBe(`Unknown tool '${shown}'. tool is one of: help, ${managed.join(", ")}`)
      }
    } finally { mcp.close() }
  }, 30_000)

  test("manage routes status and the session tools to the results those tools gave", async () => {
    const relay = await startRelay(home)
    const mcp = await initialized(relay.port)
    try {
      const reply = await mcp.request("tools/call", manageCall("status"))
      expect(reply.result?.isError, JSON.stringify(reply)).toBe(false)
      // Text only: the JSON the status tool used to send as structured content.
      expect(reply.result).not.toHaveProperty("structuredContent")
      expect(reply.result?.content).toHaveLength(1)
      const status = resultJson<typeof StatusToolOutput.Type>(reply)
      expect(Schema.is(StatusToolOutput)(status)).toBe(true)
      expect(status.endpoint).toBe(`http://127.0.0.1:${relay.port}`)
      expect(status.version).toMatchObject({ pid: relay.child.pid! })
      expect(status.status).toMatchObject({ connected: false })
      expect(status.currentSession).toMatch(/^mcp-[0-9a-f]{8}$/)
      expect(status.sharedSession).toBe(true)
      // `args` may be left out for a tool that takes none.
      const bare = await mcp.request("tools/call", { name: "manage", arguments: { tool: "status" } })
      expect(resultJson<typeof StatusToolOutput.Type>(bare).currentSession).toBe(status.currentSession)

      // `args` reach the tool, and its failure comes back as that tool's error result.
      expect(resultJson<{ sessions: unknown[] }>(await mcp.request("tools/call", manageCall("session_list")))).toEqual({ sessions: [] })
      const missing = await mcp.request("tools/call", manageCall("session_use", { id: "missing" }))
      expect(missing.result?.isError, JSON.stringify(missing)).toBe(true)
      expect(resultText(missing)).toBe("Session not found: missing Create it with session_new first.")

      // The old names are no longer tools of their own.
      const direct = await mcp.request("tools/call", { name: "status", arguments: {} })
      expect(direct.result).toBeUndefined()
      expect(direct.error).toMatchObject({ code: -32602, message: "Tool 'status' not found" })
    } finally {
      mcp.close()
      await stopRelay(relay.child)
    }
  }, 30_000)
})
