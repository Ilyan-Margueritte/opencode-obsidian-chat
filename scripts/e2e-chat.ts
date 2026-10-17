// Real end-to-end check: talks to a LIVE OpenCode V2 server as the plugin would
// (Basic auth with the password emitted on `serve` stdout).
// Usage: bun run scripts/e2e-chat.ts <path-to-serve-stdout-log>
import { OpenCode } from "@opencode/client/promise"

const logPath = process.argv[2]
if (!logPath) { console.error("usage: bun run scripts/e2e-chat.ts <serve-log>"); process.exit(1) }
const log = await Bun.file(logPath).text()
const m = /server password (\S+)/.exec(log)
if (!m) { console.error("no server password in log"); process.exit(1) }
const password = m[1]
const headers = { authorization: "Basic " + Buffer.from(`opencode:${password}`).toString("base64") }

const BASE = "http://127.0.0.1:17456"
const client = OpenCode.make({ baseUrl: BASE, headers })

const info = await client.server.info()
console.log("SERVER:", JSON.stringify(info).slice(0, 200))

const session = await client.session.create({
  title: "E2E obsidian-chat",
  agent: "memory",
  model: { providerID: "nvidia", id: "nvidia/nemotron-3.5-super-vl-120b-a12b" },
} as any)
const sessionID = (session as any).sessionID ?? (session as any).id
console.log("SESSION:", sessionID)

const before = await client.session.context({ sessionID })
console.log("CONTEXT BEFORE:", before.length)

const prompt = "Bonjour. Cite UN fait que tu connais sur moi ou mes projets (rappel : tu es l'agent memory)."
await client.session.prompt({ sessionID, text: prompt } as any)
console.log("PROMPT SENT")

const deadline = Date.now() + 180000
let transcript: any[] = []
while (Date.now() < deadline) {
  transcript = await client.session.context({ sessionID }) as any[]
  const idle = transcript.some((m: any) => String(m.type ?? "") === "idle")
  if (idle) break
  await Bun.sleep(1000)
}
console.log("TRANSCRIPT:")
for (const msg of transcript) {
  const text = typeof msg.text === "string" && msg.text
    ? msg.text
    : Array.isArray(msg.content) ? msg.content.map((p: any) => p?.text ?? "").filter(Boolean).join(" ") : ""
  console.log(`[${msg.type}] ${String(text).slice(0, 400)}`)
}
console.log("RAW LAST:", JSON.stringify(transcript[transcript.length - 1]).slice(0, 600))
console.log("E2E_OK" + (transcript.some((msg) => String(msg.type ?? "").includes("assistant")) ? "" : "_TIMEOUT"))
