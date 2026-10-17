import { App, Plugin, PluginSettingTab, Setting, ItemView, WorkspaceLeaf } from "obsidian"
import { spawn, ChildProcess } from "child_process"
import { OpenCode } from "@opencode/client/promise"
import { ChatController, probeServer, baseUrlForPort, DEFAULT_PORT, DESKTOP_CLI, parseServePassword, basicAuthHeader, type OpenCodeClient } from "./bridge"

const VIEW_TYPE = "opencode-memory-chat"

/* The SDK client is structurally wider than the bridge's OpenCodeClient type
   (its request bodies accept optional / richer fields). A cast is safe: the
   bridge only calls the subset we typed. */
const sdkFactory = (baseUrl: string, headers?: Record<string, string>): OpenCodeClient =>
  OpenCode.make({ baseUrl, headers }) as unknown as OpenCodeClient

interface Settings {
  port: number
  cliPath: string
  agent: string
  modelProvider: string
  modelId: string
  autoStart: boolean
  /** server passwords learned from `serve` stdout, keyed by port */
  passwords: Record<string, string>
}

const DEFAULT_SETTINGS: Settings = {
  port: DEFAULT_PORT,
  cliPath: DESKTOP_CLI,
  agent: "memory",
  modelProvider: "nvidia",
  modelId: "nvidia/nemotron-3.5-super-vl-120b-a12b",
  autoStart: true,
  passwords: {},
}

export default class OpenCodeMemoryChatPlugin extends Plugin {
  settings: Settings = { ...DEFAULT_SETTINGS }
  private child: ChildProcess | null = null
  private controller: ChatController | null = null

  async onload() {
    await this.loadSettings()
    this.registerView(VIEW_TYPE, (leaf) => new ChatView(leaf, this))
    this.addRibbonIcon("brain", "OpenCode Memory Chat", () => this.activateView())
    this.addCommand({ id: "open-chat", name: "Open memory chat", callback: () => this.activateView() })
    this.addSettingTab(new ChatSettingTab(this.app, this))
  }

  async onunload() {
    // Leave the spawned server running: it is a local API server and the next
    // Obsidian session reconnects instantly with the stored password.
  }

  async activateView() {
    const { workspace } = this.app
    let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0]
    if (!leaf) leaf = workspace.getRightLeaf(false)!
    await leaf.setViewState({ type: VIEW_TYPE, active: true })
    workspace.revealLeaf(leaf)
  }

  /** Spawn the CLI server on `port` and wait until it answers. */
  private vaultBasePath(): string | undefined {
    const adapter = this.app.vault.adapter as { basePath?: string } | undefined
    return adapter?.basePath
  }

  private async spawnServer(port: number): Promise<string | undefined> {
    if (this.child && !this.child.killed) this.child.kill()
    this.child = spawn(this.settings.cliPath, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
      cwd: this.vaultBasePath(),
    })
    let stdout = ""
    this.child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString() })
    const baseUrl = baseUrlForPort(port)
    const deadline = Date.now() + 45000
    while (Date.now() < deadline) {
      const password = parseServePassword(stdout)
      const headers = password ? { authorization: basicAuthHeader(password) } : undefined
      if (await probeServer(sdkFactory, baseUrl, headers) === "ok") return password
      await new Promise((r) => setTimeout(r, 800))
    }
    throw new Error(`OpenCode server did not become ready on port ${port}.`)
  }

  /**
   * Find or start a usable server. Order:
   * 1. configured port without auth (server started without a password),
   * 2. configured port + stored password (our own previous server),
   * 3. next ports (+1..+5) with their stored passwords,
   * 4. spawn a fresh server on the configured port.
   */
  async ensureServer(): Promise<{ baseUrl: string; password?: string }> {
    for (let offset = 0; offset <= 5; offset++) {
      const port = this.settings.port + offset
      const baseUrl = baseUrlForPort(port)
      const state = await probeServer(sdkFactory, baseUrl)
      if (state === "ok") return { baseUrl }
      if (state === "unauthorized") {
        const password = this.settings.passwords[String(port)]
        if (password && await probeServer(sdkFactory, baseUrl, { authorization: basicAuthHeader(password) }) === "ok") {
          return { baseUrl, password }
        }
        continue // foreign or stale server: try the next port
      }
      // "down": spawn here if auto-start is on and we are on the first port
      if (!this.settings.autoStart) break
      if (offset === 0) {
        const password = await this.spawnServer(port)
        if (password) {
          this.settings.passwords[String(port)] = password
          await this.saveSettings()
        }
        return { baseUrl, password }
      }
    }
    throw new Error(`Aucun serveur OpenCode joignable (ports ${this.settings.port} à ${this.settings.port + 5}). Vérifiez le chemin du CLI dans les réglages.`)
  }

  async getController(): Promise<ChatController> {
    if (this.controller) return this.controller
    const { baseUrl, password } = await this.ensureServer()
    this.controller = new ChatController(sdkFactory, {
      baseUrl,
      password,
      agent: this.settings.agent,
      model: { providerID: this.settings.modelProvider, id: this.settings.modelId },
    })
    return this.controller
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData())
  }
  async saveSettings() {
    await this.saveData(this.settings)
  }
}

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
    // restore history if a session exists
    try {
      const c = await this.plugin.getController()
      const msgs = await c.history()
      for (const m of msgs) this.renderMessage(m.role, m.text)
    } catch (e) { this.setStatus(String(e)) }
  }

  private setStatus(t: string) { this.statusEl.setText(t) }

  private renderMessage(role: "user" | "assistant" | "system", text: string) {
    const div = this.messagesEl.createDiv({ cls: `ocmc-msg ocmc-${role}` })
    div.createDiv({ cls: "ocmc-bubble", text })
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight
  }

  async newChat() {
    try {
      const c = await this.plugin.getController()
      c.reset()
      this.messagesEl.empty()
      this.setStatus("Nouvelle discussion.")
    } catch (e) { this.setStatus(String(e)) }
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
      // render only the new assistant reply (last assistant message not already shown)
      const lastAssistant = [...msgs].reverse().find((m) => m.role === "assistant")
      if (lastAssistant) this.renderMessage("assistant", lastAssistant.text)
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
