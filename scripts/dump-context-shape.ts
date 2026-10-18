// Diagnostic : quelle est la STRUCTURE réelle des entrées d'une session ?
// (pourquoi le panneau affiche la réflexion interne au lieu de la réponse)
import { readFileSync } from "node:fs"
import { request as httpRequest } from "node:http"
import { OpenCode } from "@opencode/client/promise"
import { basicAuthHeader, fetchResponse, normalizeHeaders } from "../src/bridge"

const V = "C:/Users/ordi2525778/Documents/obsidian/opencode-memory/.obsidian/plugins/opencode-memory-chat/"
const pw = JSON.parse(readFileSync(V + "data.json", "utf8")).passwords["17456"]
const auth = basicAuthHeader(pw)

async function requestUrlLike(p: { url: string; method: string; headers?: Record<string, string>; body?: string }) {
  return new Promise<{ status: number; text: string; headers: Record<string, string> }>((resolve, reject) => {
    const u = new URL(p.url)
    const req = httpRequest(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: p.method, headers: p.headers },
      (res) => {
        const chunks: Buffer[] = []
        res.on("data", (c) => chunks.push(c))
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            text: Buffer.concat(chunks).toString("utf8"),
            headers: Object.fromEntries(
              Object.entries(res.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : String(v ?? "")]),
            ),
          }),
        )
      },
    )
    req.on("error", reject)
    if (p.body) req.write(p.body)
    req.end()
  })
}

const shim = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url
  const headers = normalizeHeaders(init?.headers)
  const body = typeof init?.body === "string" ? init.body : undefined
  const r = await requestUrlLike({ url, method: init?.method ?? "GET", headers, body })
  return fetchResponse(r.status, r.text, r.headers)
}) as typeof fetch

const client = OpenCode.make({ baseUrl: "http://127.0.0.1:17456", headers: { authorization: auth }, fetch: shim }) as any

// Sessions connues (E2E précédents) + la plus récente de l'utilisateur si listables.
let ids: string[] = ["ses_eb1b44c3affeJhNRAfeort3M3O", "ses_eb1b63338ffeeFRiteD21syZ7N"]
try {
  const sessions = await client.session.list()
  const arr = Array.isArray(sessions) ? sessions : (sessions?.sessions ?? [])
  console.log("SESSION.LIST: " + arr.length + " sessions")
  for (const s of arr.slice(0, 6)) console.log("  -", s.id ?? s.sessionID ?? "?", "|", String(s.title ?? "").slice(0, 50))
  ids = [arr[0]?.id ?? arr[0]?.sessionID, ...ids].filter(Boolean)
} catch (e) {
  console.log("session.list indisponible :", String(e).slice(0, 100))
}

for (const sid of ids.slice(0, 3)) {
  console.log("\n=== SESSION", sid, "===")
  try {
    const ctx = await client.session.context({ sessionID: sid })
    for (const e of ctx as any[]) {
      const parts = Array.isArray(e.content) ? e.content : []
      console.log(
        `entry type=${e.type} | text=${typeof e.text === "string" ? JSON.stringify((e.text ?? "").slice(0, 40)) : "(pas de champ text)"} | parts=${parts.length}`,
      )
      for (const p of parts) {
        console.log(`  part type=${p?.type} | ${String(p?.text ?? "").slice(0, 60).replace(/\n/g, " ")}`)
      }
    }
  } catch (e) {
    console.log("contexte illisible :", String(e).slice(0, 120))
  }
}
