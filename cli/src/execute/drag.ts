import type { BrowserContext, CDPSession, Locator, Page } from "patchright-core"

/**
 * `drag(source, target)`: drag and drop that works through the relay, with trusted events.
 *
 * Playwright's own `locator.dragTo` relies on `Input.setInterceptDrags`, whose `Input.dragIntercepted` event never
 * reaches it here. An HTML5 drag then starts in the page and is never finished, and the page ignores the mouse until
 * it is reloaded. This helper drives the same gesture itself: it presses and moves the mouse over raw CDP, reads the
 * drag data the page set in `dragstart`, and delivers the drag over and the drop with `Input.dispatchDragEvent`.
 * When the press and move start no HTML5 drag (a pointer-event sortable), it simply keeps moving and releases.
 */
export type DragPosition = "center" | "before" | "after" | { readonly x: number; readonly y: number }

export type DragOptions = {
  /**
   * Where on the target to drop: its center (default), just inside its leading edge (`before`: above it in a column,
   * left of it in a row), just inside its trailing edge (`after`), or an offset from its top-left corner.
   */
  readonly position?: DragPosition
  /** Milliseconds to hold over the target before dropping, for lists that reorder on hover. Default 60. */
  readonly holdMs?: number
}

export type DragResult = {
  /** `html5` when the page started a drag-and-drop operation, `pointer` when it only saw the mouse move. */
  readonly kind: "html5" | "pointer"
}

export type DragHelper = (source: Locator | string, target: Locator | string, options?: DragOptions) => Promise<DragResult>

type Point = { readonly x: number; readonly y: number }
type Box = { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
type DragStart = { readonly items: readonly { readonly mimeType: string; readonly data: string }[]; readonly effectAllowed: string }

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Waits for the page's next `dragstart` (after its own handlers ran) and returns the data they set, or null. */
const awaitDragStart = `new Promise((resolve) => {
  const timer = setTimeout(() => { window.removeEventListener("dragstart", onStart, false); resolve(null) }, 1500)
  function onStart(event) {
    clearTimeout(timer)
    const transfer = event.dataTransfer
    const items = transfer ? Array.from(transfer.types).filter((type) => type !== "Files").map((type) => ({ mimeType: type, data: transfer.getData(type) })) : []
    resolve({ items, effectAllowed: transfer ? transfer.effectAllowed : "all" })
  }
  window.addEventListener("dragstart", onStart, { capture: false, once: true })
})`

function operationsMask(effectAllowed: string): number {
  const copy = 1
  const link = 2
  const move = 16
  switch (effectAllowed) {
    case "copy": return copy
    case "link": return link
    case "move": return move
    case "copyLink": return copy | link
    case "copyMove": return copy | move
    case "linkMove": return link | move
    case "none": return 0
    default: return copy | link | move
  }
}

function dropPoint(source: Box, target: Box, position: DragPosition): Point {
  if (typeof position === "object") return { x: target.x + position.x, y: target.y + position.y }
  const center = { x: target.x + target.width / 2, y: target.y + target.height / 2 }
  if (position === "center") return center
  const sourceCenter = { x: source.x + source.width / 2, y: source.y + source.height / 2 }
  // Items side by side form a row; otherwise the list runs down the page.
  const horizontal = Math.abs(sourceCenter.x - center.x) > Math.abs(sourceCenter.y - center.y) * 2
  const inset = (size: number): number => Math.min(4, size / 4)
  if (horizontal) return { x: position === "before" ? target.x + inset(target.width) : target.x + target.width - inset(target.width), y: center.y }
  return { x: center.x, y: position === "before" ? target.y + inset(target.height) : target.y + target.height - inset(target.height) }
}

export function createDragHelper(page: Page, context: BrowserContext): DragHelper {
  return async (source, target, options = {}) => {
    const from = typeof source === "string" ? page.locator(source) : source
    const to = typeof target === "string" ? page.locator(target) : target
    await from.scrollIntoViewIfNeeded()
    const sourceBox = await from.boundingBox()
    if (!sourceBox) throw new Error("drag: the source is not visible")
    // Scrolling the target into view may move the source; measure both after the last scroll.
    await to.scrollIntoViewIfNeeded()
    const targetBox = await to.boundingBox()
    const start = await from.boundingBox() ?? sourceBox
    if (!targetBox) throw new Error("drag: the target is not visible")
    const origin = { x: start.x + start.width / 2, y: start.y + start.height / 2 }
    const end = dropPoint(start, targetBox, options.position ?? "center")
    const along = (fraction: number): Point => ({ x: origin.x + (end.x - origin.x) * fraction, y: origin.y + (end.y - origin.y) * fraction })
    const cdp: CDPSession = await context.newCDPSession(page)
    const mouse = (type: string, point: Point, pressed: boolean) => cdp.send("Input.dispatchMouseEvent", {
      type: type as "mouseMoved",
      x: point.x,
      y: point.y,
      button: pressed || type !== "mouseMoved" ? "left" : "none",
      buttons: pressed ? 1 : 0,
      ...(type === "mouseMoved" ? {} : { clickCount: 1 }),
    })
    let pressed = false
    try {
      const started = page.mainFrame().evaluate(awaitDragStart).catch(() => null) as Promise<DragStart | null>
      await mouse("mouseMoved", origin, false)
      await mouse("mousePressed", origin, true)
      pressed = true
      // A drag starts once the pointer has travelled a few pixels with the button down.
      const length = Math.hypot(end.x - origin.x, end.y - origin.y) || 1
      const nudge = (pixels: number): Point => along(Math.min(1, pixels / length))
      for (const pixels of [3, 6, 10, 14]) await mouse("mouseMoved", nudge(pixels), true)
      const drag = await Promise.race([started, sleep(1600).then(() => null)])
      const steps = 8
      if (drag) {
        const data = { items: drag.items.map((item) => ({ mimeType: item.mimeType, data: item.data })), dragOperationsMask: operationsMask(drag.effectAllowed) }
        const over = (type: "dragEnter" | "dragOver" | "drop", point: Point) => cdp.send("Input.dispatchDragEvent", { type, x: point.x, y: point.y, data })
        await over("dragEnter", nudge(14))
        for (let step = 1; step <= steps; step++) await over("dragOver", along(step / steps))
        await sleep(options.holdMs ?? 60)
        await over("dragOver", end)
        await over("drop", end)
        await mouse("mouseReleased", end, false)
        pressed = false
        // The browser ends the source's drag only for an OS-level drag; pages tidy up in dragend, so send one.
        await from.evaluate((element) => {
          if (element.isConnected) element.dispatchEvent(new DragEvent("dragend", { bubbles: true, cancelable: false, composed: true }))
        }).catch(() => undefined)
        return { kind: "html5" }
      }
      for (let step = 1; step <= steps; step++) await mouse("mouseMoved", along(step / steps), true)
      await sleep(options.holdMs ?? 60)
      await mouse("mouseMoved", end, true)
      await mouse("mouseReleased", end, false)
      pressed = false
      return { kind: "pointer" }
    } finally {
      // Never leave the button down: the page would treat every later move as a drag.
      if (pressed) await mouse("mouseReleased", end, false).catch(() => undefined)
      await cdp.detach().catch(() => undefined)
    }
  }
}
