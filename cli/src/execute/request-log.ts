import type { BrowserContext, Request, Response } from "patchright-core"

/**
 * The writes a page made while execute code ran: `POST /api/events {"title":"Board prep"} → 201`. An agent reads
 * these as proof its action reached the server, instead of re-reading the page to check.
 */
export type RequestTracker = {
  /** True while a tracked request has no response yet. */
  readonly pending: () => boolean
  /** Stops listening and returns one line per request, in the order they started. */
  readonly stop: () => string[]
}

type Entry = {
  readonly method: string
  readonly url: string
  readonly body: string | undefined
  status: string | undefined
}

const maxEntries = 40
const maxLines = 12
const bodyLimit = 200
const readWaitMs = 2_500
const quietMethods = new Set(["GET", "HEAD", "OPTIONS"])

const squash = (text: string): string => text.replace(/\s+/g, " ").trim()
const clip = (text: string, limit: number): string => text.length > limit ? `${text.slice(0, limit - 1)}…` : text

function shortUrl(url: string, pageUrl: string): string {
  try {
    const parsed = new URL(url)
    const sameOrigin = parsed.origin === new URL(pageUrl).origin
    return clip(`${sameOrigin ? "" : parsed.origin}${parsed.pathname}${parsed.search}`, 160)
  } catch {
    return clip(url, 160)
  }
}

export function trackRequests(context: BrowserContext, pageUrl: () => string): RequestTracker {
  const entries: Entry[] = []
  const byRequest = new Map<Request, Entry>()
  let dropped = 0
  // Reads the page started (a search, a list load) are not listed, but the page view waits for them to land.
  const reads = new Map<Request, number>()
  const onRequest = (request: Request): void => {
    try {
      const method = request.method()
      if (quietMethods.has(method)) {
        const type = request.resourceType()
        if ((type === "fetch" || type === "xhr") && reads.size < 200) reads.set(request, Date.now())
        return
      }
      if (entries.length >= maxEntries) {
        dropped++
        return
      }
      const data = request.postData()
      const entry: Entry = { method, url: request.url(), body: data ? clip(squash(data), bodyLimit) : undefined, status: undefined }
      entries.push(entry)
      byRequest.set(request, entry)
    } catch {
      // A request from a page that closed under us is not worth failing the call for.
    }
  }
  const onResponse = (response: Response): void => {
    const entry = byRequest.get(response.request())
    if (entry) entry.status = String(response.status())
  }
  const onFailed = (request: Request): void => {
    reads.delete(request)
    const entry = byRequest.get(request)
    if (entry && entry.status === undefined) entry.status = "failed"
  }
  const onFinished = (request: Request): void => {
    reads.delete(request)
  }
  context.on("request", onRequest)
  context.on("response", onResponse)
  context.on("requestfailed", onFailed)
  context.on("requestfinished", onFinished)
  let stopped = false
  return {
    pending: () => {
      if (stopped) return false
      if (entries.some((entry) => entry.status === undefined)) return true
      // A read that has run this long is a stream or a long poll, not something the page is about to render.
      const recent = Date.now() - readWaitMs
      for (const startedAt of reads.values()) if (startedAt > recent) return true
      return false
    },
    stop: () => {
      if (!stopped) {
        stopped = true
        context.off("request", onRequest)
        context.off("response", onResponse)
        context.off("requestfailed", onFailed)
        context.off("requestfinished", onFinished)
      }
      let current = ""
      try {
        current = pageUrl()
      } catch {
        // The page is gone; show full URLs.
      }
      const lines: string[] = []
      const counts = new Map<string, number>()
      for (const entry of entries) {
        const line = `${entry.method} ${shortUrl(entry.url, current)}${entry.body ? ` ${entry.body}` : ""} → ${entry.status ?? "no response yet"}`
        const seen = counts.get(line)
        if (seen === undefined) lines.push(line)
        counts.set(line, (seen ?? 0) + 1)
      }
      const rendered = lines.map((line) => (counts.get(line) ?? 1) > 1 ? `${line} (×${counts.get(line)})` : line)
      const hidden = Math.max(0, rendered.length - maxLines) + dropped
      return hidden > 0 ? [...rendered.slice(0, maxLines), `… ${hidden} more requests`] : rendered
    },
  }
}
