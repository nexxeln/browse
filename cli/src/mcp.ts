import { NodeStdio } from "@effect/platform-node"
import { Config, Context, Effect, Layer, Option } from "effect"
import { McpProtocol, McpSchema, McpServer } from "effect/ai"
import path from "node:path"
import { fileURLToPath } from "node:url"
import "./mcp/browser.ts"
import "./mcp/execute.ts"
import "./mcp/network.ts"
import "./mcp/recording.ts"
import "./mcp/secrets.ts"
import "./mcp/session.ts"
import {
  buildRegisteredMcpTools,
  createMcpToolContext,
  type McpToolSpec,
} from "./mcp/registry.ts"
import {
  mcpErrorMessage,
  mcpUpdateNote,
  toolResult,
  toolResultForValue,
  type Caller,
  type CurrentSession,
} from "./mcp/schema.ts"
import * as RelayClient from "./relay/client.ts"
import * as RelayLifecycle from "./relay/lifecycle.ts"
import { createUpdateWatcher } from "./update.ts"
import { opencodeBrowserVersion } from "./version.ts"

export {
  mcpErrorMessage,
  mcpUpdateNote,
  toolResultForValue,
}

const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

/**
 * Tool calls running right now, and the shutdown waiters to wake when the last one finishes. A 2026-07-28 client's
 * `subscriptions/listen` stays open for the whole connection, so effect's RpcServer never ends the client on stdin EOF;
 * shutdown uses this count to let ordinary calls answer before interrupting (see runMcpServer).
 */
const toolCalls = {
  running: 0,
  idle: [] as Array<() => void>,
}

/** Resolves when no tool call is running. */
const toolCallsIdle = Effect.callback<void>((resume) => {
  if (toolCalls.running === 0) {
    resume(Effect.void)
    return Effect.void
  }
  const wake = () => resume(Effect.void)
  toolCalls.idle.push(wake)
  return Effect.sync(() => {
    const index = toolCalls.idle.indexOf(wake)
    if (index !== -1) toolCalls.idle.splice(index, 1)
  })
})

const toolCallStarted = () => {
  toolCalls.running++
}

const toolCallFinished = () => {
  toolCalls.running--
  if (toolCalls.running > 0) return
  for (const wake of toolCalls.idle.splice(0)) wake()
}

/**
 * Initialize instructions. One sentence: some clients append the server's instructions to every tool's description,
 * so anything longer is paid for once per tool. How to work is in the `execute` description, which every client
 * shows exactly once.
 */
export const mcpInstructions = "browse drives the user's own Chrome-family browser (their tabs and logins) through the browse extension: run Playwright code with `execute`; `manage` has status, sessions, recording and the rest."

/** The implicit session the MCP supervisor picked (mcp/supervisor.ts), when valid. */
function shimSession(): string | undefined {
  const value = process.env.OPENCODE_BROWSER_MCP_SESSION
  return value && /^mcp-[0-9a-f]{8}$/.test(value) ? value : undefined
}

/** The tool a call is really for: the one `manage` routes to, else the tool itself. */
const routedName = (spec: McpToolSpec, payload: unknown): string => {
  if (!spec.route || payload === null || typeof payload !== "object") return spec.name
  const tool = (payload as { readonly tool?: unknown }).tool
  return typeof tool === "string" ? tool : spec.name
}

/**
 * A tool's result as text only. Tools advertise no output schema and send no structured copy: a client that loads
 * tool definitions up front would pay for every schema on every model call, and one that shows both copies of a
 * result would pay for each result twice.
 */
const textResult = (value: unknown): McpSchema.CallToolResult => {
  const result = toolResultForValue(value)
  return result.structuredContent === undefined ? result : new McpSchema.CallToolResult({ content: result.content, isError: result.isError })
}

