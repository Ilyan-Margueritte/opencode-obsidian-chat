// Diagnostic : contenu RÉEL de la session de l'utilisateur (data.json.lastSessionID)
// + ce que contextToMessages en fait — pour comprendre la réponse dupliquée et
// le fragment de brouillon encore affiché.
import { readFileSync } from "node:fs"
import { request as httpRequest } from "node:http"
import { OpenCode } from "@opencode/client/promise"
import { basicAuthHeader, contextToMessages, normalizeHeaders } from "../src/bridge"

const V = "C:/Users/ordi2525778/Documents/obsidian/opencode-memory/.obsidian/plugins/opencode-memory-chat/"
const data = JSON.parse(readFileSync(V + "data.json", "utf8"))
const sid: string = process.argv[2] || data.lastSessionID
console.log("SESSION:", sid)
const passwords: Record<string, string> = data.passwords ?? {}

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
  return new Response(r.text, { status: r.status, headers: r.headers })
}) as typeof fetch

async function tryPort(port: string) {
  const client = OpenCode.make({
    baseUrl: `http://127.0.0.1:${port}`,
    headers: { authorization: basicAuthHeader(passwords[port]) },
    fetch: shim,
  }) as any
  const ctx = await client.session.context({ sessionID: sid })
  return { client, ctx: ctx as any[] }
}

let found: { client: any; ctx: any[] } | null = null
for (const port of Object.keys(passwords)) {
  try {
    found = await tryPort(port)
    console.log("serveur vivant sur le port", port)
    break
  } catch {
    /* port suivant */
  }
}
if (!found) {
  console.log("AUCUN serveur vivant pour cette session")
  process.exit(1)
}

const ctx = found.ctx
console.log(`\n=== ${ctx.length} entrées de contexte ===`)
for (const [i, e] of ctx.entries()) {
  const parts = Array.isArray(e.content) ? e.content : []
  console.log(
    `#${i} entry.type=${JSON.stringify(e.type)} role=${JSON.stringify(e.role ?? null)} keys=[${Object.keys(e).join(",")}] parts=${parts.length}${
      typeof e.text === "string" ? ` text=${JSON.stringify(e.text.slice(0, 80))}` : ""
    }`,
  )
  for (const [j, p] of parts.entries()) {
    console.log(
      `   part#${j} type=${JSON.stringify((p as any)?.type)} keys=[${Object.keys(p ?? {}).join(",")}] text=${JSON.stringify(String((p as any)?.text ?? "").slice(0, 85))}`,
    )
  }
}
console.log("\n=== ce que le panneau reçoit (contextToMessages) ===")
for (const [i, m] of contextToMessages(ctx).entries()) {
  console.log(`msg#${i} role=${m.role} text=${JSON.stringify(m.text.slice(0, 85))}`)
}
