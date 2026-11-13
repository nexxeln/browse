import "../src/mcp.ts"
import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import type { McpSchema } from "effect/ai"
import { buildRegisteredMcpTools, createMcpToolContext, type McpToolSpec } from "../src/mcp/registry.ts"
import {
  StatusToolOutput,
  agentSettingKeys,
  executeToolOutput,
  executeToolResult,
  executeToolText,
  toolResultForValue,
} from "../src/mcp/schema.ts"
import type * as RelayClient from "../src/relay/client.ts"
import type { ExecuteResponse } from "../src/relay/schema.ts"
import { parseSettingChanges, settingSpecs, SettingsInputError } from "../src/relay/user-settings.ts"

function executeResponse(overrides: Partial<ExecuteResponse> = {}): ExecuteResponse {
  return {
    text: "undefined",
    isError: false,
    logs: [],
    session: {
      id: "mcp-1234abcd",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      connected: true,
      pageUrl: null,
      stateKeys: [],
    },
    ...overrides,
  }
}

/** The tools the server advertises (`execute` and `manage`), over a relay that answers what `relay` stubs. */
function specs(relay: Partial<RelayClient.Interface> = {}): readonly McpToolSpec[] {
  return buildRegisteredMcpTools(createMcpToolContext({
    relay: relay as RelayClient.Interface,
    currentSession: { id: "mcp-1234abcd", established: true },
    packageRoot: "/tmp/browse",
  }))
}

/** Calls a tool behind `manage` the way the server does: the tool that handled the call, and the value it answered. */
async function routed(tools: readonly McpToolSpec[], tool: string, args: Record<string, unknown> = {}) {
  const manage = tools.find((spec) => spec.name === "manage")!
  const answer = manage.route!(await Effect.runPromise(manage.handle({ tool, args })))
  expect(answer.spec.name).toBe(tool)
  return answer
}

/** What a tool behind `manage` sends for `value` as text: its JSON. */
function sentJson(value: unknown): unknown {
  const [text, ...rest] = textBlocks(toolResultForValue(value))
  expect(rest).toEqual([])
  expect(text).toBe(JSON.stringify(value))
  return JSON.parse(text!)
}

function resultJson(result: McpSchema.CallToolResult): string {
  return JSON.stringify(result)
}

function textBlocks(result: McpSchema.CallToolResult): string[] {
  return result.content.flatMap((item) => item.type === "text" ? [item.text] : [])
}

/** The JSON type of a value. Integer and number are one type: JSON Schema matches either against both. */
function jsonType(value: unknown): string {
  return typeof value === "number" ? "number" : value === null ? "null" : typeof value
}

/** Every `enum` and `const` in a JSON Schema, with its path and the `type` declared beside it, if any. */
function literals(schema: unknown): Array<{ path: string; type: string | undefined; values: readonly unknown[] }> {
  const found: Array<{ path: string; type: string | undefined; values: readonly unknown[] }> = []
  const visit = (node: unknown, path: string) => {
    if (Array.isArray(node)) return node.forEach((item, index) => visit(item, `${path}[${index}]`))
    if (node === null || typeof node !== "object") return
    const record = node as Record<string, unknown>
    const type = typeof record.type === "string" ? record.type : undefined
    if (Array.isArray(record.enum)) found.push({ path: `${path}.enum`, type, values: record.enum })
    if ("const" in record) found.push({ path: `${path}.const`, type, values: [record.const] })
    for (const [key, value] of Object.entries(record)) visit(value, `${path}.${key}`)
  }
  visit(schema, "")
  return found
}

function matchesJsonType(type: string, value: unknown): boolean {
  switch (type) {
    case "integer": return typeof value === "number" && Number.isInteger(value)
    case "number": return typeof value === "number"
    case "string": return typeof value === "string"
    case "boolean": return typeof value === "boolean"
    case "null": return value === null
    case "array": return Array.isArray(value)
    case "object": return typeof value === "object" && value !== null && !Array.isArray(value)
    default: return true
  }
}

/** Every JSON Schema the MCP server advertises: each tool's input. No tool advertises an output schema. */
function advertisedSchemas(): Array<{ name: string; json: unknown }> {
  return specs().map((spec) => ({ name: `${spec.name} input`, json: spec.inputSchema }))
}

