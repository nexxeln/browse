import { describe, expect, test } from "bun:test"
import { diffPageViews, rememberPageView, renderPageView, type PageView } from "../src/snapshot/page-view.ts"

const view = (lines: string[], extra: Partial<PageView> = {}): PageView => ({
  doc: "1",
  url: "https://app.test/",
  title: "App",
  lines,
  truncated: false,
  modal: false,
  ...extra,
})

describe("page view diff", () => {
  test("reports added and removed lines in page order", () => {
    const diff = diffPageViews(["a", "b", "c"], ["a", "x", "c", "d"])
    expect(diff.lines).toEqual(["+ x", "- b", "+ d"])
    expect(diff.added).toBe(2)
    expect(diff.removed).toBe(1)
  })

  test("a control that only got a new ref id is not a change", () => {
    const diff = diffPageViews(['[e4 button "Save"] | Total', "[e9 row] 1 | Bolt"], ['[e31 button "Save"] | Total', "[e40 row] 1 | Bolt"])
    expect(diff.lines).toEqual([])
  })
})

describe("page view rendering", () => {
  test("the first view of a document is the whole page", () => {
    expect(renderPageView(undefined, view(["# Inbox", '[e1 button "Compose"]']))).toBe(
      'Page: https://app.test/ — App\n# Inbox\n[e1 button "Compose"]',
    )
  })

  test("the same page again is one line", () => {
    const page = view(["# Inbox"])
    expect(renderPageView(page, page)).toBe("Page: unchanged")
  })

  test("a later view of the same document is only what changed", () => {
    const before = view(["# Inbox", "Row 1", "Row 2", "Row 3", "Row 4"])
    const after = view(["# Inbox", "Row 1", "Row 2", "Row 3", "Row 4", "Saved"])
    expect(renderPageView(before, after)).toBe("Page changed (+1 −0 lines).\n+ Saved")
  })

  test("a fragment navigation in the same document is a diff that names the new URL", () => {
    const before = view(["# Inbox", "Row 1", "Row 2", "Row 3", "Select a message"])
    const after = view(["# Inbox", "Row 1", "Row 2", "Row 3", "Hello Jordan"], { url: "https://app.test/#/m/1" })
    expect(renderPageView(before, after)).toBe(
      "Page changed (+1 −1 lines). Now at https://app.test/#/m/1\n+ Hello Jordan\n- Select a message",
    )
  })

  test("a new document is shown in full even at the same URL", () => {
    const before = view(["# Inbox"])
    const after = view(["# Inbox"], { doc: "2" })
    expect(renderPageView(before, after)).toBe("Page: https://app.test/ — App\n# Inbox")
  })

  test("a long run of removed lines is counted, not listed", () => {
    const before = view(["keep 1", "keep 2", "keep 3", "keep 4", "keep 5", "keep 6", "keep 7", "keep 8", "gone 1", "gone 2", "gone 3", "gone 4", "gone 5"])
    const after = view(["keep 1", "keep 2", "keep 3", "keep 4", "keep 5", "keep 6", "keep 7", "keep 8"])
    expect(renderPageView(before, after)).toBe("Page changed (+0 −5 lines).\n- gone 1\n- … 4 more lines removed")
  })
})

describe("page view under a modal dialog", () => {
  const page = view(["# Board", "Card A", "Card B"])
  const dialog = view(['[dialog "Card A"]', '[e7 button "Close"]', "[/dialog]"], { modal: true })

  test("opening a dialog shows the dialog and leaves the page behind it alone", () => {
    expect(renderPageView(page, dialog)).toBe('Page changed (+3 −0 lines).\n+ [dialog "Card A"]\n+ [e7 button "Close"]\n+ [/dialog]')
  })

  test("closing it reports what changed on the page behind", () => {
    const remembered = rememberPageView(page, dialog)
    expect(remembered.behind).toEqual(page.lines)
    const after = view(["# Board", "Card A (done)", "Card B"])
    expect(renderPageView(remembered, after)).toBe("The dialog closed. Page changed (+1 −1 lines).\n+ Card A (done)\n- Card A")
  })

  test("closing it with nothing changed says so", () => {
    expect(renderPageView(rememberPageView(page, dialog), page)).toBe("The dialog closed. Page: unchanged behind it")
  })
})
