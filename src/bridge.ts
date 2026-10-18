/* OpenCode Memory Chat — pure bridge logic (testable, no Obsidian deps).
   Everything that talks to the OpenCode server lives here; the Obsidian view
   (main.ts) only calls these functions. */

import { join } from "node:path"

export type ServerInfo = { version?: string; name?: string }

export type ChatModel = { providerID: string; id: string; variant?: string }

export type ChatMessage = {
  role: "user" | "assistant" | "system"
  text: string
  id?: string
}

export type BridgeOptions = {
  baseUrl: string
  agent: string
  model: ChatModel
  title?: string
  /** Optional Basic-auth password emitted by `opencode serve` on stdout. */
  password?: string
}

/** Default model: verified working from OUTSIDE the OpenCode app.
    (opencode/* free tier refuses external clients; nvidia free tier answers.) */
export const DEFAULT_MODEL: ChatModel = { providerID: "nvidia", id: "nvidia/nemotron-3.5-super-vl-120b-a12b" }

/** Default server port for the auto-started OpenCode server. */
export const DEFAULT_PORT = 17456

/** The V2 desktop CLI binary location (Windows). */
export const DESKTOP_CLI = "C:/Users/ordi2525778/AppData/Local/Programs/@opencodedesktop/resources/opencode-cli.exe"

export type OpenCodeClient = {
  server: { info: (ro?: any) => Promise<ServerInfo> }
  session: {
    create: (input: { id?: { title?: string; agent?: string; model?: ChatModel } }) => Promise<{ sessionID?: string; id?: string }>
    prompt: (input: { sessionID: string; text: string }) => Promise<unknown>
    context: (input: { sessionID: string }) => Promise<Array<{ id?: string; type?: string; text?: string; role?: string; content?: unknown }>>
  }
}

export type ClientFactory = (baseUrl: string, headers?: Record<string, string>) => OpenCodeClient

/** Basic auth header for a server password (username is always "opencode"). */
export function basicAuthHeader(password: string): string {
  // btoa exists in Electron/Bun; manual fallback keeps the pure module testable.
  const encode = (s: string): string => {
    if (typeof btoa === "function") return btoa(s)
    return Buffer.from(s, "binary").toString("base64")
  }
  return `Basic ${encode(`opencode:${password}`)}`
}

/** Extract the server password from `opencode serve` stdout. */
export function parseServePassword(stdout: string): string | undefined {
  const m = /server password (\S+)/.exec(stdout)
  return m ? m[1] : undefined
}

export type ServerState = "ok" | "unauthorized" | "down"

export type ServerPlan =
  | { action: "reuse"; port: number; password?: string }
  | { action: "spawn"; port: number }
  | { action: "fail" }

/**
 * Décision pure : réutiliser un serveur existant ou en démarrer un.
 * - port de base sans auth → réutiliser ;
 * - port de base + mot de passe mémorisé accepté → réutiliser (auth) ;
 * - port occupé par un serveur au mot de passe inconnu (orphelin/étranger) →
 *   port suivant ;
 * - port libre → démarrer ici ;
 * - tous occupés → échec explicite.
 */
export async function planServer(
  probe: (port: number, password?: string) => Promise<ServerState>,
  basePort: number,
  savedPasswords: Record<string, string>,
  maxOffsets = 5,
): Promise<ServerPlan> {
  for (let offset = 0; offset <= maxOffsets; offset++) {
    const port = basePort + offset
    const password = savedPasswords[String(port)]
    const state = await probe(port, password)
    if (state === "ok") return { action: "reuse", port, password }
    if (state === "down") return { action: "spawn", port }
    // "unauthorized" : serveur étranger ou mot de passe périmé → port suivant
  }
  return { action: "fail" }
}

/**
 * Reach an already-running server. Distinguishes a usable server ("ok"),
 * a foreign password-protected one ("unauthorized") and nothing ("down").
 */
export async function probeServer(
  clientFactory: ClientFactory,
  baseUrl: string,
  headers?: Record<string, string>,
): Promise<ServerState> {
  try {
    const c = clientFactory(baseUrl, headers)
    await c.server.info()
    return "ok"
  } catch (error) {
    const tag = (error as { _tag?: string })?._tag ?? ""
    if (tag === "UnauthorizedError") return "unauthorized"
    if (tag.includes("Unauthorized")) return "unauthorized"
    const message = String((error as Error)?.message ?? error)
    if (/unauthorized|authentication required/i.test(message)) return "unauthorized"
    return "down"
  }
}

/** Build the base URL from a port. */
export function baseUrlForPort(port: number): string {
  return `http://127.0.0.1:${port}`
}

/* PIÈGE (vécu le 2026-10-18) : ObsidianPluginManifest.dir est un chemin
   RELATIF au vault (« .obsidian/plugins/<id> »). Utilisé tel quel avec fs, il
   se résout contre le dossier de l'appli Obsidian (process.cwd()) → ENOENT.
   Toujours reconstruire un chemin absolu depuis le basePath du vault. */

/** Absolute directory of this plugin inside a vault. */
export function pluginFolderPath(vaultBasePath: string, configDir: string, pluginId: string): string {
  return join(vaultBasePath, configDir, "plugins", pluginId)
}

/** Absolute path of the serve log file (inside the plugin folder). */
export function serveLogPath(pluginFolder: string, port: number): string {
  return join(pluginFolder, `serve-${port}.log`)
}

/**
 * Normalise les en-têtes d'une requête fetch en Record simple.
 * PIÈGE VÉCU (2026-10-18) : le SDK OpenCode passe une INSTANCE Headers ;
 * transmise telle quelle à requestUrl (qui attend un Record), elle est
 * silencieusement ignorée → toutes les requêtes partent sans Authorization
 * → 401 partout (« serveur pas joignable » alors qu'il tourne).
 */
