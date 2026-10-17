// Simulates the PLUGIN'S connection flow end-to-end:
// 1. probe 17456 (orphan, unknown password) -> "unauthorized"
// 2. planServer -> spawn on 17457, password parsed FROM THE LOG FILE
// 3. authenticated chat with the memory agent, wait for [idle]
import { spawn } from "child_process"
import { readFile, open } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { OpenCode } from "@opencode/client/promise"
import { probeServer, planServer, parseServePassword, basicAuthHeader } from "../src/bridge"

const CLI = "C:/Users/ordi2525778/AppData/Local/Programs/@opencodedesktop/resources/opencode-cli.exe"
const make = (port: number, password?: string) =>
  OpenCode.make({
    baseUrl: `http://127.0.0.1:${port}`,
    headers: password ? { authorization: basicAuthHeader(password) } : undefined,
  })

// 1+2. plan
const plan = await planServer(
  async (port, password) => probeServer((() => make(port, password)) as any, `http://127.0.0.1:${port}`),
  17456,
  {},
)
console.log("PLAN:", JSON.stringify(plan))
if (plan.action !== "spawn") { console.log("E2E_UNEXPECTED_PLAN"); process.exit(1) }

// 3. spawn with file-based stdout capture (as the plugin now does)
const logFile = join(tmpdir(), `ocmc-serve-${plan.port}.log`)
const out = await open(logFile, "w")
const child = spawn(CLI, ["serve", "--hostname", "127.0.0.1", "--port", String(plan.port), "--cors", "*"], { stdio: ["ignore", out.fd, out.fd], windowsHide: true })
await out.close() // l'enfant possède sa copie du fd ; on ferme la nôtre immédiatement
let password: string | undefined
const deadline = Date.now() + 90000
while (Date.now() < deadline) {
  const text = await readFile(logFile, "utf8").catch(() => "")
  password = parseServePassword(text)
  if (password) {
    const state = await probeServer(make(plan.port, password) as any, `http://127.0.0.1:${plan.port}`)
    if (state === "ok") break
  }
  await Bun.sleep(800)
}
console.log("PASSWORD CAPTURED:", password ? "oui" : "non")
if (!password) { console.log("E2E_FAIL"); process.exit(1) }

// 4. chat with the memory agent
const client = make(plan.port, password) as any
const session = await client.session.create({ title: "E2E plugin flow", agent: "memory", model: { providerID: "nvidia", id: "nvidia/nemotron-3.5-super-vl-120b-a12b" } })
const sessionID = session.sessionID ?? session.id
console.log("SESSION:", sessionID)
await client.session.prompt({ sessionID, text: "Bonjour. Confirme en une phrase que tu es l'agent memory et cite UN fait de mon coffre." })
let transcript: any[] = []
const dl = Date.now() + 150000
while (Date.now() < dl) {
  transcript = await client.session.context({ sessionID })
  if (transcript.some((m: any) => String(m.type ?? "") === "idle")) break
  await Bun.sleep(1000)
}
const lastAssistant = [...transcript].reverse().find((m: any) => String(m.type ?? "").includes("assistant"))
const text = lastAssistant ? (typeof lastAssistant.text === "string" && lastAssistant.text) || (lastAssistant.content ?? []).map((p: any) => p?.text ?? "").filter(Boolean).join(" ") : ""
console.log("REPLY:", String(text).slice(0, 400))
console.log("E2E_OK" + (String(text).trim() ? "" : "_EMPTY"))
child.kill()
process.exit(0)
