import { App, Plugin, PluginSettingTab, Setting, ItemView, WorkspaceLeaf, requestUrl } from "obsidian"
import { spawn, type ChildProcess } from "child_process"
import { open as fsOpen, readFile } from "node:fs/promises"
import { join } from "node:path"
import { OpenCode } from "@opencode/client/promise"
import {
  ChatController,
  parseServePassword,
  planServer,
  baseUrlForPort,
  DEFAULT_PORT,
  DEFAULT_MODEL,
  DESKTOP_CLI,
  type OpenCodeClient,
} from "./bridge"

const VIEW_TYPE = "opencode-memory-chat"

/* Obsidian's renderer origin (app://obsidian.md) cannot reliably fetch
   http://127.0.0.1 (cross-origin + CSP): route every SDK request through
   Obsidian's requestUrl, which is exempt from those restrictions. */
function obsidianFetch(): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url
    const method = init?.method ?? "GET"
    const headers = (init?.headers ?? undefined) as Record<string, string> | undefined
    const body = typeof init?.body === "string" ? init.body : undefined
    const r = await requestUrl({ url, method, headers, body, throw: false })
    return new Response(r.text, { status: r.status, headers: r.headers })
  }) as typeof fetch
}

/* The SDK client is structurally wider than the bridge's OpenCodeClient type
   (its request bodies accept optional / richer fields). A cast is safe: the
   bridge only calls the subset we typed. */
const sdkFactory = (baseUrl: string, headers?: Record<string, string>): OpenCodeClient =>
  OpenCode.make({ baseUrl, headers, fetch: obsidianFetch() }) as unknown as OpenCodeClient

interface Settings {
  port: number
  cliPath: string
  agent: string
  modelProvider: string
  modelId: string
  autoStart: boolean
  /** server passwords learned from `serve` stdout, keyed by port */
  passwords: Record<string, string>
  /** last chat session, restored on panel open */
  lastSessionID: string
}

const DEFAULT_SETTINGS: Settings = {
  port: DEFAULT_PORT,
  cliPath: DESKTOP_CLI,
  agent: "memory",
  modelProvider: DEFAULT_MODEL.providerID,
  modelId: DEFAULT_MODEL.id,
  autoStart: true,
  passwords: {},
  lastSessionID: "",
}

export default class OpenCodeMemoryChatPlugin extends Plugin {
  settings: Settings = { ...DEFAULT_SETTINGS }
  private child: ChildProcess | null = null
  private controller: ChatController | null = null
  private controllerKey = ""

  async onload() {
    await this.loadSettings()
    this.registerView(VIEW_TYPE, (leaf) => new ChatView(leaf, this))
    this.addRibbonIcon("brain", "OpenCode Memory Chat", () => this.activateView())
    this.addCommand({ id: "open-chat", name: "Open memory chat", callback: () => this.activateView() })
    this.addSettingTab(new ChatSettingTab(this.app, this))
  }

  async onunload() {
    // Leave the spawned server running: the next Obsidian session reconnects
    // instantly with the stored password.
  }

