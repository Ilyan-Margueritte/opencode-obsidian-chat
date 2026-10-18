// Probe : API des COMMANDES du serveur OpenCode (pour la liste dynamique du panneau chat).
// Lecture seule — GET uniquement.
import { readFileSync } from "node:fs"
import { request as httpRequest } from "node:http"
import { basicAuthHeader } from "../src/bridge"

const V = "C:/Users/ordi2525778/Documents/obsidian/opencode-memory/.obsidian/plugins/opencode-memory-chat/"
const data = JSON.parse(readFileSync(V + "data.json", "utf8"))
const passwords: Record<string, string> = data.passwords ?? {}

function get(url: string, auth: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const req = httpRequest(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: "GET", headers: { authorization: auth } },
      (res) => {
        const chunks: Buffer[] = []
        res.on("data", (c) => chunks.push(c))
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }))
      },
    )
    req.on("error", reject)
    req.end()
  })
}

const PATHS = ["/api/command", "/api/commands", "/api/command/list"]
let done = false
for (const [port, pw] of Object.entries(passwords)) {
  const auth = basicAuthHeader(pw)
  for (const path of PATHS) {
    try {
      const r = await get(`http://127.0.0.1:${port}${path}`, auth)
      const preview = r.text.slice(0, 800).replace(/\s+/g, " ")
      console.log(`[port ${port}] GET ${path} -> ${r.status} | ${preview}`)
      if (r.status === 200) done = true
    } catch (e) {
      console.log(`[port ${port}] GET ${path} erreur: ${String(e).slice(0, 100)}`)
    }
  }
  if (done) break
}
