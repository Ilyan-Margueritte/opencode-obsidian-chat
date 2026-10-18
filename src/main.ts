import { App, Plugin, PluginSettingTab, Setting, ItemView, WorkspaceLeaf, requestUrl } from "obsidian"
import { spawn, type ChildProcess } from "child_process"
import { appendFileSync, mkdirSync } from "node:fs"
import { open as fsOpen, readFile, type FileHandle } from "node:fs/promises"
import { dirname, join } from "node:path"
import { tmpdir } from "node:os"
import { OpenCode } from "@opencode/client/promise"
import {
  ChatController,
  parseServePassword,
  planServer,
  baseUrlForPort,
  pluginFolderPath,
  serveLogCandidates,
  normalizeHeaders,
  fetchResponse,
  parseCommandInput,
  filterCommands,
  nextCommandSelection,
  DEFAULT_PORT,
  DEFAULT_MODEL,
  DESKTOP_CLI,
  type CommandInfo,
  type OpenCodeClient,
} from "./bridge"

const VIEW_TYPE = "opencode-memory-chat"

/** Durée de fraîcheur de la liste des commandes avant rechargement. */
const COMMAND_TTL_MS = 60_000

/* Piste de diagnostic HORS du vault (jamais de fichier chez l'utilisateur,
   jamais bloquante) : %TEMP%\opencode-memory-chat.log. Sert à vérifier de
   l'extérieur quelle version du plugin est réellement chargée dans Obsidian. */
function trail(line: string): void {
  try {
    appendFileSync(join(tmpdir(), "opencode-memory-chat.log"), `${new Date().toISOString()} ${line}\n`)
  } catch { /* le diagnostic ne doit jamais bloquer le plugin */ }
}

/* Obsidian's renderer origin (app://obsidian.md) cannot reliably fetch
   http://127.0.0.1 (cross-origin + CSP): route every SDK request through
   Obsidian's requestUrl, which is exempt from those restrictions. */