  async activateView() {
    const { workspace } = this.app
    let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0]
    if (!leaf) leaf = workspace.getRightLeaf(false)!
    await leaf.setViewState({ type: VIEW_TYPE, active: true })
    workspace.revealLeaf(leaf)
  }

  private vaultBasePath(): string | undefined {
    const adapter = this.app.vault.adapter as { basePath?: string } | undefined
    return adapter?.basePath
  }

  /**
   * Spawn the CLI server on `port`. The password printed on stdout is
   * captured from a LOG FILE (Electron pipes proved unreliable) and saved as
   * soon as it appears, so a later attempt can reconnect even if this one
   * gives up.
   */
  private async spawnServer(port: number): Promise<string | undefined> {
    if (this.child && !this.child.killed) this.child.kill()
    const logFile = join(this.manifest.dir ?? this.app.vault.configDir, `serve-${port}.log`)
    const out = await fsOpen(logFile, "w")
    this.child = spawn(
      this.settings.cliPath,
      ["serve", "--hostname", "127.0.0.1", "--port", String(port), "--cors", "*"],
      { stdio: ["ignore", out.fd, out.fd], windowsHide: true, cwd: this.vaultBasePath() },
    )
    await out.close() // the child owns its duplicated fd; close ours at once
    this.child.on("error", (error) => {
      console.error("[opencode-memory-chat] spawn error", error)
    })
    this.child.on("exit", (code) => {
      if (code && code !== 0) console.error(`[opencode-memory-chat] server exited with code ${code} (voir ${logFile})`)
    })

    const baseUrl = baseUrlForPort(port)
    const deadline = Date.now() + 90000
    while (Date.now() < deadline) {
      // parse from the file — works regardless of Electron pipe buffering
      try {
        const text = await readFile(logFile, "utf8").catch(() => "")
        const password = parseServePassword(text)
        if (password && this.settings.passwords[String(port)] !== password) {
          this.settings.passwords[String(port)] = password
          await this.saveSettings()
        }
        const headers = password ? { authorization: basicAuth(password) } : undefined
        if ((await probe(sdkFactory, baseUrl, headers)) === "ok") {
          return password
        }
      } catch { /* keep polling */ }
      await new Promise((r) => setTimeout(r, 800))
    }
    throw new Error(`Le serveur OpenCode n'est pas devenu joignable sur le port ${port} (90 s). Logs : ${logFile}`)
  }

  /** Find or start a usable server (pure decision in bridge.planServer). */
  async ensureServer(): Promise<{ baseUrl: string; password?: string }> {
    const plan = await planServer(
      async (port, password) => probe(sdkFactory, baseUrlForPort(port), password ? { authorization: basicAuth(password) } : undefined),
      this.settings.port,
      this.settings.passwords,
    )
    if (plan.action === "reuse") return { baseUrl: baseUrlForPort(plan.port), password: plan.password }
    if (plan.action === "spawn") {
      if (!this.settings.autoStart) throw new Error(`Aucun serveur OpenCode sur le port ${plan.port} et le démarrage automatique est désactivé.`)
      const password = await this.spawnServer(plan.port)
      return { baseUrl: baseUrlForPort(plan.port), password }
    }
    throw new Error(`Aucun serveur OpenCode joignable (ports ${this.settings.port} à ${this.settings.port + 5}) et tous sont occupés par des serveurs au mot de passe inconnu. Fermez l'ancien serveur ou changez le port dans les réglages.`)
  }

  async getController(): Promise<ChatController> {
    const { baseUrl, password } = await this.ensureServer()
    const key = `${baseUrl}|${password ?? ""}`
    if (this.controller && this.controllerKey === key) return this.controller
    this.controller = new ChatController(sdkFactory, {
      baseUrl,
      password,
      agent: this.settings.agent,
      model: { providerID: this.settings.modelProvider, id: this.settings.modelId },
    })
    this.controllerKey = key
    return this.controller
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData())
  }
  async saveSettings() {
    await this.saveData(this.settings)
  }
}

/* Small local aliases to keep the call sites readable. */
import { probeServer as probe, basicAuthHeader as basicAuth } from "./bridge"

class ChatView extends ItemView {
  plugin: OpenCodeMemoryChatPlugin
  private messagesEl!: HTMLElement
  private inputEl!: HTMLTextAreaElement
  private statusEl!: HTMLElement
  private busy = false

  constructor(leaf: WorkspaceLeaf, plugin: OpenCodeMemoryChatPlugin) {
    super(leaf)
    this.plugin = plugin
  }

  getViewType() { return VIEW_TYPE }
  getDisplayText() { return "Memory chat" }
  getIcon() { return "brain" }

