// E2E live de la palette de commandes du panneau : liste dynamique + exécution
// réelle (/memory stats puis /dream) via le VRAI ChatController du panneau,
// contre un VRAI serveur qui charge le plugin mémoire reconstruit
// (dist/index.js). Port dédié 17457 : ne touche JAMAIS au serveur du vault
// (17456) ni au serveur du poste de travail.
import { spawn, type ChildProcess } from "child_process"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { open, readFile } from "node:fs/promises"
import { request as httpRequest } from "node:http"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { OpenCode } from "@opencode/client/promise"
import {
  ChatController,
  basicAuthHeader,
  normalizeHeaders,
  parseServePassword,
  planServer,
  probeServer,
  serveLogCandidates,
} from "../src/bridge"

const CLI = "C:/Users/ordi2525778/AppData/Local/Programs/@opencodedesktop/resources/opencode-cli.exe"
const VAULT = "C:/Users/ordi2525778/Documents/obsidian/opencode-memory"
const PORT = 17457
const MODEL = { providerID: "nvidia", id: "nvidia/nemotron-3.5-super-vl-120b-a12b" }
const PASS_FILE = join(tmpdir(), "ocmc-e2e-commands.json")

/** Copie EXACTE du shim de main.ts (mêmes entrées/sorties que requestUrl). */
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
const fail = (msg: string): never => { console.log(`E2E_FAIL: ${msg}`); cleanup(); process.exit(1) }

try {
  // 0. Mot de passe d'un éventuel serveur e2e précédent (réutilisation propre).
  let saved: Record<string, string> = {}
  try { saved = (JSON.parse(readFileSync(PASS_FILE, "utf8")).passwords ?? {}) as Record<string, string> } catch { saved = {} }

  const plan = await planServer(
    async (port, password) => probeServer(sdkFactory, url(port), password ? { authorization: basicAuthHeader(password) } : undefined),
    PORT,
    saved,
  )
  console.log("PLAN:", JSON.stringify(plan.action === "reuse" && plan.password ? { action: "reuse", port: plan.port, password: "(masqué)" } : plan))
  if (plan.action === "fail") fail("aucun port disponible")
  let password = plan.action === "reuse" ? plan.password : undefined

  // 1. Spawn si nécessaire (log en TEMP : rien n'est écrit dans le vault).
  if (plan.action === "spawn") {
    const candidates = serveLogCandidates(undefined, tmpdir(), plan.port)
    let logFile = ""
    let handle: Awaited<ReturnType<typeof open>> | undefined
    for (const path of candidates) {
      try { mkdirSync(dirname(path), { recursive: true }); handle = await open(path, "w"); logFile = path; break } catch { /* suivant */ }
    }
    if (!handle) fail("log non ouvrable")
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
        const state = await probeServer(sdkFactory, url(plan.port), { authorization: basicAuthHeader(password) })
        if (state === "ok") break
      }
      await Bun.sleep(800)
    }
    if (!password) fail("mot de passe introuvable dans le log")
    const verify = await probeServer(sdkFactory, url(plan.port), { authorization: basicAuthHeader(password) })
    if (verify !== "ok") fail(`la sonde authentifiée ne répond pas ok (${verify})`)
    console.log("PASSWORD CAPTURED: oui")
    try { writeFileSync(PASS_FILE, JSON.stringify({ passwords: { [String(plan.port)]: password } }), "utf8") } catch { /* best-effort */ }
  }

  // 2. Le VRAI ChatController du panneau : mêmes options, même shim.
  const controller = new ChatController(sdkFactory as any, { baseUrl: url(plan.port), agent: "memory", model: MODEL, password })

  // 3. Liste dynamique : le plugin reconstruit doit exposer /dream (+ /memory FR).
  // PIÈGE CONNU : le HTTP répond AVANT le chargement des plugins — la
  // première liste peut être vide. On ré-essaie jusqu'à 90 s.
  let commands: Awaited<ReturnType<typeof controller.listCommands>> = []
  const listDeadline = Date.now() + 90_000
  for (let attempt = 1; ; attempt++) {
    commands = await controller.listCommands()
    if (commands.some((c) => c.name === "dream")) break
    if (Date.now() >= listDeadline) break
    console.log(`LISTE tentative ${attempt}: ${commands.length} commande(s) — nouvelle tentative dans 3 s`)
    await Bun.sleep(3000)
  }
  console.log("COMMANDES:", JSON.stringify(commands.map((c) => ({ name: c.name, description: c.description ?? null }))))
  const names = commands.map((c) => c.name)
  if (!names.includes("dream")) fail("la commande /dream est absente (vieux serveur ? plugin non rechargé ?)")
  if (!names.includes("memory")) fail("la commande /memory est absente")
  const memory = commands.find((c) => c.name === "memory")
  if (memory?.description && !/mémoire/i.test(memory.description)) fail(`description /memory non française : ${memory.description}`)
  console.log("E2E_LIST_OK")

  // 4. /memory stats — commande-fichier : un TOUR démarre et doit FINIR (idle).
  const t0 = Date.now()
  const msgs = await controller.sendCommand("memory", "stats", 240_000)
  console.log("MEMORY_STATS_SECONDS:", Math.round((Date.now() - t0) / 1000))
  const reply = [...msgs].reverse().find((m) => m.role === "assistant")?.text ?? ""
  console.log("MEMORY_STATS_REPLY:", reply.slice(0, 400).replace(/\n/g, " "))
  console.log(reply.trim() ? "E2E_MEMORY_STATS_OK" : "E2E_MEMORY_STATS_EMPTY")

  // 5. /dream — commande-plugin : AUCUN tour ; le bilan synthétique doit arriver.
  const t1 = Date.now()
  const msgs2 = await controller.sendCommand("dream", "", 420_000)
  console.log("DREAM_SECONDS:", Math.round((Date.now() - t1) / 1000))
  const summary = [...msgs2].reverse().find((m) => m.role === "system" && /Dream/.test(m.text))?.text ?? ""
  console.log("DREAM_SUMMARY:", JSON.stringify(summary.slice(0, 600)))
  if (!summary) fail("aucun bilan /dream injecté (timeout HTTP ? plugin en échec ?)")
  if (!/Consolidation/.test(summary) || !/Organisation/.test(summary)) fail(`bilan incomplet : ${summary}`)
  console.log("E2E_DREAM_OK")
} catch (error) {
  console.log("E2E_EXCEPTION:", String(error))
  cleanup()
  process.exit(1)
}
cleanup()
process.exit(0)
