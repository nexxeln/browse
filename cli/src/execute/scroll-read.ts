import type { Locator, Page } from "patchright-core"

/**
 * `scrollRead(target?)`: every row of a list that only renders or loads what is scrolled into view (a virtualized
 * inbox, an infinite feed), read in one call. It scrolls the container from top to bottom, collects each row once in
 * order, and scrolls back to the top. Without it an agent scrolls and re-reads a page at a time.
 */
export type ScrollReadOptions = {
  /** Keep only rows whose text matches (a string is a case-insensitive substring). */
  readonly match?: string | RegExp
  /** Stop after this many rows. Default 1000. */
  readonly maxItems?: number
  /** Characters kept per row. Default 120: enough for who, when and what, without the preview text. */
  readonly maxChars?: number
}

export type ScrollReadHelper = (target?: Locator | string, options?: ScrollReadOptions) => Promise<string>

type ScrollReadInput = { readonly maxItems: number; readonly maxChars: number; readonly match: string | null; readonly flags: string | null }
type ScrollReadOutput = { readonly rows: string[]; readonly total: number; readonly complete: boolean }

/** Runs in the page. Self-contained: it is serialized with toString(). */
async function scrollReadInBrowser(start: Element | null, input: ScrollReadInput): Promise<ScrollReadOutput> {
  const scrollable = (element: Element): boolean => {
    const overflow = getComputedStyle(element).overflowY
    return (overflow === "auto" || overflow === "scroll" || overflow === "overlay") && element.scrollHeight > element.clientHeight + 20
  }
  if (start === document.body || start === document.documentElement) start = null
  let container: Element | null = start
  while (container && container !== document.body && !scrollable(container)) container = container.parentElement
  if (container === document.body) container = null
  if (!container) {
    if (start) {
      container = Array.from(start.querySelectorAll("*")).find(scrollable) ?? null
    } else {
      let best: Element | null = null
      for (const element of Array.from(document.querySelectorAll("*"))) {
        if (scrollable(element) && (!best || element.scrollHeight > best.scrollHeight)) best = element
      }
      container = best
    }
  }
  const scroller = container ?? document.scrollingElement ?? document.documentElement
  const root = container ?? document.body
  const matcher = input.match === null ? null : input.flags === null ? null : new RegExp(input.match, input.flags)
  const needle = input.match !== null && input.flags === null ? input.match.toLowerCase() : null
  const squash = (text: string): string => text.replace(/\s+/g, " ").trim()
  const rowSelector = "[role='option'], [role='row'], [role='listitem'], [role='treeitem'], [role='article'], li, tr, article"
  const rowsNow = (): Element[] => {
    const found = Array.from(root.querySelectorAll(rowSelector)).filter((element) => !element.querySelector(rowSelector))
    if (found.length > 0) return found
    // No list semantics: the deepest wrapper with several children holds the rows.
    let holder: Element = root
    while (holder.children.length === 1) holder = holder.children[0]!
    return Array.from(holder.children)
  }
  const seen = new Set<string>()
  const rows: string[] = []
  let total = 0
  const collect = (): void => {
    for (const element of rowsNow()) {
      const text = squash((element as HTMLElement).innerText ?? element.textContent ?? "")
      if (!text) continue
      const key = element.id || element.getAttribute("data-id") || element.getAttribute("data-key") || element.getAttribute("aria-posinset") || element.getAttribute("aria-rowindex") || text
      if (seen.has(key)) continue
      seen.add(key)
      total++
      if (matcher ? !matcher.test(text) : needle !== null && !text.toLowerCase().includes(needle)) continue
      if (rows.length < input.maxItems) rows.push(text.length > input.maxChars ? `${text.slice(0, input.maxChars - 1)}…` : text)
    }
  }
  const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
  const frame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()))
  const deadline = Date.now() + 25_000
  const original = scroller.scrollTop
  scroller.scrollTop = 0
  await frame()
  let complete = false
  let stalled = 0
  while (Date.now() < deadline && rows.length < input.maxItems) {
    collect()
    const before = scroller.scrollTop
    const height = scroller.scrollHeight
    scroller.scrollTop = before + Math.max(80, scroller.clientHeight * 0.85)
    await frame()
    await pause(40)
    if (scroller.scrollTop <= before + 1) {
      // At the end: give a list that loads more on reaching it a moment to grow.
      for (let waited = 0; waited < 600 && scroller.scrollHeight <= height; waited += 100) await pause(100)
      if (scroller.scrollHeight <= height && ++stalled >= 2) {
        complete = true
        break
      }
    } else {
      stalled = 0
    }
  }
  collect()
  scroller.scrollTop = container ? 0 : original
  return { rows, total, complete }
}

const scrollReadCapture = new Function(
  "start",
  "input",
  `const __name = (target) => target
return (${scrollReadInBrowser.toString()})(start, input)`,
) as (start: Element | null, input: ScrollReadInput) => Promise<ScrollReadOutput>

export function createScrollReadHelper(page: Page): ScrollReadHelper {
  return async (target, options = {}) => {
    const match = options.match
    const input: ScrollReadInput = {
      maxItems: Math.max(1, Math.min(5_000, Math.floor(options.maxItems ?? 1_000))),
      maxChars: Math.max(20, Math.min(2_000, Math.floor(options.maxChars ?? 120))),
      match: match === undefined ? null : typeof match === "string" ? match : match.source,
      flags: match === undefined || typeof match === "string" ? null : match.flags.replace(/[gy]/g, ""),
    }
    const locator = target === undefined ? undefined : typeof target === "string" ? page.locator(target) : target
    // With no target the page function finds the tallest scrolling container itself (it treats body as "none given").
    const result = await (locator ? locator.first() : page.locator("body")).evaluate(scrollReadCapture, input)
    const filtered = match === undefined ? "" : `, ${result.rows.length} matching`
    const note = result.complete ? "" : " (stopped before the end)"
    return [`${result.total} rows${filtered}${note}:`, ...result.rows].join("\n")
  }
}