describe("tool output schemas", () => {
  test("the advertised tools are execute and manage, and neither has an output schema", () => {
    const advertised = specs()
    expect(advertised.map((spec) => spec.name)).toEqual(["execute", "manage"])
    for (const spec of advertised) expect(spec.outputSchema, spec.name).toBeUndefined()
    expect(advertised[1]!.inputSchema).toEqual({
      type: "object",
      properties: { tool: { type: "string" }, args: { type: "object" } },
      required: ["tool"],
      additionalProperties: false,
    })
  })

  test("execute advertises no output schema, so a client that validates one accepts its image results", () => {
    const execute = specs().find((spec) => spec.name === "execute")!
    expect(execute.outputSchema).toBeUndefined()
    const result = executeToolResult(executeResponse({
      text: "Returned 1 image",
      media: [{ type: "image", mimeType: "image/png", data: Buffer.from("png").toString("base64"), size: 3 }],
    }))
    expect(result.structuredContent).toBeUndefined()
    expect(result.content.map((item) => item.type)).toEqual(["text", "image"])
    // The MCP SDK client rejects a non-error result without structured content from a tool that declares an output
    // schema. Every screenshot hit that while execute declared one.
    const rejected = execute.outputSchema !== undefined && result.structuredContent === undefined && !result.isError
    expect(rejected).toBe(false)
  })

  test("tool annotations describe what each advertised tool can do", () => {
    const byName = new Map(specs().map((spec) => [spec.name, spec]))
    const annotation = (name: string) => {
      const spec = byName.get(name)!
      return { readOnly: spec.readOnly, destructive: spec.destructive, idempotent: spec.idempotent, openWorld: spec.openWorld }
    }
    expect(annotation("execute")).toEqual({ readOnly: false, destructive: true, idempotent: false, openWorld: true })
    // manage fronts every other tool (session_delete, secrets_refresh, ...), so it advertises the widest of them.
    expect(annotation("manage")).toEqual({ readOnly: false, destructive: true, idempotent: false, openWorld: true })
    for (const spec of specs()) expect(typeof spec.openWorld, spec.name).toBe("boolean")
  })

  test("settings schema accepts both the read and the change result", async () => {
    const setting = { value: "shared", effective: "shared", allowed: ["shared", "window"], description: "Grouping" }
    const settings = Object.fromEntries(agentSettingKeys.map((key) => [key, setting]))
    const { spec } = await routed(specs({ settingsGet: Effect.succeed({ settings, note: "read" }) } as unknown as Partial<RelayClient.Interface>), "settings")
    expect(Schema.is(spec.outputSchema!)({ settings, note: "read" })).toBe(true)
    expect(Schema.is(spec.outputSchema!)({
      changed: [{ key: "grouping", from: "window", to: "shared" }],
      unchanged: [],
      overridden: [],
      settings,
      message: "changed",
    })).toBe(true)
  })

  test("merged action tools answer every action with JSON that fits the result they declare", async () => {
    const networkReport = {
      active: true,
      startedAt: "2026-01-01T00:00:00.000Z",
      entryCount: 1,
      responseCount: 1,
      failureCount: 0,
      capturedBodyBytes: 10,
      truncatedBodyCount: 0,
      droppedEntryCount: 0,
      urlFilter: "/api/",
    }
    const quality = {
      width: 1280,
      height: 720,
      frameRate: 30,
      sourceFrameCount: 30,
      encodedSourceFrameCount: 30,
      coalescedFrameCount: 0,
      droppedFrameCount: 0,
      achievedSourceFrameRate: 30,
      achievedEncodedSourceFrameRate: 30,
      screenshotFallback: false,
    }
    const relay = {
      sessions: Effect.succeed([{ id: "mcp-1234abcd" }]),
      sessionEnsure: () => Effect.void,
      extensionStatus: Effect.succeed({ connected: true }),
      networkStart: () => Effect.succeed(networkReport),
      networkStatus: () => Effect.succeed(networkReport),
      networkStop: () => Effect.succeed({
        ...networkReport,
        active: false,
        stoppedAt: "2026-01-01T00:01:00.000Z",
        updatedSecretRefs: [],
        observedSecretRefs: [],
      }),
      networkCancel: () => Effect.succeed({ cancelled: true }),
      recordingStart: () => Effect.succeed({
        success: true,
        tabId: 1,
        startedAt: 1,
        path: "/tmp/a.webm",
        mimeType: "video/webm",
        mode: "tab-capture",
        artifactType: "webm",
        frameRate: 30,
      }),
      recordingStop: () => Effect.succeed({
        success: true,
        tabId: 1,
        duration: 1000,
        path: "/tmp/a.webm",
        size: 100,
        mode: "tab-capture",
        artifactType: "webm",
        frameCount: 2,
        quality,
      }),
      recordingStatus: () => Effect.succeed({ isRecording: false }),
      recordingCancel: () => Effect.succeed({ success: true }),
      flightRecorderStart: () => Effect.succeed({
        active: true,
        tabId: 1,
        sessionId: "mcp-1234abcd",
        startedAt: 1,
        retentionMs: 60_000,
        frameRate: 60,
      }),
      flightRecorderStatus: () => Effect.succeed({
        active: true,
        tabId: 1,
        sessionId: "mcp-1234abcd",
        startedAt: 1,
        retentionMs: 60_000,
        retainedDurationMs: 1000,
        frameRate: 60,
        bufferedFrames: 10,
        bufferedBytes: 1000,
        sourceFrameCount: 10,
        droppedFrameCount: 0,
        saving: false,
      }),
      flightRecorderSaveLast: () => Effect.succeed({
        path: "/tmp/a.webm",
        durationMs: 30_000,
        frameCount: 10,
        sourceFrameCount: 10,
        droppedFrameCount: 0,
      }),
      flightRecorderCancel: () => Effect.succeed({ cancelled: true }),
    } as unknown as RelayClient.Interface
    const ctx = createMcpToolContext({
      relay,
      currentSession: { id: "mcp-1234abcd", established: true },
      packageRoot: "/tmp/browse",
    })
    const tools = buildRegisteredMcpTools(ctx)
    const cases: Record<string, ReadonlyArray<{ action: string; [key: string]: unknown }>> = {
      network: [
        { action: "start" },
        { action: "status" },
        { action: "stop", outputPath: "/tmp/a.har" },
        { action: "cancel" },
      ],
      recording: [
        { action: "start", outputPath: "/tmp/a.webm", cursor: true },
        { action: "stop" },
        { action: "status" },
        { action: "cancel" },
      ],
      flight_recorder: [
        { action: "start" },
        { action: "status" },
        { action: "save_last", outputPath: "/tmp/a.webm", durationMs: 30_000 },
        { action: "cancel" },
      ],
    }
    for (const [name, actions] of Object.entries(cases)) {
      for (const args of actions) {
        const { spec, value } = await routed(tools, name, { session: "mcp-1234abcd", ...args })
        const sent = sentJson(value)
        expect(sent, `${name} ${args.action}`).toMatchObject({ action: args.action, session: "mcp-1234abcd" })
        expect(Schema.is(spec.outputSchema!)(sent), `${name} ${args.action}`).toBe(true)
      }
    }
  })

  test("settings never expose or change update behaviour", async () => {
    const setting = { value: "shared", effective: "shared", allowed: ["shared", "window"], description: "Grouping" }
    const settings = Object.fromEntries(agentSettingKeys.map((key) => [key, setting]))
    const relay = {
      settingsGet: Effect.succeed({
        settings: { ...settings, autoUpdate: { ...setting, allowed: ["on", "notify", "off"] } },
        note: "read",
      }),
    } as unknown as RelayClient.Interface
    const ctx = createMcpToolContext({
      relay,
      currentSession: { id: "mcp-1234abcd", established: true },
      packageRoot: "/tmp/browse",
    })
    const tools = buildRegisteredMcpTools(ctx)
    const { spec, value } = await routed(tools, "settings")
    const read = sentJson(value) as { settings: Record<string, unknown> }
    expect(read.settings).not.toHaveProperty("autoUpdate")
    expect(Object.keys(read.settings).sort()).toEqual([...agentSettingKeys].sort())
    expect(Schema.is(spec.outputSchema!)(read)).toBe(true)
    const manage = tools.find((candidate) => candidate.name === "manage")!
    const failure = await Effect.runPromise(Effect.flip(manage.handle({ tool: "settings", args: { set: { autoUpdate: "notify" } } })))
    expect(failure.message).toContain("browse settings set autoUpdate")
  })

  test("execute answers with the returned value as text, once, with no structured content or session id", () => {
    const snapshot = "button \"Save\" [ref=e1]\ntextbox \"Name\" [ref=e2]"
    const result = executeToolResult(executeResponse({ text: snapshot, value: snapshot }))
    expect(result.isError).toBe(false)
    expect(result.structuredContent).toBeUndefined()
    expect(textBlocks(result)).toEqual([snapshot])
    // One text block is the whole result: no structured copy, session record or util.inspect text beside it.
    const received = JSON.parse(resultJson(result)) as { content: Array<{ type: string; text: string }>; structuredContent?: unknown }
    expect(received.content).toEqual([{ type: "text", text: snapshot }])
    expect(received.structuredContent).toBeUndefined()
    expect(resultJson(result)).not.toContain("mcp-1234abcd")
  })

  test("execute text is the value: a string as it is, other values as compact JSON, and Done. when there is nothing", () => {
    const text = (overrides: Partial<ExecuteResponse>) => textBlocks(executeToolResult(executeResponse(overrides)))
    expect(text({ text: "'hello'", value: "hello" })).toEqual(["hello"])
    expect(text({ text: "{ title: 'Example', count: 2 }", value: { title: "Example", count: 2 } })).toEqual(['{"title":"Example","count":2}'])
    expect(text({ text: "42", value: 42 })).toEqual(["42"])
    expect(text({ text: "undefined" })).toEqual(["Done."])
  })

  test("execute carries the context only when it has content", () => {
    const result = executeToolResult(executeResponse({
      text: "42",
      value: 42,
      logs: [{ source: "script", type: "log", text: "hello" }],
      logSummary: { totalCount: 1, returnedCount: 1, repeatedCount: 0, omittedCount: 0 },
      warnings: ["careful"],
      aftermath: {
        startUrl: "https://example.com/one",
        endUrl: "https://example.com/two",
        navigations: ["https://example.com/two"],
        consoleErrorCount: 0,
        pageErrorCount: 0,
        handoffs: 0,
      },
    }))
    expect(result.isError).toBe(false)
    expect(result.structuredContent).toBeUndefined()
    // The page movement is not repeated as a line: the page view that follows a navigation shows where the page is.
    expect(textBlocks(result)).toEqual(["42\n\nWarning: careful\n\nLogs (1):\n[log] hello"])
    // Nothing happened beside the return: the text is the value alone.
    expect(textBlocks(executeToolResult(executeResponse({ text: "42", value: 42, warnings: [] })))).toEqual(["42"])
  })

  test("execute text orders the value, warnings, diagnostic, logs, page errors, requests, page view and notice", () => {
    const result = executeToolResult({
      ...executeResponse({
        text: "'saved'",
        value: "saved",
        logs: [{ source: "page", type: "error", text: "bad", repeatCount: 3 }],
        warnings: ["first", "second"],
        diagnostic: "execution-context/context-destroyed",
        aftermath: {
          startUrl: "https://example.com/items",
          endUrl: "https://example.com/items",
          navigations: [],
          consoleErrorCount: 1,
          pageErrorCount: 0,
          handoffs: 1,
        },
        requests: ['POST /api/items {"name":"a"} → 201', "DELETE /api/items/1 → 204"],
        view: 'Page: https://example.com/items — Items\n[e1 button "Save"]',
      }),
      notice: "Note: browse has an update.",
    })
    expect(result.structuredContent).toBeUndefined()
    expect(textBlocks(result)).toEqual([[
      "saved",
      "Warning: first\nWarning: second",
      "Diagnostic: execution-context/context-destroyed",
      "Logs (1):\n[page error] bad (×3)",
      "Page: 1 console error; 1 handoff",
      'Requests:\nPOST /api/items {"name":"a"} → 201\nDELETE /api/items/1 → 204',
      'Page: https://example.com/items — Items\n[e1 button "Save"]',
      "Note: browse has an update.",
    ].join("\n\n")])
  })

  test("execute text ends with the page view: the whole page, what changed, or that nothing did", () => {
    const text = (view: string, value?: string) =>
      textBlocks(executeToolResult(executeResponse(value === undefined ? { view } : { text: value, value, view })))
    expect(text('Page: https://example.com/ — Example\nExample Domain\n[e1 link "More information"]', "ok"))
      .toEqual(['ok\n\nPage: https://example.com/ — Example\nExample Domain\n[e1 link "More information"]'])
    expect(text('Page changed (+1 −1 lines).\n+ [e2 button "Saved"]\n− [e2 button "Save"]', "ok"))
      .toEqual(['ok\n\nPage changed (+1 −1 lines).\n+ [e2 button "Saved"]\n− [e2 button "Save"]'])
    // With a page view there is something to say, so an empty return is not padded with Done.
    expect(text("Page: unchanged")).toEqual(["Page: unchanged"])
  })

  test("a failed execute also carries the requests it made and the page view", () => {
    const result = executeToolResult(executeResponse({
      text: "Error: boom\n    at script:1:1",
      isError: true,
      requests: ["POST /api/items → 500"],
      view: "Page: unchanged",
    }))
    expect(result.isError).toBe(true)
    expect(textBlocks(result)).toEqual(["Error: boom\n    at script:1:1\n\nRequests:\nPOST /api/items → 500\n\nPage: unchanged"])
  })

  test("execute errors put their warnings, diagnostic, page movement and logs in the text, with no structured content", () => {
    const result = executeToolResult(executeResponse({
      text: "Error: boom\n    at script:1:1",
      isError: true,
      logs: [{ source: "script", type: "log", text: "step 1" }, { source: "page", type: "error", text: "bad", repeatCount: 3 }],
      warnings: ["the page navigated"],
      diagnostic: "execution-context/context-destroyed; pageClosed=false; urlChanged=true; mainFrameNavigations=1",
      aftermath: {
        startUrl: "https://example.com/one",
        endUrl: "https://example.com/two",
        navigations: ["https://example.com/two"],
        consoleErrorCount: 1,
        pageErrorCount: 0,
        handoffs: 0,
      },
    }))
    expect(result.isError).toBe(true)
    expect(result.structuredContent).toBeUndefined()
    expect(textBlocks(result)).toEqual([[
      "Error: boom\n    at script:1:1",
      "Warnings:\n- the page navigated",
      "Diagnostic: execution-context/context-destroyed; pageClosed=false; urlChanged=true; mainFrameNavigations=1",
      "Page: moved from https://example.com/one to https://example.com/two; 1 navigation; 1 console error",
      "Logs (2):\n[log] step 1\n[page error] bad (×3)",
    ].join("\n\n")])
  })

  test("a bare execute error stays just the message", () => {
    const result = executeToolResult(executeResponse({ text: "Error: boom\n    at script:1:1", isError: true }))
    expect(textBlocks(result)).toEqual(["Error: boom\n    at script:1:1"])
  })

  test("execute error text stays under 10,000 characters and keeps its warnings", () => {
    const result = executeToolResult(executeResponse({
      text: `locator.click: Timeout 30000ms exceeded.\nCall log:\n${"  - retrying click action\n".repeat(2000)}    at execute.js:5:1`,
      isError: true,
      logs: Array.from({ length: 500 }, (_, index) => ({ source: "script" as const, type: "log", text: `line ${index} ${"x".repeat(400)}` })),
      warnings: ["Pointer action was blocked"],
    }))
    const text = textBlocks(result).join("")
    expect(text.length).toBeLessThan(10_000)
    expect(text).toStartWith("locator.click: Timeout 30000ms exceeded.")
    expect(text).toContain("at execute.js:5:1")
    expect(text).toContain("Warnings:\n- Pointer action was blocked")
    expect(text).toContain("line 499")
    expect(text).not.toContain("line 479 ")
  })

  test("status structured content validates and its fallback text is compact", () => {
    const value = {
      endpoint: "http://127.0.0.1:19988",
      currentSession: "mcp-1234abcd",
      sharedSession: false,
      version: { version: "0.0.10", pid: 42 },
      status: { connected: true, version: "0.0.10", activeTargets: 1 },
      autoUpdate: { install: "npm", cli: "browse", mode: "auto", effective: "auto" },
    }
    const result = toolResultForValue(value, { outputSchema: StatusToolOutput })
    expect(Schema.is(StatusToolOutput)(result.structuredContent)).toBe(true)
    expect(textBlocks(result)).toEqual([JSON.stringify(value)])
    expect(textBlocks(result)[0]).not.toContain("\n  ")
  })

  test("images keep their content blocks and are not repeated as structured content", () => {
    const result = executeToolResult(executeResponse({
      text: "screenshot taken",
      value: { type: "image", mimeType: "image/png", size: 68 },
      media: [{
        type: "image",
        mimeType: "image/png",
        data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
        size: 68,
      }],
    }))
    expect(result.structuredContent).toBeUndefined()
    expect(result.content.map((item) => item.type)).toEqual(["text", "image"])
    expect(textBlocks(result)).toEqual(["screenshot taken"])
  })

  test("the execute fallback text is readable and the shaping drops an uneventful aftermath", () => {
    const response = executeResponse({
      text: "snapshot text",
      value: "snapshot text",
      aftermath: {
        startUrl: "https://example.com/",
        endUrl: "https://example.com/",
        navigations: [],
        consoleErrorCount: 0,
        pageErrorCount: 0,
        handoffs: 0,
      },
    })
    expect(executeToolText(response)).toBe("snapshot text")
    expect(executeToolOutput(response)).toEqual({ session: "mcp-1234abcd", value: "snapshot text" })
  })

  test("session_adopt no longer repeats the adoption as a confirmation string", async () => {
    const session = {
      id: "mcp-1234abcd",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      connected: true,
      pageUrl: "https://example.com/",
      stateKeys: [],
    }
    const adopted = { session, adoptedUrl: "https://example.com/", adoptedTargetId: "TARGET" }
    const relay = {
      sessionAdopt: () => Effect.succeed(adopted),
    } as unknown as RelayClient.Interface
    const ctx = createMcpToolContext({
      relay,
      currentSession: { id: "mcp-1234abcd", established: true },
      packageRoot: "/tmp/browse",
    })
    const { spec, value } = await routed(buildRegisteredMcpTools(ctx), "session_adopt")
    const sent = sentJson(value)
    expect(sent).toEqual(adopted)
    expect(sent).not.toHaveProperty("confirmation")
    expect(Schema.is(spec.outputSchema!)(sent)).toBe(true)
  })
})

