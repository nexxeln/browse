import type { Locator, Page } from "patchright-core"

/**
 * `fillCell(row, column, value)`: set one cell of a table or grid, the way a person does. A cell that already holds
 * a field is filled directly. A spreadsheet-style cell is opened (double-click, then Enter or F2 if that did not put
 * an editor under the caret), given the value, and committed with Enter. Without it an agent spends several calls
 * discovering how a particular grid opens, fills and commits a cell.
 */
export type FillCellHelper = (row: Locator | string, column: string | number, value: string) => Promise<string>

type CellLookup = { readonly path?: string; readonly error?: string; readonly columns?: readonly string[] }

/** Runs in the page with the row element. Returns a selector for the row's cell under the named column. */
function findCellInBrowser(row: Element, column: string | number): CellLookup {
  const squash = (text: string): string => text.replace(/\s+/g, " ").trim()
  const cellSelector = "[role='gridcell'], [role='cell'], [role='rowheader'], td, th"
  const cells = Array.from(row.querySelectorAll(cellSelector)).filter((cell) => cell.closest("[role='row'], tr") === row || cell.parentElement === row)
  if (cells.length === 0) return { error: "the row has no cells" }
  const pathOf = (element: Element): string => {
    const parts: string[] = []
    for (let node: Element | null = element; node && node !== document.documentElement; node = node.parentElement) {
      if (node.id && document.querySelectorAll(`#${CSS.escape(node.id)}`).length === 1) {
        parts.unshift(`#${CSS.escape(node.id)}`)
        return parts.join(" > ")
      }
      let index = 1
      for (let sibling = node.previousElementSibling; sibling; sibling = sibling.previousElementSibling) {
        if (sibling.localName === node.localName) index++
      }
      parts.unshift(`${node.localName}:nth-of-type(${index})`)
    }
    return parts.join(" > ")
  }
  if (typeof column === "number") {
    const cell = cells[column]
    return cell ? { path: pathOf(cell) } : { error: `the row has ${cells.length} cells` }
  }
  const container = row.closest("table, [role='grid'], [role='treegrid'], [role='table']") ?? document
  const headers = Array.from(container.querySelectorAll("[role='columnheader'], thead th, tr:first-child th"))
  const names = headers.map((header) => squash((header as HTMLElement).innerText ?? header.textContent ?? "").replace(/[▲▼↑↓]/g, "").trim())
  const wanted = squash(column).toLowerCase()
  let index = names.findIndex((name) => name.toLowerCase() === wanted)
  if (index === -1) index = names.findIndex((name) => name.toLowerCase().startsWith(wanted))
  if (index === -1) index = names.findIndex((name) => name.toLowerCase().includes(wanted))
  if (index === -1) return { error: `no column "${column}"`, columns: names }
  const header = headers[index]!
  // Prefer the grid's own column number; fall back to the cell under the header, then to the same position.
  const colindex = header.getAttribute("aria-colindex")
  const byIndex = colindex ? cells.find((cell) => cell.getAttribute("aria-colindex") === colindex) : undefined
  if (byIndex) return { path: pathOf(byIndex) }
  const box = header.getBoundingClientRect()
  const middle = box.left + box.width / 2
  const under = cells.find((cell) => {
    const rect = cell.getBoundingClientRect()
    return rect.width > 0 && rect.left <= middle && middle <= rect.right
  })
  const cell = under ?? cells[index]
  return cell ? { path: pathOf(cell) } : { error: `the row has no cell under "${names[index]}"`, columns: names }
}

const findCell = new Function(
  "row",
  "column",
  `const __name = (target) => target
return (${findCellInBrowser.toString()})(row, column)`,
) as (row: Element, column: string | number) => CellLookup

/** What holds the caret: a field to fill, or nothing editable. */
const focusedEditor = `(() => {
  const active = document.activeElement
  if (!active || active === document.body) return null
  if (active instanceof HTMLSelectElement) return "select"
  if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) return active.readOnly || active.disabled ? null : "input"
  return active.isContentEditable ? "editable" : null
})()`

export function createFillCellHelper(page: Page): FillCellHelper {
  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
  const editorWithin = async (ms: number): Promise<string | null> => {
    const until = Date.now() + ms
    while (true) {
      const kind = await page.evaluate(focusedEditor) as string | null
      if (kind || Date.now() >= until) return kind
      await sleep(40)
    }
  }
  return async (row, column, value) => {
    const rowLocator = typeof row === "string"
      ? page.locator("[role='row'], tr").filter({ hasText: row })
      : row
    const count = await rowLocator.count()
    if (count !== 1) throw new Error(`fillCell: the row matched ${count} elements; pass a locator for exactly one row`)
    const lookup = await rowLocator.evaluate(findCell, column)
    if (!lookup.path) {
      throw new Error(`fillCell: ${lookup.error === "the row has no cells" ? "the first argument is not a table or grid row (it has no cells)" : lookup.error ?? "cell not found"}${lookup.columns ? `. Columns: ${lookup.columns.filter(Boolean).join(" | ")}` : ""}`)
    }
    const cell = page.locator(lookup.path)
    await cell.scrollIntoViewIfNeeded()
    const text = String(value)
    const field = cell.locator("input:not([type='hidden']):not([type='checkbox']):not([type='radio']), textarea, select, [contenteditable='true']").first()
    if (await field.count() > 0 && await field.isVisible()) {
      if (await field.evaluate((element) => element instanceof HTMLSelectElement)) await field.selectOption({ label: text }).catch(() => field.selectOption(text))
      else await field.fill(text)
      return (await cell.innerText().catch(() => "")).trim() || text
    }
    // A grid that already opened an editor over this cell (a new row starts in edit mode) is typed into as it is.
    let kind = await cell.evaluate((element) => {
      const active = document.activeElement
      if (!active || active === document.body) return null
      const editable = active instanceof HTMLSelectElement ? "select"
        : active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement ? (active.readOnly || active.disabled ? null : "input")
        : (active as HTMLElement).isContentEditable ? "editable" : null
      if (!editable) return null
      const box = element.getBoundingClientRect()
      const caret = active.getBoundingClientRect()
      const x = caret.left + caret.width / 2
      const y = caret.top + caret.height / 2
      return element.contains(active) || (box.left <= x && x <= box.right && box.top <= y && y <= box.bottom) ? editable : null
    }) as string | null
    if (!kind) {
      // An editor left open on another cell would swallow the double-click: apply it first.
      if (await page.evaluate(focusedEditor)) await page.keyboard.press("Enter")
      await cell.dblclick()
      kind = await editorWithin(600)
    }
    if (!kind) {
      await cell.click()
      await page.keyboard.press("Enter")
      kind = await editorWithin(500)
    }
    if (!kind) {
      await page.keyboard.press("F2")
      kind = await editorWithin(500)
    }
    if (!kind) throw new Error("fillCell: the cell did not open an editor on double-click, Enter or F2")
    const editor = page.locator(":focus")
    if (kind === "select") await editor.selectOption({ label: text }).catch(() => editor.selectOption(text))
    else await editor.fill(text)
    await page.keyboard.press("Enter")
    await sleep(60)
    return (await cell.innerText().catch(() => "")).trim()
  }
}
