import { describe, expect, test } from "bun:test"
import { renderPageView, type PageView } from "../src/snapshot/page-view.ts"

const view = (lines: string[]): PageView => ({
  doc: "1",
  url: "https://app.test/",
  title: "App",
  lines,
  truncated: false,
  modal: false,
})

describe("page view economy", () => {
  test("an edited line is shown once, as it now reads", () => {
    const before = view(["# Report", "Lines", "Delta Air Lines | Oct 3 | 412.60", "Marriott Marquis New York | Oct 21 | 298.00", "Total | 710.60", "Footer"])
    const after = view(["# Report", "Lines", "Delta Air Lines | Oct 3 | 412.60", "Marriott Marquis New York | Oct 21 | 289.00", "Total | 701.60", "Footer"])
    expect(renderPageView(before, after)).toBe(
      "Page changed (+2 −2 lines).\n+ Marriott Marquis New York | Oct 21 | 289.00\n+ Total | 701.60\n- Total | 710.60",
    )
  })
})