const registerTools = Effect.gen(function* () {
  const server = yield* McpServer.McpServer
  const relay = yield* RelayClient.Service
  const configuredSession = Option.getOrUndefined(yield* Config.option(Config.String("OPENCODE_BROWSER_SESSION")))
  // The session of calls that don't name their agent. Every server the MCP supervisor starts keeps the same one.
  const currentSession: CurrentSession = {
    id: configuredSession || shimSession() || `mcp-${crypto.randomUUID().slice(0, 8)}`,
    established: Boolean(configuredSession),
  }
  // Checks for a newer browse in the background (cached; never delays a tool call). The first tool result after one
  // is found carries a note for the agent to pass on, once per calling agent.
  const updates = createUpdateWatcher()
  void updates.refresh()
  const withUpdateNote = (caller: Caller, name: string, result: McpSchema.CallToolResult) => {
    void updates.refresh()
    const notice = updates.current
    if (!notice || caller.updateNoted) return result
    caller.updateNoted = true
    if (name === "status") return result
    return new McpSchema.CallToolResult({
      ...result,
      content: [...result.content, McpSchema.TextContent.make({ text: mcpUpdateNote(notice) })],
    })
  }
  // Tools are registered once, with fixed descriptions and schemas. Connected browsers change without touching this
  // list: status reports them.
  const ctx = createMcpToolContext({
    relay,
    currentSession,
    packageRoot,
    update: () => updates.current,
  })
  const register = (spec: McpToolSpec) =>
    server.addTool({
      tool: new McpSchema.Tool({
        name: spec.name,
        description: spec.description,
        inputSchema: spec.inputSchema,
        ...(spec.alwaysLoad ? { _meta: { "anthropic/alwaysLoad": true } } : {}),
        annotations: {
          readOnlyHint: spec.readOnly,
          destructiveHint: spec.destructive,
          idempotentHint: spec.idempotent,
          openWorldHint: spec.openWorld,
        },
      }),
      annotations: Context.empty(),
      handle: (payload: unknown) => {
        const requiresRelay = typeof spec.requiresRelayCompatibility === "function"
          ? spec.requiresRelayCompatibility(payload)
          : spec.requiresRelayCompatibility !== false
        const operation = requiresRelay
          ? RelayLifecycle.ensureRelay({ relay }).pipe(
              Effect.flatMap((readiness) =>
                readiness.buildProblem ? Effect.fail(new Error(readiness.buildProblem)) : spec.handle(payload),
              ),
            )
          : spec.handle(payload)
        return Effect.acquireUseRelease(
          Effect.sync(toolCallStarted),
          () =>
            operation.pipe(
              Effect.match({
                onFailure: (error) => toolResult({ text: mcpErrorMessage(routedName(spec, payload), error.message), isError: true }),
                onSuccess: (value) => {
                  // A grouped tool answers with the result of the tool that handled the action.
                  const routed = spec.route ? spec.route(value) : { spec, value }
                  return routed.spec.result ? routed.spec.result(routed.value) : textResult(routed.value)
                },
              }),
              Effect.flatMap((result) => ctx.caller.pipe(Effect.map((caller) => withUpdateNote(caller, routedName(spec, payload), result)))),
            ),
          // Success, failure and interrupt all release the count, so a call that never answers can't wedge it.
          () => Effect.sync(toolCallFinished),
        )
      },
    })
  yield* Effect.forEach(buildRegisteredMcpTools(ctx), register, { discard: true })
})

export const mcpServerLayer = McpServer.layerStdio({
  name: "browse",
  version: opencodeBrowserVersion,
  instructions: mcpInstructions,
  protocols: [McpProtocol.v2026_07_28, McpProtocol.v2025_11_25, McpProtocol.v2025_06_18, McpProtocol.v2025_03_26, McpProtocol.v2024_11_05],
})

export const mcpToolsLayer = Layer.effectDiscard(registerTools)

/** How long stdin EOF waits for running tool calls; a stuck one can't keep the process here forever. */
const toolCallWaitMs = 30_000
/**
 * After a handler returns, the RpcServer encodes its answer, offers it to a bounded response queue (rpc/RpcServer.ts,
 * `makeProtocolStdio`) and a stream writes that queue to stdout. The handler's finalizer runs before any of that, so
 * stdin EOF waits this long after the last call finishes before interrupting, letting its answer drain.
 */
const answerFlushMs = 150

/**
 * After stdin EOF, waits for the tool calls already running (bounded by toolCallWaitMs), then pauses so the last one's
 * answer reaches stdout. A request read just before EOF can start its handler a moment later, so a call that starts
 * during the pause is waited for and drained too. Only a request that never answers, such as `subscriptions/listen`, is
 * left for the interrupt.
 */
const finishToolCalls = Effect.gen(function* () {
  const deadline = Date.now() + toolCallWaitMs
  while (true) {
    const remaining = Math.max(0, deadline - Date.now())
    if (toolCalls.running > 0) {
      // A stuck call has had its 30 seconds: stop waiting for it and interrupt.
      if (remaining === 0) return
      yield* Effect.raceFirst(toolCallsIdle, Effect.sleep(remaining))
      continue
    }
    // The idle waiter woke us when the last call finished; give its answer the flush before interrupting.
    yield* Effect.sleep(answerFlushMs)
    if (toolCalls.running === 0) return
  }
})

/** Resolves when the client closes stdin, the way an MCP client shuts a stdio server down. */
const stdinClosed = Effect.callback<void>((resume) => {
  if (process.stdin.readableEnded || process.stdin.destroyed) {
    resume(Effect.void)
    return Effect.void
  }
  const closed = () => resume(Effect.void)
  process.stdin.once("end", closed)
  process.stdin.once("close", closed)
  process.stdin.once("error", closed)
  return Effect.sync(() => {
    process.stdin.off("end", closed)
    process.stdin.off("close", closed)
    process.stdin.off("error", closed)
  })
})

export const runMcpServer: Effect.Effect<never, Error> = Layer.launch(
  mcpServerLayer.pipe(
    // Populate the shared McpServer before stdio can answer initialize or server/discover.
    Layer.provide(mcpToolsLayer.pipe(Layer.provide(McpServer.McpServer.layer))),
    Layer.provide(NodeStdio.layer),
    Layer.provide(RelayClient.layerFetchMcp),
  ),
).pipe(
  // A 2026-07-28 client's `subscriptions/listen` stays open for the whole connection, and effect's RpcServer only ends
  // a client on stdin EOF when no request fibers are in flight (rpc/RpcServer.ts, `Eof` checks `client.fibers`). Without
  // this the server outlives the client. Interrupting ends the whole server, so first wait for ordinary tool calls to
  // finish and their answers to reach stdout (finishToolCalls): only a request that never answers is cut short.
  // main.ts turns the interrupt from a stdin EOF into exit 0.
  Effect.raceFirst(stdinClosed.pipe(Effect.andThen(finishToolCalls), Effect.andThen(Effect.interrupt))),
)
