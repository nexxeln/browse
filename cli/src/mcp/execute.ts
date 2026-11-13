import { Effect } from "effect"
import * as RelayClient from "../relay/client.ts"
import * as RelayLifecycle from "../relay/lifecycle.ts"
import { registerMcpTools } from "./registry.ts"
import { executeToolResult, objectSchema, parseExecuteArguments } from "./schema.ts"

registerMcpTools({
  order: 100,
  build: (ctx) => [
    {
      name: "execute",
      description: `Run Playwright JavaScript on your browse session's page: the tab the user lent you when there is one, else a new tab. The user's logins are already there.

The result is your \`return\` value, then what the call did:
- Requests: the page's non-GET requests with their status (\`POST /api/items {…} → 201\`), your proof a write reached the server.
- The page: all of it the first time and after a navigation, afterwards only the lines that changed. Controls are written \`[e12 button "Save"]\`.

Each call re-sends the whole conversation, so use as few calls as you can:
- Act on what the result shows. Don't spend a call on snapshot(), a text read, or re-checking what the result already proved. To just look, run \`return ""\`.
- \`await ref("e12").click()\`, \`.fill("…")\`, \`.selectOption("…")\`. Refs last until the page navigates. Playwright locators (page.getByRole, getByLabel, getByText, CSS) need no ref.
- Put every step you can already name in one call: fill a whole form and submit it, loop over rows, visit several pages and return only the facts you need. End a call only where the next step depends on something you haven't seen.
- Another site: page.goto(url). To keep this page open too, \`await (await context.newPage()).goto(url)\`, then pass targetUrl on later calls to work in that tab; each tab has its own page view and refs.
- \`await drag(from, to, { position: "before" | "after" })\` drags and drops (locator.dragTo does not work here). \`await fillCell(rowLocator, "Column header", value)\` sets a table or grid cell: it opens the cell's editor, types and commits. \`await scrollRead(locator, { match })\` returns the rows of a list that loads or renders as it scrolls. To see an image or canvas, \`return await locator.screenshot()\`.

Press the buttons the request calls for yourself (submit, save, place order, confirm and pay with a saved card). Use \`await handoff("what to do")\` only for what a site demands of a person: a login with no stored secret, a 2FA code, a passkey, a captcha, a bank's own verification. Never solve a captcha or retry a site that blocks you. Type stored secrets with secrets.type(locator, name), never in code. The code runs in a restricted realm (no process, require, import(), fs or Node fetch); it is not a security boundary.`,
      alwaysLoad: true,
      inputSchema: objectSchema(
        {
          code: {
            type: "string",
            description:
              "JavaScript. In scope: page, context, browser, state (kept between calls), ref(id), drag, fillCell, scrollRead, snapshot({ within?, find?, diff? }) (controls only), ariaSnapshot, screenshotWithLabels, screenshotDiff, files (path, write, read), handoff, demonstrate, ghostCursor, webmcp, network, pageConsole, secrets. No document, location or fetch globals: use page.evaluate(...) and page.url().",
          },
          session: { type: "string", description: "Session id; omit for your current session." },
          targetUrl: { type: "string", description: "Run on the attached page whose URL contains this (does not navigate)." },
          targetIndex: { type: "integer", minimum: 0 },
          browser: { type: "string", description: "Browser id for a new session; see status." },
          timeoutMs: { type: "integer", minimum: 0, description: "Script timeout (default 60000; 0 disables)." },
        },
        ["code"],
      ),
      readOnly: false,
      destructive: true,
      idempotent: false,
      openWorld: true,
      // No outputSchema: clients that validate one reject image results, which carry no structured content.
      result: executeToolResult,
      handle: (input) =>
        Effect.gen(function* () {
          const args = yield* Effect.try(() => parseExecuteArguments(input))
          const caller = yield* ctx.caller
          const sessionId = args.session ?? caller.id
          const connected = RelayLifecycle.ensureExtensionConnected({ relay: ctx.relay, sessionId, waitForReconnect: true })
          yield* connected
          const run = ctx.relay.execute({
            sessionId,
            code: args.code,
            createIfMissing: !args.session,
            ...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs }),
            ...(args.targetSelection ? { targetSelection: args.targetSelection } : {}),
            ...(args.browser ? { browser: args.browser } : {}),
          })
          // The status check and the call race the browser's link closing (a worker restart): when the relay answers
          // that the session's browser isn't connected, wait for it once more and run once more.
          const result = yield* run.pipe(Effect.catchIf(
            (error): error is RelayClient.RelayRejected => error instanceof RelayClient.RelayRejected && error.code === "browser-unavailable",
            () => connected.pipe(Effect.andThen(run)),
          ))
          const recreated = !args.session && caller.established && result.session.created === true
          ctx.establishCurrentSession(caller, sessionId)
          return {
            ...result,
            ...(recreated
              ? { notice: `Recreated session '${sessionId}' — relay had no such session; page and state were reset.` }
              : {}),
          }
        }),
    },
  ],
})
