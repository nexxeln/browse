import { describe, expect, test } from "bun:test"
import { isPageText, renderPageView, type PageView } from "../src/snapshot/page-view.ts"

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

  const rows = Array.from({ length: 12 }, (_, index) => index)
  const inbox = view([
    'N | Northwind Mail | [e1 searchbox "Search mail"] | JL',
    '[e2 button "Compose"]',
    "# Inbox | 34 conversations",
    ...rows.map((index) => `- [e${index + 3} button "Sender ${index} Nov ${index + 1} Subject number ${index} with a preview of the message body"]`),
    "## Kontor kickoff next week",
    "Priya Raman <priya.raman@northwind.dev>",
    "Hi Jordan, now that the contract is signed, could you set up the kickoff? Wednesday the 11th at 2:00 PM, 45 minutes.",
  ])

  test("text that is the page's own innerText is recognised", () => {
    const innerText = [
      "N",
      "Northwind Mail",
      "JL",
      "Compose",
      "Inbox",
      "34 conversations",
      ...rows.map((index) => `Sender ${index}\nNov ${index + 1}\nSubject number ${index} with a preview of the message body`),
      "Kontor kickoff next week",
      "Priya Raman <priya.raman@northwind.dev>",
      "Hi Jordan, now that the contract is signed, could you set up the kickoff? Wednesday the 11th at 2:00 PM, 45 minutes.",
    ].join("\n")
    expect(isPageText(innerText, inbox)).toBe(true)
  })

  test("text from somewhere else, or a short answer, is left alone", () => {
    const other = Array.from({ length: 30 }, (_, index) => `Dock model ${index}: dual 4K at 60 Hz, 100 W charging, price ${100 + index}.99`).join("\n")
    expect(isPageText(other, inbox)).toBe(false)
    expect(isPageText("Inbox\n34 conversations", inbox)).toBe(false)
  })
})

describe("returned text the page view already showed", () => {
  const { comparableText, elideShownText, elideShownValue } = require("../src/snapshot/page-view.ts") as typeof import("../src/snapshot/page-view.ts")
  const listing = Array.from({ length: 10 }, (_, index) => `Sender number ${index} wrote about subject ${index} this week`)
  const shown = comparableText(["Northwind Mail", "Compose", ...listing].join("\n"))
  const body = ["Kontor kickoff next week", "Hi Jordan, could you set up the kickoff for Wednesday the 11th at 2:00 PM?"]

  test("a long run of lines the agent was already sent is replaced by one marker", () => {
    const returned = ["Northwind Mail", "Compose", ...listing, ...body].join("\n")
    const result = elideShownText(returned, shown)
    expect(result.text).toBe(["[… 12 lines of the page, as in the page view …]", ...body].join("\n"))
    expect(result.elided).toBeGreaterThan(400)
  })

  test("new text, short text and brief quotes of the page are untouched", () => {
    const fresh = Array.from({ length: 12 }, (_, index) => `Receipt line ${index}: item ${index} at ${index}.99 dollars each, two units`).join("\n")
    expect(elideShownText(fresh, shown).text).toBe(fresh)
    expect(elideShownText("Compose\nNorthwind Mail", shown).text).toBe("Compose\nNorthwind Mail")
    const quoting = [...listing.slice(0, 3), ...Array.from({ length: 8 }, (_, index) => `A new paragraph ${index} that the page view never contained before now`)].join("\n")
    expect(elideShownText(quoting, shown).text).toBe(quoting)
  })

  test("strings inside returned arrays and objects are trimmed too", () => {
    const page = ["Northwind Mail", "Compose", ...listing].join("\n")
    const value = { first: `${page}\n${body[0]}`, count: 2, nested: [`${page}\n${body[1]}`] }
    expect(elideShownValue(value, shown)).toEqual({
      first: `[… 12 lines of the page, as in the page view …]\n${body[0]}`,
      count: 2,
      nested: [`[… 12 lines of the page, as in the page view …]\n${body[1]}`],
    })
  })
})
