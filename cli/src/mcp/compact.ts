import { Effect } from "effect"
import type { McpToolSpec } from "./registry.ts"
import { objectSchema } from "./schema.ts"

/**
 * The tool list an agent pays for on every model call. Clients send each tool's name, description and input schema
 * with every request (or, in a code mode, print the whole list into the conversation once and carry it from then
 * on), so eighteen thoroughly documented tools cost more per call than the page being driven.
 *
 * Agents therefore see two tools. `execute` is the one every task uses. `manage` fronts all the others (status,
 * sessions, network capture, recording, secrets, settings, tab cleanup): its description names them, and
 * `manage({ tool: "help", args: { tool } })` prints a tool's full description and arguments when one is needed. The
 * tools behind it are unchanged; this only decides how much of them is paid for up front.
 */

const primary = new Set(["execute"])

type Routed = { readonly spec: McpToolSpec; readonly value: unknown }

const helpFor = (spec: McpToolSpec): string => {
  const schema = spec.inputSchema as { readonly properties?: Record<string, { readonly description?: string }>; readonly required?: readonly string[] }
  const required = new Set(schema.required ?? [])
  const lines = Object.entries(schema.properties ?? {}).map(([name, property]) => {
    const { description, ...shape } = property
    return `- ${name}${required.has(name) ? " (required)" : ""}: ${JSON.stringify(shape)}${description ? ` ${description}` : ""}`
  })
  return [`${spec.name}: ${spec.description}`, lines.length > 0 ? `args:\n${lines.join("\n")}` : "args: none"].join("\n")
}

function manage(specs: readonly McpToolSpec[]): McpToolSpec {
  const byName = new Map(specs.map((spec) => [spec.name, spec]))
  const names = [...byName.keys()]
  const argsOf = (input: unknown): { readonly spec: McpToolSpec | undefined; readonly tool: string; readonly args: unknown } => {
    const object = input !== null && typeof input === "object" ? input as Record<string, unknown> : {}
    const tool = typeof object.tool === "string" ? object.tool : ""
    return { spec: byName.get(tool), tool, args: object.args ?? {} }
  }
  const help: McpToolSpec = {
    name: "help",
    description: "Describe a manage tool and its arguments.",
    inputSchema: objectSchema({}),
    readOnly: true,
    destructive: false,
    idempotent: true,
    openWorld: false,
    requiresRelayCompatibility: false,
    handle: () => Effect.succeed(undefined),
  }
  return {
    name: "manage",
    description:
      `Everything in browse besides running code. \`tool\` is one of: status (relay, browsers, the user's lent tabs, sessions); session_new, session_list, session_use, session_reset, session_delete, session_adopt (make a lent tab your session's page), session_allowlist (origins a session may load; needed before secrets.type); network (capture traffic to a redacted HAR); recording and flight_recorder (video of the tab); secrets_list, secrets_status, secrets_refresh, secrets_run; settings (only when the user asks); tabs_cleanup. Pass that tool's arguments in \`args\`. To see them: tool "help", args { "tool": "<name>" }.`,
    inputSchema: objectSchema({ tool: { type: "string" }, args: { type: "object" } }, ["tool"]),
    readOnly: false,
    destructive: true,
    idempotent: false,
    openWorld: specs.some((spec) => spec.openWorld),
    requiresRelayCompatibility: (input) => {
      const { spec, args } = argsOf(input)
      if (!spec) return false
      const requires = spec.requiresRelayCompatibility
      return typeof requires === "function" ? requires(args) : requires !== false
    },
    handle: (input) => {
      const { spec, tool, args } = argsOf(input)
      if (tool === "help") {
        const wanted = args !== null && typeof args === "object" ? (args as Record<string, unknown>).tool : undefined
        const found = typeof wanted === "string" ? byName.get(wanted) : undefined
        const text = found ? helpFor(found) : names.map((name) => helpFor(byName.get(name)!)).join("\n\n")
        return Effect.succeed<Routed>({ spec: help, value: text })
      }
      if (!spec) return Effect.fail(new Error(`Unknown tool '${tool}'. tool is one of: help, ${names.join(", ")}`))
      return spec.handle(args).pipe(Effect.map((value): Routed => ({ spec, value })))
    },
    route: (value) => value as Routed,
  }
}

/** Rewrites the registered tools into the short list agents see: the primary tools, then `manage` for the rest. */
export function compactTools(specs: readonly McpToolSpec[]): readonly McpToolSpec[] {
  const rest = specs.filter((spec) => !primary.has(spec.name))
  return [...specs.filter((spec) => primary.has(spec.name)), ...(rest.length > 0 ? [manage(rest)] : [])]
}
