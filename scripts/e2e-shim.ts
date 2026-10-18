// LE test qui manquait : valide la chaîne SDK + shim d'en-têtes (instance
// Headers → Record simple) contre un VRAI serveur, exactement comme le plugin
// dans Obsidian. Sans la normalisation, chaque requête part sans Authorization
// → 401 partout (« serveur pas joignable » alors qu'il tourne).
import { spawn, type ChildProcess } from "child_process"
import { existsSync, mkdirSync, readFileSync } from "node:fs"
import { open, readFile } from "node:fs/promises"
import { request as httpRequest } from "node:http"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { OpenCode } from "@opencode/client/promise"
import {
  basicAuthHeader,
  normalizeHeaders,
  parseServePassword,
  planServer,
  pluginFolderPath,
  probeServer,
  serveLogCandidates,
} from "../src/bridge"

const CLI = "C:/Users/ordi2525778/AppData/Local/Programs/@opencodedesktop/resources/opencode-cli.exe"
const VAULT = "C:/Users/ordi2525778/Documents/obsidian/opencode-memory"
const MODEL = { providerID: "nvidia", id: "nvidia/nemotron-3.5-super-vl-120b-a12b" }

/** Imite requestUrl d'Obsidian (mêmes entrées/sorties, via node:http). */
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

/** Copie EXACTE du shim de main.ts (si main.ts change, garder synchro). */
function obsidianFetchLike(): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url
    const method = init?.method ?? "GET"
    const headers = normalizeHeaders(init?.headers)
    const body = typeof init?.body === "string" ? init.body : undefined
    const r = await requestUrlLike({ url, method, headers, body })
    return new Response(r.text, { status: r.status, headers: r.headers })
  }) as typeof fetch
}

const url = (port: number) => `http://127.0.0.1:${port}`
const sdkFactory = (base: string, headers?: Record<string, string>) =>
  OpenCode.make({ baseUrl: base, headers, fetch: obsidianFetchLike() }) as any

let child: ChildProcess | undefined
const cleanup = () => { try { child?.kill() } catch { /* déjà mort */ } }

try {
  // 0. Dossier plugin réel (l'endroit exact où le plugin écrit son log).
  const pluginFolder = pluginFolderPath(VAULT, ".obsidian", "opencode-memory-chat")
  if (!existsSync(join(pluginFolder, "manifest.json"))) { console.log("E2E_FAIL: dossier plugin introuvable"); process.exit(1) }

  // 1. Plan, comme le plugin (data.json inclus).
  const dataFile = join(pluginFolder, "data.json")
  const savedPasswords: Record<string, string> = existsSync(dataFile)
    ? (JSON.parse(readFileSync(dataFile, "utf8")).passwords ?? {})
    : {}
  const plan = await planServer(
    async (port, password) => probeServer(sdkFactory, url(port), password ? { authorization: basicAuthHeader(password) } : undefined),
    17456,
    savedPasswords,
  )
  console.log("PLAN:", JSON.stringify(plan.action === "reuse" ? { action: plan.action, port: plan.port, password: "(masqué)" } : plan))
  if (plan.action === "fail") { console.log("E2E_FAIL: aucun port"); process.exit(1) }

  let password = plan.action === "reuse" ? plan.password : undefined

  // 2. Spawn (log via candidats, comme le plugin).
  if (plan.action === "spawn") {
    const candidates = serveLogCandidates(pluginFolder, tmpdir(), plan.port)
    let logFile = ""
    let handle: Awaited<ReturnType<typeof open>> | undefined
    for (const path of candidates) {
      try { mkdirSync(dirname(path), { recursive: true }); handle = await open(path, "w"); logFile = path; break } catch { /* suivant */ }
    }
    if (!handle) { console.log("E2E_FAIL: log non ouvrable"); process.exit(1) }
    child = spawn(CLI, ["serve", "--hostname", "127.0.0.1", "--port", String(plan.port), "--cors", "*"], {
      stdio: ["ignore", handle.fd, handle.fd],
      windowsHide: true,
      cwd: VAULT,
    })
    await handle.close()

    const deadline = Date.now() + 90000
    while (Date.now() < deadline) {
      const text = await readFile(logFile, "utf8").catch(() => "")
      password = parseServePassword(text)
      if (password) {
        // LE point clé : la sonde AUTHEntifiée via le shim normalisé.
        const state = await probeServer(sdkFactory, url(plan.port), { authorization: basicAuthHeader(password) })
        if (state === "ok") break
      }
      await Bun.sleep(800)
    }
    console.log("PASSWORD CAPTURED:", password ? "oui" : "non")
    if (!password) { cleanup(); console.log("E2E_FAIL: mot de passe introuvable"); process.exit(1) }
    const verify = await probeServer(sdkFactory, url(plan.port), { authorization: basicAuthHeader(password) })
    console.log("SONDE AUTHENTIFIÉE VIA SHIM:", verify)
    if (verify !== "ok") { cleanup(); console.log("E2E_FAIL: la sonde authentifiée ne retourne pas ok"); process.exit(1) }
  }

  // 3. Chat réel via le shim (create + prompt + idle).
  const client = sdkFactory(url(plan.port), password ? { authorization: basicAuthHeader(password) } : undefined)
  const session = await client.session.create({ title: "E2E shim", agent: "memory", model: MODEL })
  const sessionID = session.sessionID ?? session.id
  console.log("SESSION:", sessionID)
  await client.session.prompt({ sessionID, text: "Bonjour. Réponds en une phrase en français et cite UN fait de mon coffre." })
  let transcript: any[] = []
  const deadline = Date.now() + 150000
  while (Date.now() < deadline) {
    transcript = await client.session.context({ sessionID })
    if (transcript.some((m: any) => String(m.type ?? "") === "idle")) break
    await Bun.sleep(1000)
  }
  const lastAssistant = [...transcript].reverse().find((m: any) => String(m.type ?? "").includes("assistant"))
  const text = lastAssistant
    ? (typeof lastAssistant.text === "string" && lastAssistant.text) ||
      (lastAssistant.content ?? []).map((p: any) => p?.text ?? "").filter(Boolean).join(" ")
    : ""
  console.log("REPLY:", String(text).slice(0, 300))
  console.log(String(text).trim() ? "E2E_OK" : "E2E_OK_EMPTY")
} finally {
  cleanup()
}
process.exit(0)