function obsidianFetch(): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url
    const method = init?.method ?? "GET"
    // Le SDK passe une instance Headers : requestUrl attend un Record simple
    // et l'ignore silencieusement sinon → plus d'Authorization → 401 partout
    // (bug vécu le 2026-10-18 : « serveur pas joignable » alors qu'il tourne).
    const headers = normalizeHeaders(init?.headers)
    const body = typeof init?.body === "string" ? init.body : undefined
    const r = await requestUrl({ url, method, headers, body, throw: false })
    // Statut 204 possible (POST /command) : fetchResponse gère les corps
    // interdits — new Response("", {status:204}) levait en plein vol.
    return fetchResponse(r.status, r.text, r.headers)
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
    trail(`onload version=${this.manifest.version} basePath=${this.vaultBasePath() ?? "(inconnu)"} configDir=${this.app.vault.configDir} manifestDir=${this.manifest.dir ?? "(absent)"} pluginFolder=${this.pluginFolder() ?? "(inconnu)"} port=${this.settings.port} logCandidats=[${serveLogCandidates(this.pluginFolder(), tmpdir(), this.settings.port).join(" | ")}]`)
    this.registerView(VIEW_TYPE, (leaf) => new ChatView(leaf, this))
    this.addRibbonIcon("brain", "OpenCode Memory Chat", () => this.activateView())
    this.addCommand({ id: "open-chat", name: "Open memory chat", callback: () => this.activateView() })
    this.addSettingTab(new ChatSettingTab(this.app, this))
    // Pré-chauffage : si un serveur tourne déjà on s'y reconnecte, sinon on le
    // démarre immédiatement — le premier message du panneau ne fait plus
    // qu'attendre la réponse de l'agent.
    if (this.settings.autoStart) {
      setTimeout(() => {
        this.getController()
          .then((c) => trail(`préchauffage OK baseUrl=${c.baseUrl}`))
          .catch((e) => trail(`préchauffage ÉCHEC : ${e instanceof Error ? e.message : String(e)}`))
      }, 2500)
    }
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
   * Absolute folder of THIS plugin inside the vault. `manifest.dir` from
   * Obsidian is VAULT-RELATIVE (e.g. ".obsidian/plugins/<id>") — used as-is
   * with fs it resolves against the Obsidian app folder and opens ENOENT
   * (bug vécu le 2026-10-18). We rebuild an absolute path from the vault's
   * real base path; undefined (→ tmpdir) only as a last-resort fallback.
   */
  private pluginFolder(): string | undefined {
    const base = this.vaultBasePath()
    return base ? pluginFolderPath(base, this.app.vault.configDir, this.manifest.id) : undefined
  }

  /**
   * Open the serve log in the first WRITABLE candidate location (plugin
   * folder first, then the OS temp dir). Returns the path actually used —
   * password capture must never depend on a single directory existing.
   */
  private async openServeLog(port: number): Promise<{ path: string; handle: FileHandle }> {
    const candidates = serveLogCandidates(this.pluginFolder(), tmpdir(), port)
    let lastError: unknown
    for (const path of candidates) {
      try {
        mkdirSync(dirname(path), { recursive: true })
        const handle = await fsOpen(path, "w")
        return { path, handle }
      } catch (error) {
        lastError = error
      }
    }
    const msg = `Impossible d'ouvrir un fichier de log pour le serveur (essayé : ${candidates.join(" ; ")}) : ${lastError instanceof Error ? lastError.message : String(lastError)}`
    trail(`ÉCHEC ouverture log : ${msg}`)
    throw new Error(msg)
  }

  /**
   * Spawn the CLI server on `port`. The password printed on stdout is
   * captured from a LOG FILE (Electron pipes proved unreliable) and saved as
   * soon as it appears, so a later attempt can reconnect even if this one
   * gives up.
   */
  private async spawnServer(port: number): Promise<string | undefined> {
    if (this.child && !this.child.killed) this.child.kill()
    const { path: logFile, handle: out } = await this.openServeLog(port)
    trail(`spawn port=${String(port)} cli=${this.settings.cliPath} log=${logFile}`)
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
    let lastState = ""
    while (Date.now() < deadline) {
      // parse from the file — works regardless of Electron pipe buffering
      try {
        const text = await readFile(logFile, "utf8").catch(() => "")
        const password = parseServePassword(text)
        if (password && this.settings.passwords[String(port)] !== password) {
          this.settings.passwords[String(port)] = password
          await this.saveSettings()
          trail(`mot de passe capturé (port ${String(port)}, enregistré dans data.json)`)
        }
        const headers = password ? { authorization: basicAuth(password) } : undefined
        const state = await probe(sdkFactory, baseUrl, headers)
        if (state !== lastState) {
          trail(`probe port ${String(port)} : ${state}`)
          lastState = state
        }
        if (state === "ok") {
          trail(`serveur prêt sur le port ${String(port)}`)
          return password
        }
      } catch { /* keep polling */ }
      await new Promise((r) => setTimeout(r, 800))
    }
    const msg = `Le serveur OpenCode n'est pas devenu joignable sur le port ${port} (90 s). Logs : ${logFile}`
    trail(`ÉCHEC : ${msg}`)
    throw new Error(msg)
  }

  private ensureServerPromise: Promise<{ baseUrl: string; password?: string }> | null = null

  /**
   * Find or start a usable server (pure decision in bridge.planServer).
   * Les appels concurrents PARTAGENT une seule exécution : sans ça, deux
   * appels rapprochés démarrent deux serveurs (course vécue le 2026-10-18 :
   * 17456 puis 17457, le second tuant le premier).
   */
  async ensureServer(): Promise<{ baseUrl: string; password?: string }> {
    if (!this.ensureServerPromise) {
      this.ensureServerPromise = this.ensureServerOnce().finally(() => { this.ensureServerPromise = null })
    }
    return this.ensureServerPromise
  }

  private async ensureServerOnce(): Promise<{ baseUrl: string; password?: string }> {
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
  private menuEl!: HTMLElement
  private commands: CommandInfo[] = []
  private commandsFetchedAt = 0
  private menuOpen = false
  private filtered: CommandInfo[] = []
  private selection = 0
  private lastQuery = ""

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
    this.menuEl = composer.createDiv({ cls: "ocmc-cmd-menu" })
    this.inputEl = composer.createEl("textarea", { cls: "ocmc-input" }) as HTMLTextAreaElement
    this.inputEl.rows = 2
    this.inputEl.placeholder = "Posez une question à la mémoire… (tapez / pour les commandes)"
    const send = composer.createEl("button", { text: "Envoyer", cls: "ocmc-send" })
    send.onclick = () => this.send()
    this.inputEl.addEventListener("input", () => { void this.refreshCommandMenu() })
    this.inputEl.addEventListener("keydown", (e) => {
      if (this.menuOpen) {
        if (e.key === "ArrowDown") { e.preventDefault(); this.moveSelection(1); return }
        if (e.key === "ArrowUp") { e.preventDefault(); this.moveSelection(-1); return }
        if (e.key === "Escape") { e.preventDefault(); this.closeMenu(); return }
        if (e.key === "Tab") { e.preventDefault(); this.completeSelected(); return }
        if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void this.executeSelected(); return }
      }
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

    // Liste dynamique des commandes (best-effort : le panneau s'ouvre sans).
    void this.loadCommands()
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
    // Commande connue du serveur → exécution réelle ; sinon message normal
    // (compatibilité : « /quelque chose » inconnu part comme avant). Si le
    // texte ressemble à une commande mais que la liste peut être périmée ou
    // vide (serveur qui vient de démarrer), on la recharge d'abord : taper
    // /dream pendant le spawn ne doit PAS partir en message normal.
    let command = parseCommandInput(text)
    if (command && (this.commands.length === 0 || Date.now() - this.commandsFetchedAt > COMMAND_TTL_MS)) {
      await this.loadCommands()
      command = parseCommandInput(text)
    }
    if (command && this.commands.some((c) => c.name === command.name)) {
      await this.runCommand(command.name, command.args, text)
      return
    }
    this.busy = true
    this.inputEl.value = ""
    this.closeMenu()
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

  /* --- Palette de commandes « / » (liste dynamique du serveur) ----------- */

  private async loadCommands(): Promise<void> {
    if (this.busy) return
    try {
      const c = await this.plugin.getController()
      this.commands = await c.listCommands()
    } catch {
      // Serveur pas encore joignable : la palette reste indisponible,
      // l'envoi normal fonctionne toujours. Nouvel essai après le TTL.
      this.commands = []
    }
    this.commandsFetchedAt = Date.now()
  }

  private closeMenu() {
    if (!this.menuOpen && this.filtered.length === 0) return
    this.menuOpen = false
    this.filtered = []
    this.lastQuery = ""
    this.menuEl.empty()
    this.menuEl.removeClass("is-open")
  }

  private async refreshCommandMenu(): Promise<void> {
    if (this.busy) { this.closeMenu(); return }
    const value = this.inputEl.value
    // Palette ouverte seulement pendant la frappe du NOM (« /mem ») ;
    // dès qu'un espace apparaît (arguments), elle se ferme.
    if (!value.startsWith("/") || /\s/.test(value)) { this.closeMenu(); return }
    if (this.commands.length === 0 || Date.now() - this.commandsFetchedAt > COMMAND_TTL_MS) {
      await this.loadCommands()
      if (this.inputEl.value !== value) { void this.refreshCommandMenu(); return }
    }
    const query = value.slice(1)
    const filtered = filterCommands(this.commands, query)
    if (filtered.length === 0) { this.closeMenu(); return }
    if (query !== this.lastQuery) { this.selection = 0; this.lastQuery = query }
    this.filtered = filtered
    this.menuOpen = true
    this.renderMenu()
  }

  private renderMenu() {
    this.menuEl.empty()
    this.filtered.forEach((cmd, index) => {
      const item = this.menuEl.createDiv({ cls: "ocmc-cmd-item" })
      item.toggleClass("is-selected", index === this.selection)
      item.createDiv({ cls: "ocmc-cmd-name", text: `/${cmd.name}` })
      if (cmd.description) item.createDiv({ cls: "ocmc-cmd-desc", text: cmd.description })
      item.addEventListener("mousedown", (e) => {
        e.preventDefault() // garder le focus dans la zone de saisie
        this.selection = index
        void this.executeSelected()
      })
    })
    this.menuEl.addClass("is-open")
  }

  private moveSelection(delta: number) {
    if (this.filtered.length === 0) return
    this.selection = nextCommandSelection(this.selection, delta, this.filtered.length)
    this.renderMenu()
  }

  /** Tab : complète le nom sélectionné (« /dream ») sans exécuter. */
  private completeSelected() {
    const cmd = this.filtered[this.selection]
    if (!cmd) return
    this.inputEl.value = `/${cmd.name} `
    this.inputEl.focus()
    this.closeMenu()
  }

  /** Entrée (palette ouverte) ou clic : exécute la commande sélectionnée. */
  private async executeSelected() {
    const cmd = this.filtered[this.selection]
    if (!cmd) return
    this.closeMenu()
    await this.runCommand(cmd.name, "")
  }

  private async runCommand(name: string, args: string, display?: string) {
    if (this.busy) return
    this.busy = true
    this.inputEl.value = ""
    this.closeMenu()
    this.renderMessage("user", display ?? (args ? `/${name} ${args}` : `/${name}`))
    this.setStatus(`Commande /${name} en cours… (peut prendre plusieurs minutes)`)
    try {
      const c = await this.plugin.getController()
      const msgs = await c.sendCommand(name, args)
      // La sortie d'une commande peut être une réponse d'agent (memory) OU un
      // bilan système (/dream, entrée synthétique).
      const last = [...msgs].reverse().find((m) => m.role !== "user")
      if (last) this.renderMessage(last.role, last.text)
      else this.renderMessage("system", "(commande exécutée)")
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
