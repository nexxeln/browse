# Token efficiency

This fork cuts the tokens an agent spends driving a browser through browse. Measured on
[Ardia's browser-agent bench](https://github.com/mantrakp04/ardia/tree/main/apps/cli/bench) (eight local web apps, the
same prompt for every contender, a checker on each app's server), it uses 46% fewer tokens than Ardia's published
figures with Claude Code and 43% fewer with Codex.

## Results

Tokens are input (cached included) plus output, summed over every model call of a run. Each cell is the median of three
runs; the total is the sum of the eight medians, which is how Ardia reports it.

| | Ardia (published) | OpenCode Browse 0.0.10 (published) | browse before this fork | this fork | fork vs Ardia |
| --- | ---: | ---: | ---: | ---: | ---: |
| Claude Code, Opus 5.5 | 5,002,938 | 8,468,443 | 6,004,253 | 2,709,371 | −46% |
| Codex, GPT-6.1 Sol | 3,659,168 | 7,591,821 | 10,789,113 | 2,096,120 | −43% |

| Task | Claude: Ardia | Claude: fork | Codex: Ardia | Codex: fork |
| --- | ---: | ---: | ---: | ---: |
| Calendar | 171,778 | 80,102 | 121,464 | 77,295 |
| Expenses | 2,064,550 | 760,094 | 1,200,024 | 842,349 |
| Research | 250,420 | 128,567 | 293,817 | 105,707 |
| Booking | 536,105 | 305,676 | 307,398 | 212,386 |
| Shop | 610,270 | 507,718 | 437,369 | 372,778 |
| Grid | 601,482 | 302,858 | 447,421 | 128,229 |
| Kanban | 331,757 | 238,219 | 261,309 | 120,635 |
| Multi-tab | 436,576 | 386,137 | 590,366 | 236,741 |

Read these with the following in mind:

- The Ardia and OpenCode Browse 0.0.10 columns are the numbers Ardia published for runs on 2026-11-07. The fork was
  measured on 2026-11-12 and 13 on a different machine, with the same harness, prompts, models and effort. Ardia itself was
  not rerun.
- "browse before this fork" is upstream at `0d68a0b` on the measuring machine, one run per cell.
- 47 of the fork's 48 runs passed. The one failure is Codex on Shop: the task asks for delivery "by Wednesday, Nov 11",
  which was already past on the day of the run, and the agent stopped to ask. Its tokens are counted. In the three
  builds measured the same way before this one, Codex failed Shop for this reason in 6 of 9 runs and Claude Code in none.
- One repeat of the whole suite varies by about ±0.3M tokens for either agent, mostly from how much text the agent
  chooses to return on Expenses, Shop and Multi-tab. Differences smaller than that between builds are noise.
- Codex ran with an empty `CODEX_HOME` (credentials only) so the measuring user's own Codex skills stayed out of the
  runs. The harness otherwise uses the real one.
- The checker labels how writes arrived on the tasks that track it (Expenses, Kanban). Every fork run was labelled `ui`.

## Why it costs less

A run's tokens are close to (number of model calls) × (the agent's fixed prompt), because every call re-sends the whole
conversation. Upstream at `0d68a0b` took 14 calls for the Calendar task; 83% of its 316,000 tokens were Claude Code's own
18,700-token prompt, paid 14 times. So the changes remove calls:

- **The page comes with every result.** `execute` results end with the page view: what a person would read, one visual
  row per line, with each control written where it sits as `[e12 button "Save"]`. It is the whole page the first time
  and after a real navigation, and only the changed lines afterwards. An agent no longer spends a call to look and
  another to check.
- **So do the writes.** Results list the page's non-GET requests with their status
  (`POST /api/events {"title":"Board prep"} → 201`).
- **The first call lands on the lent tab.** A first `execute` starts on the tab the user lent, when there is exactly
  one, instead of opening `about:blank` and telling the agent how to adopt it.
- **Two tools, not eighteen.** Agents see `execute` and `manage`; `manage` fronts every other tool and prints its
  arguments on request. Results are text only and no output schemas are advertised. `execute` asks tool-search clients
  to keep it loaded. The server's instructions are one sentence, because Codex appends them to every tool.
- **Helpers for what took several calls each.** `drag(from, to)` completes HTML5 and pointer drags with trusted events
  (Playwright's `dragTo` starts a drag the relay never finishes). `fillCell(row, column, value)` edits a grid cell.
  `scrollRead(locator)` reads a virtualized or lazily loaded list in one call.
- **Forms behind a button.** A form sitting in a closed dialog is listed under the page, so opening it, filling it and
  submitting it is one call.
- **The page is sent once.** A value read with `innerText` repeats the page's header, lists and footer. Runs of lines
  that are the current page's text are cut from returned values and replaced by a marker; the page view covers them.
- **Refs that last.** The view gives a ref to everything it shows that can be used, keeps each id for the life of the
  document, and keeps refs and the last view per tab.

## Reproducing

Clone Ardia and use `apps/cli/bench` as documented there, with these contender settings in a plan file:

```json
{ "kind": "opencode", "agent": "claude", "model": "claude-opus-5-5", "effort": "high",
  "browse_entry": "<checkout>/cli/dist/cli.mjs", "extension": "<checkout>/dist" }
```

The harness hard-codes the Chrome Web Store extension id; an unpacked build from a checkout has the id
`afeafocngkodbmaipcngoamamfmekgfo`, so `EXTENSION_ID` in `harness/opencode_side.py` must be changed to match.
