import type { Page } from "patchright-core"
import { snapshotRefIdentity } from "./diff-and-format.ts"
import type { SnapshotHelper, SnapshotRefRegistry } from "./types.ts"

/**
 * The page view: what a person would read on the page, one visual row per line, with each control written where it
 * sits as `[e12 button "Save"]`. An execute result carries it so an agent sees the page (and afterwards what its code
 * changed) without spending a call on a snapshot or a text read.
 */

type PageViewInput = {
  /** `[ref id, selector, label]` for every control the snapshot gave a ref. */
  readonly refs: readonly (readonly [string, string, string])[]
  readonly maxTokens: number
  readonly maxLine: number
}

type PageViewCapture = {
  readonly lines: string[]
  /** Selectors of the elements the view marked `\u0001<index>\u0001`: ones the snapshot gave no ref. */
  readonly minted: string[]
  readonly truncated: boolean
  /** A modal dialog is open: the lines are the dialog's, since the page behind it can't be used. */
  readonly modal: boolean
  readonly text: string
}

/** Identifies the loaded document: it survives hash and history navigations, and changes on a real load. */
const documentKeySource = "String(performance.timeOrigin)"

/** Runs in the page. Self-contained: it is serialized with toString(). */
function pageViewInBrowser(input: PageViewInput): PageViewCapture {
  type Token = {
    text: string
    top: number
    bottom: number
    left: number
    lastTop: number
    lastBottom: number
    lastRight: number
    block: Element | null
    control: boolean
    lead?: string
    breakBefore?: boolean
    breakAfter?: boolean
  }
  const refByElement = new Map<Element, { readonly id: string; readonly label: string }>()
  for (const [id, selector, label] of input.refs) {
    try {
      const element = document.querySelector(selector)
      if (element && !refByElement.has(element)) refByElement.set(element, { id, label })
    } catch {
      // A selector this document can't parse (a frame's, or a shadow path) just gets no inline ref.
    }
  }
  const tokens: Token[] = []
  let truncated = false
  // Elements the snapshot gave no ref get one here: a placeholder the relay replaces with an id, and a selector.
  const minted: string[] = []
  const mintedByElement = new Map<Element, string>()
  const escapeId = (id: string): string => typeof CSS !== "undefined" && CSS.escape ? CSS.escape(id) : id.replace(/[^\w-]/g, "\\$&")
  const pathOf = (element: Element): string | undefined => {
    const scope = element.getRootNode()
    if (scope !== document) {
      // Inside a shadow tree: the host's path, then a descendant step, which Playwright's CSS takes through open roots.
      if (!(scope instanceof ShadowRoot) || scope.mode !== "open") return undefined
      const host = pathOf(scope.host)
      if (!host) return undefined
      const inner: string[] = []
      for (let node: Element | null = element; node; node = node.parentElement) {
        let index = 1
        for (let sibling = node.previousElementSibling; sibling; sibling = sibling.previousElementSibling) {
          if (sibling.localName === node.localName) index++
        }
        inner.unshift(`${node.localName}:nth-of-type(${index})`)
      }
      return `${host} ${inner.join(" > ")}`
    }
    const parts: string[] = []
    let node: Element | null = element
    while (node && node !== document.documentElement) {
      if (node.id && document.querySelectorAll(`#${escapeId(node.id)}`).length === 1) {
        parts.unshift(`#${escapeId(node.id)}`)
        return parts.join(" > ")
      }
      if (node === document.body) {
        parts.unshift("body")
        return parts.join(" > ")
      }
      let index = 1
      for (let sibling = node.previousElementSibling; sibling; sibling = sibling.previousElementSibling) {
        if (sibling.localName === node.localName) index++
      }
      parts.unshift(`${node.localName}:nth-of-type(${index})`)
      node = node.parentElement
    }
    return undefined
  }
  const mint = (element: Element): string | undefined => {
    const existing = mintedByElement.get(element)
    if (existing) return existing
    if (minted.length >= 600) return undefined
    const selector = pathOf(element)
    if (!selector) return undefined
    const placeholder = `\u0001${minted.length}\u0001`
    minted.push(selector)
    mintedByElement.set(element, placeholder)
    return placeholder
  }
  const styles = new WeakMap<Element, CSSStyleDeclaration>()
  const styleOf = (element: Element): CSSStyleDeclaration => {
    let style = styles.get(element)
    if (!style) {
      style = getComputedStyle(element)
      styles.set(element, style)
    }
    return style
  }
  const blocks = new WeakMap<Element, Element | null>()
  const blockOf = (element: Element | null): Element | null => {
    if (!element) return null
    if (blocks.has(element)) return blocks.get(element) ?? null
    const display = styleOf(element).display
    const block = display.startsWith("inline") || display === "contents" ? blockOf(element.parentElement) : element
    blocks.set(element, block)
    return block
  }
  const squash = (text: string): string => text.replace(/\s+/g, " ")
  const clip = (text: string, limit: number): string => text.length > limit ? `${text.slice(0, limit - 1)}…` : text
  const quote = (text: string): string => `"${text.replace(/"/g, "'")}"`
  const range = document.createRange()
  const skipped = new Set(["script", "style", "noscript", "template", "head", "meta", "link", "title", "datalist", "option", "optgroup", "video", "audio", "object", "embed", "map", "area"])
  const typedInputs = new Set(["date", "time", "datetime-local", "month", "week", "number", "email", "tel", "url", "password", "color", "range", "file", "search"])
  let pendingLead: string | undefined
  let pendingBreak = false
  let insideClickable = false
  const push = (token: Omit<Token, "lead" | "breakBefore">): void => {
    if (tokens.length >= input.maxTokens) {
      truncated = true
      return
    }
    tokens.push({ ...token, ...(pendingLead ? { lead: pendingLead } : {}), ...(pendingBreak ? { breakBefore: true } : {}) })
    pendingLead = undefined
    pendingBreak = false
  }
  const rectToken = (text: string, rect: DOMRect, block: Element | null, control: boolean): void => {
    push({ text, top: rect.top, bottom: rect.bottom, left: rect.left, lastTop: rect.top, lastBottom: rect.bottom, lastRight: rect.right, block, control })
  }
  const controlText = (element: Element, ref: { readonly id: string; readonly label: string } | undefined): string | undefined => {
    const extras: string[] = []
    let label = ref?.label
    if (element instanceof HTMLSelectElement) {
      const options = Array.from(element.options).map((option) => clip(squash(option.textContent ?? "").trim(), 40))
      label = label?.replace(/\s*\d+ options\b/, "")
      // Every option the agent may have to pick, so it need not probe the list: up to 40, within 700 characters.
      let shown = 0
      let size = 0
      while (shown < options.length && shown < 40 && size + options[shown]!.length <= 700) size += options[shown++]!.length + 3
      if (options.length > 0) extras.push(`options: ${options.slice(0, shown).join(" | ")}${options.length > shown ? ` | … ${options.length - shown} more` : ""}`)
    } else if (element instanceof HTMLInputElement) {
      if (element.type === "hidden") return undefined
      if (typedInputs.has(element.type)) extras.push(`type=${element.type}`)
      if (element.type !== "password" && element.type !== "checkbox" && element.type !== "radio" && element.type !== "file" && element.value && !/\bvalue="/.test(label ?? "")) {
        extras.push(`value=${quote(clip(squash(element.value), 80))}`)
      } else if (element.placeholder && !element.value) {
        extras.push(`placeholder=${quote(clip(squash(element.placeholder), 40))}`)
      }
      for (const attribute of ["min", "max", "step"]) {
        const value = element.getAttribute(attribute)
        if (value) extras.push(`${attribute}=${value}`)
      }
      if (element.required) extras.push("required")
    } else if (element instanceof HTMLTextAreaElement) {
      if (element.value && !/\bvalue="/.test(label ?? "")) extras.push(`value=${quote(clip(squash(element.value), 120))}`)
      else if (element.placeholder) extras.push(`placeholder=${quote(clip(squash(element.placeholder), 40))}`)
    }
    if (element.getAttribute("aria-pressed") === "true" && !/\bpressed\b/.test(label ?? "")) extras.push("pressed")
    if ((element as HTMLElement).draggable === true && element.localName !== "a" && element.localName !== "img") extras.push("draggable")
    label = label?.replace(/ selected=false\b/, "")
    if (!label) {
      const role = element.getAttribute("role") || (element instanceof HTMLInputElement ? (element.type === "checkbox" || element.type === "radio" ? element.type : "textbox") : element.localName === "a" ? "link" : element.localName)
      const labelled = (element as HTMLInputElement).labels?.[0]?.textContent
      const name = clip(squash(element.getAttribute("aria-label") || labelled || (element as HTMLElement).innerText || element.getAttribute("placeholder") || element.getAttribute("name") || element.getAttribute("title") || "").trim(), 80)
      const state: string[] = []
      if (element instanceof HTMLInputElement && (element.type === "checkbox" || element.type === "radio")) state.push(element.checked ? "checked" : "unchecked")
      if ((element as HTMLButtonElement).disabled === true || element.getAttribute("aria-disabled") === "true") state.push("disabled")
      label = [role, name ? quote(name) : "", ...state].filter(Boolean).join(" ")
    }
    const disabled = (element as HTMLButtonElement).disabled === true || element.getAttribute("aria-disabled") === "true"
    return `[${[ref?.id ?? (disabled ? undefined : mint(element)), label, ...extras].filter(Boolean).join(" ")}]`
  }
  const emitControl = (element: Element, ref: { readonly id: string; readonly label: string } | undefined): void => {
    const text = controlText(element, ref)
    if (!text) return
    let rect = element.getBoundingClientRect()
    if (rect.width < 1 && rect.height < 1 && element.parentElement) rect = element.parentElement.getBoundingClientRect()
    // A control laid out as a block (a list row that is a button, an option) is a line of its own.
    const display = styleOf(element).display
    const inline = display.startsWith("inline") || display === "contents"
    rectToken(text, rect, inline ? blockOf(element.parentElement) : element, true)
  }
  const nativeControls = new Set(["input", "select", "textarea", "button"])
  const headingLevel = (element: Element): number | undefined => {
    const match = /^h([1-6])$/.exec(element.localName)
    if (match) return Number(match[1])
    if (element.getAttribute("role") === "heading") return Number(element.getAttribute("aria-level")) || 2
    return undefined
  }
  const visit = (node: Node): void => {
    if (tokens.length >= input.maxTokens) {
      truncated = true
      return
    }
    if (node.nodeType === Node.TEXT_NODE) {
      const raw = node.nodeValue ?? ""
      const text = squash(raw)
      if (!text.trim()) {
        const last = tokens[tokens.length - 1]
        if (last && !last.text.endsWith(" ")) last.text += " "
        return
      }
      const parent = node.parentElement
      if (!parent || styleOf(parent).visibility === "hidden") return
      range.selectNodeContents(node)
      const rects = range.getClientRects()
      if (rects.length === 0) return
      const first = rects[0]!
      const last = rects[rects.length - 1]!
      const bounds = range.getBoundingClientRect()
      if (bounds.width <= 1 && bounds.height <= 1) return
      if (bounds.right < -2000 || bounds.bottom + window.scrollY < -2000) return
      push({ text, top: first.top, bottom: first.bottom, left: first.left, lastTop: last.top, lastBottom: last.bottom, lastRight: last.right, block: blockOf(parent), control: false })
      return
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return
    const element = node as Element
    const tag = element.localName
    if (skipped.has(tag)) return
    const style = styleOf(element)
    if (style.display === "none") return
    if (tag === "br" || tag === "hr") {
      pendingBreak = true
      return
    }
    const ref = refByElement.get(element)
    if (ref || nativeControls.has(tag)) {
      if (style.visibility === "hidden" && !ref) return
      emitControl(element, ref)
      return
    }
    if (tag === "label") {
      const control = (element as HTMLLabelElement).control
      if (control && refByElement.has(control)) {
        // The control's own token already carries this label as its name.
        if (element.contains(control)) emitControl(control, refByElement.get(control))
        return
      }
    }
    if (tag === "img") {
      const alt = squash(element.getAttribute("alt") ?? "").trim()
      if (alt && style.visibility !== "hidden") rectToken(`[img ${quote(clip(alt, 60))}]`, element.getBoundingClientRect(), blockOf(element.parentElement), true)
      return
    }
    if (tag === "canvas") {
      // Drawn content has no text to read: name it and give it a ref, so the agent can look at it.
      const rect = element.getBoundingClientRect()
      if (rect.width >= 40 && rect.height >= 40 && style.visibility !== "hidden") {
        const name = squash(element.getAttribute("aria-label") || element.getAttribute("title") || "").trim()
        const id = mint(element)
        const look = id ? `(drawn, no text: return await ref("${id}").screenshot() to see it)` : "(drawn, no text: screenshot it to see it)"
        rectToken(`[${[id, "canvas", name ? quote(clip(name, 60)) : "", look].filter(Boolean).join(" ")}]`, rect, blockOf(element.parentElement), true)
      }
      return
    }
    if (tag === "svg") {
      const name = squash(element.getAttribute("aria-label") ?? "").trim()
      if (name) rectToken(`[img ${quote(clip(name, 60))}]`, element.getBoundingClientRect(), blockOf(element.parentElement), true)
      return
    }
    if (tag === "iframe" || tag === "frame") {
      rectToken(`[iframe ${quote(clip(element.getAttribute("title") || element.getAttribute("name") || element.getAttribute("src") || "", 80))}: snapshot() shows its content]`, element.getBoundingClientRect(), blockOf(element.parentElement), true)
      return
    }
    const level = headingLevel(element)
    const role = element.getAttribute("role")
    const isDialog = (tag === "dialog" || role === "dialog" || role === "alertdialog") && style.visibility !== "hidden"
    const start = tokens.length
    if (isDialog) {
      const labelled = element.getAttribute("aria-labelledby")
      const name = squash(element.getAttribute("aria-label") || (labelled ? document.getElementById(labelled)?.textContent : "") || "").trim()
      pendingBreak = true
      rectToken(`[dialog${name ? ` ${quote(clip(name, 60))}` : ""}]`, element.getBoundingClientRect(), null, true)
      tokens[tokens.length - 1]!.breakAfter = true
    }
    if (level !== undefined) pendingLead = `${"#".repeat(level)} `
    else if (tag === "li" || role === "listitem") pendingLead = "- "
    // What a person can grab or click that isn't a control: marked where its content starts, with a ref to act on.
    const draggable = (element as HTMLElement).draggable === true && tag !== "a"
    // A data row of an interactive grid: one ref per row keeps the view compact, and its cells are reachable from it.
    const gridRow = role === "row" && element.closest("[role='grid'], [role='treegrid']") !== null && !element.querySelector("[role='columnheader']")
    const clickable = !draggable && !insideClickable && tag !== "body" && tag !== "html" && (
      element.hasAttribute("onclick") ||
      gridRow ||
      (style.cursor === "pointer" && (!element.parentElement || styleOf(element.parentElement).cursor !== "pointer"))
    )
    const marksRegion = draggable || clickable
    const outerClickable = insideClickable
    if (marksRegion) insideClickable = true
    const root = element.shadowRoot
    for (let child = (root ?? element).firstChild; child; child = child.nextSibling) visit(child)
    insideClickable = outerClickable
    if (marksRegion && tokens.length > start) {
      const first = tokens[start]!
      const id = mint(element)
      first.text = `[${[id, draggable ? "draggable" : gridRow ? "row" : "clickable"].filter(Boolean).join(" ")}] ${first.text}`
    }
    if (level !== undefined || tag === "li" || role === "listitem") pendingLead = undefined
    // A list that shows only part of itself: say so, and how to read all of it in one call.
    if (tokens.length > start && tag !== "body" && tag !== "html" && (style.overflowY === "auto" || style.overflowY === "scroll") && element.scrollHeight > element.clientHeight * 1.5 + 100) {
      const id = mint(element)
      if (id) {
        pendingBreak = true
        rectToken(`[${id} scrolls: only the rows in view are listed. If you need the others, await scrollRead(ref("${id}"), { match: /…/i }) returns them as text]`, element.getBoundingClientRect(), null, true)
        tokens[tokens.length - 1]!.breakAfter = true
      }
    }
    if (isDialog) {
      pendingBreak = true
      rectToken("[/dialog]", element.getBoundingClientRect(), null, true)
      tokens[tokens.length - 1]!.breakAfter = true
    }
  }
  // A modal dialog makes the page behind it inert, so only the dialog is worth reading (and only it has refs).
  const modals = Array.from(document.querySelectorAll("dialog[open], [aria-modal='true']")).filter((element) => {
    if (styleOf(element).display === "none" || styleOf(element).visibility === "hidden") return false
    if (element.localName === "dialog") {
      try {
        return element.matches(":modal")
      } catch {
        return false
      }
    }
    return true
  })
  const modal = modals[modals.length - 1]
  if (modal) visit(modal)
  else if (document.body) visit(document.body)

  // A form that sits in the page inside a closed dialog: list its fields, so the agent can open the dialog and
  // fill it in one call instead of opening it first to find out what it asks for.
  if (!modal) {
    const closed = Array.from(document.querySelectorAll("dialog:not([open]), [role='dialog'], [role='alertdialog']")).filter((element) => {
      if (element.localName !== "dialog" && styleOf(element).display !== "none") return false
      return element.querySelector("input:not([type='hidden']), select, textarea") !== null
    }).slice(0, 3)
    const nowhere = new DOMRect(0, 0, 0, 0)
    const line = (text: string): void => {
      pendingBreak = true
      rectToken(text, nowhere, null, true)
      tokens[tokens.length - 1]!.breakAfter = true
    }
    for (const dialog of closed) {
      const labelledBy = dialog.getAttribute("aria-labelledby")
      const heading = dialog.querySelector("h1, h2, h3, [role='heading'], legend")
      const name = squash(dialog.getAttribute("aria-label") || (labelledBy ? document.getElementById(labelledBy)?.textContent : "") || heading?.textContent || "").trim()
      const fields = Array.from(dialog.querySelectorAll("input:not([type='hidden']), select, textarea, button")).slice(0, 16)
      line(`[closed dialog${name ? ` ${quote(clip(name, 60))}` : ""}: not open yet; once you open it, it has]`)
      for (const field of fields) {
        // What a field holds while its dialog is closed is whatever was typed last: not shown, so that submitting
        // the form does not read as a change to the page.
        const text = controlText(field, refByElement.get(field))?.replace(/ value="[^"]*"/, "")
        if (text) line(text)
      }
      line("[/closed dialog]")
    }
  }

  const lines: string[] = []
  let current = ""
  let previous: Token | undefined
  const flush = (): void => {
    const line = squash(current).trim()
    if (line) lines.push(clip(line, input.maxLine))
    current = ""
  }
  for (const token of tokens) {
    const text = `${token.lead ?? ""}${token.text}`
    if (!previous || token.breakBefore || previous.breakAfter) {
      flush()
      current = text
    } else if (token.block !== null && token.block === previous.block) {
      current += token.control || previous.control ? ` ${text}` : text
    } else {
      const height = Math.min(previous.lastBottom - previous.lastTop, token.bottom - token.top)
      const overlap = Math.min(previous.lastBottom, token.bottom) - Math.max(previous.lastTop, token.top)
      const sameRow = height > 0 && overlap > height * 0.5 && token.left >= previous.lastRight - 4
      if (sameRow) {
        current += ` | ${text}`
      } else {
        flush()
        current = text
      }
    }
    previous = token
  }
  flush()
  // The page's text as innerText gives it: what returned text is compared against, to trim repeats of the page.
  const text = ((document.body as HTMLElement | null)?.innerText ?? "").slice(0, 80_000)
  return { lines, minted, truncated, modal: modal !== undefined, text }
}

const pageViewCapture = new Function(
  "input",
  `const __name = (target) => target
return (${pageViewInBrowser.toString()})(input)`,
) as (input: PageViewInput) => PageViewCapture

const settleSource = `new Promise((resolve) => {
  let quiet = window.setTimeout(done, 90)
  const max = window.setTimeout(done, 700)
  const observer = new MutationObserver(() => {
    window.clearTimeout(quiet)
    quiet = window.setTimeout(done, 70)
  })
  function done() {
    observer.disconnect()
    window.clearTimeout(quiet)
    window.clearTimeout(max)
    resolve()
  }
  if (document.body) observer.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true })
  else done()
})`

export type PageView = {
  /** The document the view was taken from; a different one means the page really loaded again. */
  readonly doc: string
  readonly url: string
  readonly title: string
  readonly lines: readonly string[]
  readonly truncated: boolean
  /** The lines are a modal dialog's; `behind` is the page as it was last seen without one. */
  readonly modal: boolean
  readonly behind?: readonly string[]
  /** The page's own text (innerText) when the view was taken, for trimming it out of returned values. */
  readonly text?: string
}

const viewSnapshotItems = 200
const viewMemoryLimit = 2_000
const viewMaxTokens = 4_000
const viewMaxLine = 2_000

/** Waits for the page's DOM to go quiet (at most 0.7s), so a view taken right after an action shows its effect. */
export async function settlePage(page: Page): Promise<void> {
  await page.evaluate(settleSource).catch(() => undefined)
}

/**
 * Captures the page view. It takes a compact snapshot first, so every control in the view has a ref that `ref()`
 * resolves; the caller's own `snapshot({ diff })` baseline is put back afterwards.
 */
export async function capturePageView(page: Page, snapshot: SnapshotHelper, registry: SnapshotRefRegistry): Promise<PageView> {
  const baseline = registry.previousSnapshot
  const url = String(await page.mainFrame().evaluate(documentKeySource))
  const memory = registry.viewMemory?.page === page && registry.viewMemory.url === url ? registry.viewMemory.entries : []
  // snapshot() reuses the ids of its previous capture; give it everything the view has ever shown on this document.
  if (memory.length > 0) registry.previousSnapshot = { page, signature: "page-view", entries: memory }
  await snapshot({ maxItems: viewSnapshotItems, frames: false, timeout: 4_000 })
  // A ref names the element at its place in the page, checked by role. The accessible name is left out of the check:
  // it changes under the agent's own edits (a row titled with the name just typed into it), and a ref that then
  // refuses to resolve costs a whole call.
  for (const [id, target] of registry.selectors) {
    if (target.name !== undefined) {
      const { name: _name, ...rest } = target
      registry.selectors.set(id, rest)
    }
  }
  const captured = registry.previousSnapshot?.entries ?? []
  const refs: [string, string, string][] = []
  const present = new Set<string>()
  for (const entry of captured) {
    const identity = snapshotRefIdentity(entry)
    if (identity) present.add(identity)
    if (!entry.refId || !entry.selector || entry.frameKey) continue
    const label = entry.prefix.trim().replace(/^- /, "")
    refs.push([entry.refId, entry.selector, entry.details ? `${label} ${entry.details}` : label])
  }
  const absent = memory.filter((entry) => {
    const identity = snapshotRefIdentity(entry)
    return identity !== undefined && !present.has(identity)
  })
  registry.viewMemory = { page, url, entries: [...absent.slice(-viewMemoryLimit), ...captured] }
  if (baseline && baseline.page === page) registry.previousSnapshot = baseline
  const capture = await page.mainFrame().evaluate(pageViewCapture, { refs, maxTokens: viewMaxTokens, maxLine: viewMaxLine })
  // Give the view's own elements ids from the same counter as the snapshot's, and keep each selector's id for as
  // long as the document lives. They resolve by selector alone: the view shows the element, not an accessible name.
  const mintedIds = registry.viewMinted?.page === page && registry.viewMinted.url === url ? registry.viewMinted.ids : new Map<string, string>()
  let nextRef = registry.nextRef ?? 1
  const ids = capture.minted.map((selector) => {
    let id = mintedIds.get(selector)
    if (!id) {
      id = `e${nextRef++}`
      mintedIds.set(selector, id)
    }
    registry.selectors.set(id, { selector, role: "generic" })
    return id
  })
  registry.nextRef = nextRef
  registry.viewMinted = { page, url, ids: mintedIds }
  // A ref shown earlier on this document still resolves when its element is not in this view (a list that got
  // shorter, a closed menu): an agent holding it gets the element if it is there, not "unknown ref".
  for (const [selector, id] of mintedIds) {
    if (!registry.selectors.has(id)) registry.selectors.set(id, { selector, role: "generic" })
  }
  for (const entry of absent) {
    if (entry.refId && entry.selector && entry.role && !entry.frameKey && !registry.selectors.has(entry.refId)) {
      registry.selectors.set(entry.refId, { selector: entry.selector, role: entry.role })
    }
  }
  const placeholder = /\u0001(\d+)\u0001/g
  const withIds = capture.lines.map((line) => line.replace(placeholder, (_match, index: string) => ids[Number(index)] ?? "?"))
  return { doc: url, url: page.url(), title: await page.title().catch(() => ""), lines: collapseRuns(withIds), truncated: capture.truncated, modal: capture.modal, text: capture.text }
}

function collapseRuns(lines: readonly string[]): string[] {
  const output: string[] = []
  let run = 1
  for (const [index, line] of lines.entries()) {
    if (index > 0 && line === lines[index - 1]) {
      run++
      continue
    }
    if (run > 1) output[output.length - 1] += ` (×${run})`
    run = 1
    output.push(line)
  }
  if (run > 1) output[output.length - 1] += ` (×${run})`
  return output
}

const refPattern = /\[e\d+([ \]])/g
const comparable = (line: string): string => line.replace(refPattern, "[$1")

/** Lines added to and removed from a view, in page order, ignoring ref renumbering. */
export function diffPageViews(previous: readonly string[], current: readonly string[]): { readonly added: number; readonly removed: number; readonly lines: string[] } {
  const a = previous.map(comparable)
  const b = current.map(comparable)
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head++
  let tail = 0
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++
  const left = a.slice(head, a.length - tail)
  const right = b.slice(head, b.length - tail)
  const lines: string[] = []
  let added = 0
  let removed = 0
  // Longest common subsequence over the changed middle; views are a few hundred lines at most.
  if (left.length * right.length > 250_000) {
    for (const [index] of left.entries()) lines.push(`- ${previous[head + index]}`)
    for (const [index] of right.entries()) lines.push(`+ ${current[head + index]}`)
    return { added: right.length, removed: left.length, lines }
  }
  const table: Uint16Array[] = Array.from({ length: left.length + 1 }, () => new Uint16Array(right.length + 1))
  for (let i = left.length - 1; i >= 0; i--) {
    for (let j = right.length - 1; j >= 0; j--) {
      table[i]![j] = left[i] === right[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!)
    }
  }
  let i = 0
  let j = 0
  while (i < left.length || j < right.length) {
    if (i < left.length && j < right.length && left[i] === right[j]) {
      i++
      j++
    } else if (j < right.length && (i >= left.length || table[i]![j + 1]! >= table[i + 1]![j]!)) {
      lines.push(`+ ${current[head + j]}`)
      added++
      j++
    } else {
      lines.push(`- ${previous[head + i]}`)
      removed++
      i++
    }
  }
  return { added, removed, lines }
}

const fullViewLimit = 9_000
const diffViewLimit = 5_000
const removedLineLimit = 100

function bounded(lines: readonly string[], limit: number, more: string): string {
  let size = 0
  const kept: string[] = []
  for (const line of lines) {
    if (size + line.length + 1 > limit) {
      kept.push(`… ${lines.length - kept.length} more lines: ${more}`)
      break
    }
    kept.push(line)
    size += line.length + 1
  }
  return kept.join("\n")
}

/** The start of a line, without its refs: two lines that share it are one line before and after an edit. */
const stem = (line: string): string => comparable(line.slice(2)).slice(0, 24)

/**
 * Drops the old half of an edited line. A change shows as the old line removed and the new one added; the new one
 * says everything, so within a block of changes a removed line is kept only when no added line starts like it.
 */
function dropReplacedLines(lines: readonly string[]): string[] {
  const output: string[] = []
  for (let start = 0; start < lines.length;) {
    let end = start
    while (end < lines.length && (lines[end]!.startsWith("+ ") || lines[end]!.startsWith("- "))) end++
    if (end === start) {
      output.push(lines[start]!)
      start++
      continue
    }
    const block = lines.slice(start, end)
    const added = new Set(block.filter((line) => line.startsWith("+ ")).map(stem))
    for (const line of block) {
      if (line.startsWith("- ") && stem(line).length >= 8 && added.has(stem(line))) continue
      output.push(line)
    }
    start = end
  }
  return output
}

/** What went away matters less than what appeared: removed lines are clipped, and a long run of them is counted. */
function compactRemovals(lines: readonly string[]): string[] {
  const output: string[] = []
  let run: string[] = []
  const flush = (): void => {
    if (run.length === 0) return
    const clipped = run.map((line) => line.length > removedLineLimit ? `${line.slice(0, removedLineLimit - 1)}…` : line)
    if (clipped.length <= 3) output.push(...clipped)
    else output.push(clipped[0]!, `- … ${clipped.length - 1} more lines removed`)
    run = []
  }
  for (const line of lines) {
    if (line.startsWith("- ")) {
      run.push(line)
      continue
    }
    flush()
    output.push(line)
  }
  flush()
  return output
}

const readMore = "read a part with page.locator(sel).innerText() or snapshot({ within: sel })"

/**
 * The view to remember after rendering `current`: a modal's view keeps the page it opened over, so closing it is
 * reported as what changed on that page.
 */
export function rememberPageView(previous: PageView | undefined, current: PageView): PageView {
  if (!current.modal || !previous || previous.doc !== current.doc) return current
  const behind = previous.modal ? previous.behind : previous.lines
  return behind ? { ...current, behind } : current
}

/** The text an execute result carries for a view: the whole page the first time or after it moved, else what changed. */
export function renderPageView(previous: PageView | undefined, current: PageView): string {
  const header = `Page: ${current.url}${current.title ? ` — ${current.title}` : ""}`
  const note = current.modal ? "\n(a modal dialog is open; the page behind it is not shown)" : ""
  const full = (): string => `${header}${note}\n${bounded(current.lines, fullViewLimit, readMore)}${current.truncated ? "\n… the page continues" : ""}`
  if (!previous || previous.doc !== current.doc) return full()
  // Compare like with like: a dialog against the dialog that was open, the page against the page behind it.
  const before = current.modal
    ? (previous.modal ? previous.lines : [])
    : (previous.modal ? previous.behind : previous.lines)
  if (before === undefined) return full()
  const diff = diffPageViews(before, current.lines)
  const closed = previous.modal && !current.modal ? "The dialog closed. " : ""
  const moved = previous.url !== current.url ? ` Now at ${current.url}` : ""
  if (diff.lines.length === 0) return closed ? `${closed}Page: unchanged behind it${moved}` : `Page: unchanged${moved}`
  if (!current.modal && diff.added > current.lines.length * 0.6 && current.lines.join("\n").length <= fullViewLimit) return full()
  const text = bounded(compactRemovals(dropReplacedLines(diff.lines)), diffViewLimit, readMore)
  return `${closed}Page changed (+${diff.added} −${diff.removed} lines).${moved}\n${text}`
}
