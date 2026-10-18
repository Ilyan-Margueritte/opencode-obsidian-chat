// Probe 2 : état réel du serveur du vault — version, plugins chargés, agents, commandes.
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

const PATHS = ["/api/info", "/api/plugin", "/api/plugins", "/api/agent", "/api/agents", "/api/command"]
for (const [port, pw] of Object.entries(passwords)) {
  const auth = basicAuthHeader(pw)
  console.log(`========== port ${port} ==========`)
  for (const path of PATHS) {
    try {
      const r = await get(`http://127.0.0.1:${port}${path}`, auth)
      const preview = r.text.length > 700 ? r.text.slice(0, 700) + "…" : r.text
      console.log(`--- GET ${path} -> ${r.status}`)
      if (r.status === 200) console.log(preview.replace(/\s+/g, " ").slice(0, 700))
    } catch (e) {
      console.log(`--- GET ${path} erreur: ${String(e).slice(0, 100)}`)
    }
  }
  break
}