describe("advertised tool schemas", () => {
  // Some MCP clients (Kimi, for one) reject a tool whose enum or const mixes JSON types, and fail the whole tool list
  // over it. Each variant must keep its own type, through anyOf or otherwise.
  test("every enum and const keeps one JSON type", () => {
    const problems: string[] = []
    for (const { name, json } of advertisedSchemas()) {
      for (const { path, type, values } of literals(json)) {
        const types = new Set(values.map((value) => jsonType(value)))
        if (types.size > 1) problems.push(`${name}${path} mixes ${[...types].join(", ")}: ${JSON.stringify(values)}`)
        if (type) {
          const mismatched = values.filter((value) => !matchesJsonType(type, value))
          if (mismatched.length > 0) problems.push(`${name}${path} declares type ${type} but holds ${JSON.stringify(mismatched)}`)
        }
      }
    }
    expect(problems).toEqual([])
  })

  test("settings idleMinutes splits its minutes and 'never' into single-typed enums", async () => {
    // The settings tool sits behind manage, whose help prints the tool's arguments as the JSON Schema they keep.
    const manage = specs().find((spec) => spec.name === "manage")!
    const help = manage.route!(await Effect.runPromise(manage.handle({ tool: "help", args: { tool: "settings" } }))).value as string
    expect(help).toStartWith("settings: Read or change the user's browse settings")
    expect(help).toContain(`"idleMinutes":${JSON.stringify({
      anyOf: [
        { type: "integer", enum: [10, 30, 60] },
        { type: "string", enum: ["never"] },
      ],
      description: settingSpecs.idleMinutes.label,
    })}`)
  })

  test("settings idleMinutes still decodes every value it advertises", () => {
    expect(parseSettingChanges({ idleMinutes: 10 })).toEqual({ idleMinutes: 10 })
    expect(parseSettingChanges({ idleMinutes: "never" })).toEqual({ idleMinutes: "never" })
    // 0 and numeric strings are the CLI's other spellings of the same values.
    expect(parseSettingChanges({ idleMinutes: 0 })).toEqual({ idleMinutes: "never" })
    expect(parseSettingChanges({ idleMinutes: "30" })).toEqual({ idleMinutes: 30 })
    expect(() => parseSettingChanges({ idleMinutes: 15 })).toThrow(SettingsInputError)
  })
})