  async onOpen() {
    const root = this.containerEl.children[1] as HTMLElement
    root.empty()
    root.addClass("ocmc-root")
    const header = root.createDiv({ cls: "ocmc-header" })
    header.createEl("span", { text: "OpenCode · @memory" })
    const btnNew = header.createEl("button", { text: "Nouvelle discussion" })
    btnNew.onclick = () => this.newChat()
    this.statusEl = root.createDiv({ cls: "ocmc-status", text: "Prêt." })
    this.messagesEl = root.createDiv({ cls: "ocmc-messages" })
    const composer = root.createDiv({ cls: "ocmc-composer" })
    this.inputEl = composer.createEl("textarea", { cls: "ocmc-input" }) as HTMLTextAreaElement
    this.inputEl.rows = 2
    this.inputEl.placeholder = "Posez une question à la mémoire…"
    const send = composer.createEl("button", { text: "Envoyer", cls: "ocmc-send" })
    send.onclick = () => this.send()
    this.inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); this.send() }
    })

    // Restore the last conversation (persisted session id).
    if (this.plugin.settings.lastSessionID) {
      this.setStatus("Reconnexion à la dernière discussion…")
      try {
        const c = await this.plugin.getController()
        await c.resumeSession(this.plugin.settings.lastSessionID)
        const msgs = await c.history()
        if (msgs.length === 0) {
          this.setStatus("Dernière discussion vide (session expirée ?) — nouvelle discussion prête.")
          c.reset()
          this.plugin.settings.lastSessionID = ""
          await this.plugin.saveSettings()
        } else {
          for (const m of msgs) this.renderMessage(m.role, m.text)
          this.setStatus("Discussion précédente restaurée.")
        }
      } catch (e) {
        this.setStatus(String(e))
      }
    }
  }

  private setStatus(t: string) { this.statusEl.setText(t) }

  private renderMessage(role: "user" | "assistant" | "system", text: string) {
    const div = this.messagesEl.createDiv({ cls: `ocmc-msg ocmc-${role}` })
    div.createDiv({ cls: "ocmc-bubble", text })
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight
  }

  /** Nouvelle discussion : reset IMMÉDIAT de l'UI, sans exiger le serveur. */
  private async newChat() {
    this.messagesEl.empty()
    this.plugin.settings.lastSessionID = ""
    await this.plugin.saveSettings().catch(() => {})
    try {
      const c = await this.plugin.getController()
      c.reset()
    } catch (e) {
      // pas de serveur : peu importe, le reset UI est déjà fait
      this.setStatus("Nouvelle discussion (serveur pas encore joignable — il démarrera au premier message).")
      return
    }
    this.setStatus("Nouvelle discussion.")
  }

  async send() {
    if (this.busy) return
    const text = this.inputEl.value.trim()
    if (!text) return
    this.busy = true
    this.inputEl.value = ""
    this.renderMessage("user", text)
    this.setStatus("Réflexion…")
    try {
      const c = await this.plugin.getController()
      const msgs = await c.send(text)
      const lastAssistant = [...msgs].reverse().find((m) => m.role === "assistant")
      if (lastAssistant) this.renderMessage("assistant", lastAssistant.text)
      else this.renderMessage("system", "(réponse vide — voir les réglages de modèle)")
      if (c.sessionID) {
        this.plugin.settings.lastSessionID = c.sessionID
        await this.plugin.saveSettings()
      }
      this.setStatus("Prêt.")
    } catch (e) {
      this.setStatus(`Erreur : ${String(e)}`)
    } finally {
      this.busy = false
    }
  }

  async onClose() {}
}

class ChatSettingTab extends PluginSettingTab {
  plugin: OpenCodeMemoryChatPlugin
  constructor(app: App, plugin: OpenCodeMemoryChatPlugin) { super(app, plugin); this.plugin = plugin }
  display() {
    const { containerEl } = this
    containerEl.empty()
    new Setting(containerEl).setName("Port du serveur OpenCode").setDesc("Port utilisé pour se connecter / démarrer le serveur.").addText((t) => t.setValue(String(this.plugin.settings.port)).onChange(async (v) => { this.plugin.settings.port = Number(v) || DEFAULT_PORT; await this.plugin.saveSettings() }))
    new Setting(containerEl).setName("Chemin du CLI OpenCode (V2)").setDesc("Binaire opencode-cli.exe (desktop) utilisé pour démarrer le serveur.").addText((t) => t.setValue(this.plugin.settings.cliPath).onChange(async (v) => { this.plugin.settings.cliPath = v; await this.plugin.saveSettings() }))
    new Setting(containerEl).setName("Agent").setDesc("Agent OpenCode à utiliser (par défaut @memory).").addText((t) => t.setValue(this.plugin.settings.agent).onChange(async (v) => { this.plugin.settings.agent = v || "memory"; await this.plugin.saveSettings() }))
    new Setting(containerEl).setName("Modèle (provider/id)").setDesc("Doit fonctionner hors de l'app OpenCode (les modèles opencode/* gratuits refusent les clients externes).").addText((t) => t.setValue(`${this.plugin.settings.modelProvider}/${this.plugin.settings.modelId}`).onChange(async (v) => {
      const [p, ...rest] = v.split("/")
      this.plugin.settings.modelProvider = p || "nvidia"
      this.plugin.settings.modelId = rest.join("/") || "nvidia/nemotron-3.5-super-vl-120b-a12b"
      await this.plugin.saveSettings()
    }))
    new Setting(containerEl).setName("Démarrage automatique").setDesc("Démarre le serveur OpenCode si aucun n'est joignable.").addToggle((t) => t.setValue(this.plugin.settings.autoStart).onChange(async (v) => { this.plugin.settings.autoStart = v; await this.plugin.saveSettings() }))
  }
}