export function normalizeHeaders(headers: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!headers) return out
  if (typeof (headers as Headers).forEach === "function" && !Array.isArray(headers)) {
    (headers as Headers).forEach((value, key) => { out[key] = value })
  } else if (Array.isArray(headers)) {
    for (const [key, value] of headers) out[key] = value
  } else {
    Object.assign(out, headers as Record<string, string>)
  }
  return out
}

/**
 * Candidate log paths, best first: inside the plugin folder, then the OS temp
 * directory. The caller tries each in order — the log MUST be openable, or we
 * cannot capture the server password.
 */
export function serveLogCandidates(pluginFolder: string | undefined, tmp: string, port: number): string[] {
  const list: string[] = []
  if (pluginFolder) list.push(serveLogPath(pluginFolder, port))
  const fallback = serveLogPath(tmp, port)
  if (!list.includes(fallback)) list.push(fallback)
  return list
}

/** Pick the session id from a create() response (field name varies). */
export function extractSessionId(resp: { sessionID?: string; id?: string }): string | undefined {
  return resp?.sessionID ?? resp?.id
}

/** Extract readable text from a session context entry. */
export function entryText(entry: { text?: string; content?: unknown }): string {
  if (typeof entry.text === "string" && entry.text.length) return entry.text
  if (Array.isArray(entry.content)) {
    // PIÈGE VÉCU (2026-10-18) : les entrées assistant contiennent AUSSI des
    // parties {type:"reasoning"} (réflexion interne) et {type:"tool"}. Les
    // concaténer affichait le brouillon du modèle au lieu de sa réponse.
    return entry.content
      .filter((p: any) => !p?.type || p.type === "text")
      .map((p: any) => (p && typeof p.text === "string" ? p.text : ""))
      .filter(Boolean)
      .join("\n")
  }
  if (typeof entry.content === "string") return entry.content
  return ""
}

/** Determine the role of a context entry. */
export function entryRole(entry: { type?: string; role?: string }): "user" | "assistant" | "system" {
  const t = (entry.type ?? entry.role ?? "").toLowerCase()
  if (t.includes("user")) return "user"
  if (t.includes("assistant")) return "assistant"
  return "system"
}

/** Convert a session context into chat messages. */
export function contextToMessages(ctx: Array<{ id?: string; type?: string; text?: string; role?: string; content?: unknown }>): ChatMessage[] {
  const out: ChatMessage[] = []
  for (const e of ctx) {
    const text = entryText(e)
    if (!text.trim()) continue
    out.push({ role: entryRole(e), text, id: e.id })
  }
  return out
}

/** A chat controller: owns a client + a session. */
export class ChatController {
  private client: OpenCodeClient
  private sessionIDPrivate: string | null = null
  private readonly opts: BridgeOptions

  constructor(clientFactory: ClientFactory, opts: BridgeOptions) {
    this.client = clientFactory(opts.baseUrl, opts.password ? { authorization: basicAuthHeader(opts.password) } : undefined)
    this.opts = opts
  }

  get baseUrl(): string { return this.opts.baseUrl }

  /** Current session id (null until created/resumed) — used for persistence. */
  get sessionID(): string | null { return this.sessionIDPrivate }

  /** Reattach to a previously persisted session (history restoration). */
  async resumeSession(id: string): Promise<void> {
    this.sessionIDPrivate = id
  }

  /** Ensure a session exists (create if needed). Returns the session id. */
  async ensureSession(): Promise<string> {
    if (this.sessionIDPrivate) return this.sessionIDPrivate
    // The create payload is FLAT: { title?, agent?, model? } — `id` is the
    // session id itself (string), not an options object.
    const resp = await this.client.session.create({
      title: this.opts.title ?? "Obsidian memory chat",
      agent: this.opts.agent,
      model: this.opts.model,
    } as unknown as { id?: { title?: string; agent?: string; model?: ChatModel } })
    const id = extractSessionId(resp)
    if (!id) throw new Error("session creation returned no id")
    this.sessionIDPrivate = id
    return id
  }

  /** Reset the conversation (new session next time). */
  reset(): void { this.sessionIDPrivate = null }

  /** Re-read the transcript. */
  async history(): Promise<ChatMessage[]> {
    if (!this.sessionIDPrivate) return []
    const ctx = await this.client.session.context({ sessionID: this.sessionIDPrivate })
    return contextToMessages(ctx)
  }

  /** Send a user message and wait for the assistant reply. Returns updated messages. */
  async send(text: string, timeoutMs = 120000): Promise<ChatMessage[]> {
    const sid = await this.ensureSession()
    const before = (await this.client.session.context({ sessionID: sid })).length
    await this.client.session.prompt({ sessionID: sid, text })
    // Poll until the turn COMPLETES: the context grows and an "idle" entry
    // appears when generation ends (an [assistant] entry exists from the first
    // streamed token — waiting on it alone returns an empty reply).
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const ctx = await this.client.session.context({ sessionID: sid })
      const grew = ctx.length > before
      const idle = ctx.some((e) => String(e.type ?? "") === "idle")
      if (grew && idle) return contextToMessages(ctx)
      if (grew) {
        const lastAssistant = [...ctx].reverse().find((e) => entryRole(e) === "assistant")
        if (lastAssistant && entryText(lastAssistant).trim()) return contextToMessages(ctx)
      }
      await new Promise((r) => setTimeout(r, 600))
    }
    // timeout: return whatever we have
    const ctx = await this.client.session.context({ sessionID: sid })
    return contextToMessages(ctx)
  }
}
