// E2E : simule le flux EXACT du plugin (v0.1.3) sur le vrai vault.
// 1. planServer (avec les mots de passe sauvegardés de data.json, comme le plugin)
// 2. log ouvert via serveLogCandidates DANS le dossier réel du plugin
// 3. spawn du CLI (cwd = vault), mot de passe lu depuis le fichier de log
// 4. chat réel avec l'agent memory, attente de l'entrée [idle]
import { spawn, type ChildProcess } from "child_process"
import { existsSync, mkdirSync, readFileSync } from "node:fs"
import { open, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { OpenCode } from "@opencode/client/promise"
import {
  probeServer,
  planServer,
  parseServePassword,
  basicAuthHeader,
  contextToMessages,
  pluginFolderPath,
  serveLogCandidates,
} from "../src/bridge"

const CLI = "C:/Users/ordi2525778/AppData/Local/Programs/@opencodedesktop/resources/opencode-cli.exe"
const VAULT = "C:/Users/ordi2525778/Documents/obsidian/opencode-memory"
const MODEL = { providerID: "nvidia", id: "nvidia/nemotron-3.5-super-vl-120b-a12b" }

const make = (port: number, password?: string) =>
  OpenCode.make({
    baseUrl: `http://127.0.0.1:${port}`,
    headers: password ? { authorization: basicAuthHeader(password) } : undefined,
  })

let child: ChildProcess | undefined
const cleanup = () => {
  try { child?.kill() } catch { /* déjà mort */ }
}

// 0. Dossiers réels — c'est ICI que le plugin écrit son log.
const pluginFolder = pluginFolderPath(VAULT, ".obsidian", "opencode-memory-chat")
if (!existsSync(join(pluginFolder, "manifest.json"))) {
  console.log("E2E_FAIL: dossier plugin introuvable:", pluginFolder)
  process.exit(1)
}
console.log("PLUGIN FOLDER:", pluginFolder)

// 1. Plan (mêmes entrées que le plugin : data.json + planServer).
const dataFile = join(pluginFolder, "data.json")
const savedPasswords: Record<string, string> = existsSync(dataFile)
  ? (JSON.parse(readFileSync(dataFile, "utf8")).passwords ?? {})
  : {}
const plan = await planServer(
  async (port, password) => probeServer(make(port, password) as any, `http://127.0.0.1:${port}`),
  17456,
  savedPasswords,
)
console.log("PLAN:", JSON.stringify(plan))
if (plan.action === "fail") { console.log("E2E_FAIL: aucun port disponible"); process.exit(1) }

let password = plan.action === "reuse" ? plan.password : undefined

// 2. Spawn avec le log ouvert EXACTEMENT comme le plugin (candidats, mkdir, fd).
if (plan.action === "spawn") {
  const candidates = serveLogCandidates(pluginFolder, tmpdir(), plan.port)
  console.log("LOG CANDIDATES:", candidates.join(" | "))
  let logFile = ""
  let handle: Awaited<ReturnType<typeof open>> | undefined
  for (const path of candidates) {
    try {
      mkdirSync(dirname(path), { recursive: true })
      handle = await open(path, "w")
      logFile = path
      break
    } catch { /* candidat suivant */ }
  }
  if (!handle) { console.log("E2E_FAIL: aucun log ouvrable"); process.exit(1) }
  console.log("LOG USED:", logFile, "— dans le dossier du plugin:", logFile.startsWith(pluginFolder))

  child = spawn(CLI, ["serve", "--hostname", "127.0.0.1", "--port", String(plan.port), "--cors", "*"], {
    stdio: ["ignore", handle.fd, handle.fd],
    windowsHide: true,
    cwd: VAULT,
  })
  await handle.close() // l'enfant possède sa copie du fd

  const deadline = Date.now() + 90000
  while (Date.now() < deadline) {
    const text = await readFile(logFile, "utf8").catch(() => "")
    password = parseServePassword(text)
    if (password && (await probeServer(make(plan.port, password) as any, `http://127.0.0.1:${plan.port}`)) === "ok") break
    await Bun.sleep(800)
  }
  console.log("PASSWORD CAPTURED:", password ? "oui" : "non")
  if (!password) { cleanup(); console.log("E2E_FAIL: mot de passe introuvable"); process.exit(1) }
}

// 3. Chat réel avec l'agent memory.
try {
  const client = make(plan.port, password) as any
  const session = await client.session.create({ title: "E2E plugin flow", agent: "memory", model: MODEL })
  const sessionID = session.sessionID ?? session.id
  console.log("SESSION:", sessionID)
  await client.session.prompt({ sessionID, text: "Bonjour. Confirme en une phrase que tu es l'agent memory et cite UN fait de mon coffre." })
  let transcript: any[] = []
  const deadline = Date.now() + 150000
  while (Date.now() < deadline) {
    transcript = await client.session.context({ sessionID })
    if (transcript.some((m: any) => String(m.type ?? "") === "idle")) break
    await Bun.sleep(1000)
  }
  const messages = contextToMessages(transcript)
  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant")
  const text = lastAssistant?.text ?? ""
  console.log("REPLY:", String(text).slice(0, 300))
  console.log(String(text).trim() ? "E2E_OK" : "E2E_OK_EMPTY")
} finally {
  // Le plugin, lui, LAISSE le serveur tourner (reconnexion instantanée) ; en test
  // on le tue pour ne pas laisser d'orphelin sans mot de passe.
  cleanup()
}
process.exit(0)
