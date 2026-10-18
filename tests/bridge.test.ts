import { describe, expect, test } from "bun:test"
import {
  ChatController,
  contextToMessages,
  entryRole,
  entryText,
  extractSessionId,
  DEFAULT_MODEL,
  DEFAULT_PORT,
  baseUrlForPort,
  probeServer,
  parseServePassword,
  basicAuthHeader,
  planServer,
  pluginFolderPath,
  serveLogPath,
  serveLogCandidates,
  normalizeHeaders,
} from "../src/bridge"
import { isAbsolute, join } from "node:path"

describe("bridge helpers", () => {
  test("baseUrlForPort", () => {
    expect(baseUrlForPort(17456)).toBe("http://127.0.0.1:17456")
  })
  test("extractSessionId prefers sessionID", () => {
    expect(extractSessionId({ sessionID: "s1", id: "x" })).toBe("s1")
    expect(extractSessionId({ id: "x" })).toBe("x")
    expect(extractSessionId({})).toBeUndefined()
  })
  test("entryText from text field", () => {
    expect(entryText({ text: "hi" })).toBe("hi")
  })
  test("entryText from content array", () => {
    expect(entryText({ content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] })).toBe("a\nb")
  })
  test("entryRole", () => {
    expect(entryRole({ type: "user" })).toBe("user")
    expect(entryRole({ type: "assistant" })).toBe("assistant")
    expect(entryRole({ role: "system" })).toBe("system")
  })
  test("contextToMessages filters empty", () => {
    const msgs = contextToMessages([{ id: "1", type: "user", text: "hi" }, { id: "2", type: "assistant", text: "   " }])
    expect(msgs).toHaveLength(1)
    expect(msgs[0].role).toBe("user")
  })
  test("defaults", () => {
    expect(DEFAULT_PORT).toBe(17456)
    expect(DEFAULT_MODEL.providerID).toBe("nvidia")
    expect(DEFAULT_MODEL.id).toContain("nemotron")
  })
})

describe("planServer (décision pure : réutiliser ou démarrer un serveur)", () => {
  const probeOf = (table: Record<number, "ok" | "unauthorized" | "down">) =>
    async (port: number) => table[port] ?? "down"

  test("serveur sans mot de passe déjà lancé → réutilise", async () => {
    const plan = await planServer(probeOf({ 17456: "ok" }), 17456, {})
    expect(plan).toEqual({ action: "reuse", port: 17456 })
  })

  test("notre ancien serveur (mot de passe mémorisé) → réutilise avec le mot de passe", async () => {
    const seen: Array<string | undefined> = []
    const plan = await planServer(
      async (port, password) => { seen.push(password); return password ? "ok" : "unauthorized" },
      17456,
      { "17456": "secret" },
    )
    expect(plan).toEqual({ action: "reuse", port: 17456, password: "secret" })
    expect(seen).toEqual(["secret"])
  })

  test("port occupé par un serveur étranger → démarre sur le port suivant", async () => {
    const plan = await planServer(
      async (port) => (port === 17456 ? "unauthorized" : "down"),
      17456,
      {},
    )
    expect(plan).toEqual({ action: "spawn", port: 17457 })
  })

  test("rien ne tourne → démarre sur le port de base", async () => {
    const plan = await planServer(probeOf({}), 17456, {})
    expect(plan).toEqual({ action: "spawn", port: 17456 })
  })

  test("tous les ports occupés par des serveurs étrangers → échec explicite", async () => {
    const plan = await planServer(async () => "unauthorized", 17456, {})
    expect(plan).toEqual({ action: "fail" })
  })
})

describe("chemins de fichiers (manifest.dir est RELATIF : bug ENOENT du 2026-10-18)", () => {
  test("pluginFolderPath reconstruit un chemin ABSOLU depuis le basePath du vault", () => {
    const base = process.platform === "win32" ? "C:\\Users\\x\\Documents\\obsidian\\opencode-memory" : "/home/x/opencode-memory"
    const p = pluginFolderPath(base, ".obsidian", "opencode-memory-chat")
    expect(isAbsolute(p)).toBe(true)
    expect(p).toBe(join(base, ".obsidian", "plugins", "opencode-memory-chat"))
  })

  test("serveLogPath place le log DANS le dossier du plugin (jamais relatif à l'appli Obsidian)", () => {
    const dir = join("C:\\vault", ".obsidian", "plugins", "opencode-memory-chat")
    const log = serveLogPath(dir, 17456)
    expect(isAbsolute(log)).toBe(true)
    expect(log).toBe(join(dir, "serve-17456.log"))
  })
})

describe("serveLogCandidates (le log doit TOUJOURS être écrivable : dossier plugin, sinon tmpdir)", () => {
  test("préfère le dossier du plugin, tmpdir en secours", () => {
    const plugin = join("C:\\vault", ".obsidian", "plugins", "opencode-memory-chat")
    const list = serveLogCandidates(plugin, "C:\\Temp", 17456)
    expect(list).toHaveLength(2)
    expect(list[0]).toBe(join(plugin, "serve-17456.log"))
    expect(list[1]).toBe(join("C:\\Temp", "serve-17456.log"))
  })

  test("dossier plugin indisponible (basePath inconnu) → tmpdir seul", () => {
    const list = serveLogCandidates(undefined, "C:\\Temp", 17456)
    expect(list).toEqual([join("C:\\Temp", "serve-17456.log")])
  })

  test("dossier plugin identique à tmpdir → aucun doublon", () => {
    const list = serveLogCandidates("C:\\Temp", "C:\\Temp", 17456)
    expect(list).toEqual([join("C:\\Temp", "serve-17456.log")])
  })
})

describe("normalizeHeaders (le SDK passe une instance Headers ; requestUrl exige un Record simple)", () => {
  test("objet simple → cloné tel quel", () => {
    expect(normalizeHeaders({ authorization: "Basic x" })).toEqual({ authorization: "Basic x" })
  })

  test("instance Headers → Record complet (bug 401 vécu le 2026-10-18)", () => {
    const h = new Headers()
    h.set("authorization", "Basic b3BlbmNvZGU6c2VjcmV0")
    h.set("content-type", "application/json")
    expect(normalizeHeaders(h as unknown as HeadersInit)).toEqual({
      authorization: "Basic b3BlbmNvZGU6c2VjcmV0",
      "content-type": "application/json",
    })
  })

  test("tableau de paires → Record", () => {
    expect(normalizeHeaders([["a", "1"], ["b", "2"]] as unknown as HeadersInit)).toEqual({ a: "1", b: "2" })
  })

  test("undefined → objet vide", () => {
    expect(normalizeHeaders(undefined)).toEqual({})
  })
})

describe("auth helpers", () => {
  test("parseServePassword", () => {
    const out = "server listening on http://127.0.0.1:17456\nserver password VevTRg_13JelIhwjyJ3YdTkH473Jn98VIprasZpleQ8\n"
    expect(parseServePassword(out)).toBe("VevTRg_13JelIhwjyJ3YdTkH473Jn98VIprasZpleQ8")
    expect(parseServePassword("server listening on http://x")).toBeUndefined()
  })
  test("basicAuthHeader is opencode:<password> base64", () => {
    expect(basicAuthHeader("abc")).toBe(`Basic ${Buffer.from("opencode:abc", "binary").toString("base64")}`)
  })
})

describe("probeServer", () => {
  test("returns true when info succeeds", async () => {
    const factory = () => ({ server: { info: async () => ({}) }, session: { create: async () => ({}) , prompt: async () => ({}), context: async () => ([]) } })
    expect(await probeServer(factory as any, "http://x")).toBe("ok")
  })
  test("returns false when info throws", async () => {
    const factory = () => ({ server: { info: async () => { throw new Error("no") } }, session: { create: async () => ({}) , prompt: async () => ({}), context: async () => ([]) } })
    expect(await probeServer(factory as any, "http://x")).toBe("down")
  })
  test("detects unauthorized servers (tag or message)", async () => {
    const tagErr = () => { const e = new Error("nope"); (e as any)._tag = "UnauthorizedError"; throw e }
    const factory = () => ({ server: { info: async () => tagErr() }, session: { create: async () => ({}) , prompt: async () => ({}), context: async () => ([]) } })
    expect(await probeServer(factory as any, "http://x")).toBe("unauthorized")
    const factory2 = () => ({ server: { info: async () => { throw new Error("Authentication required") } }, session: { create: async () => ({}) , prompt: async () => ({}), context: async () => ([]) } })
    expect(await probeServer(factory2 as any, "http://x")).toBe("unauthorized")
  })
  test("passes headers to the factory", async () => {
    let seen: Record<string, string> | undefined
    const factory = (_u: string, h?: Record<string, string>) => { seen = h; return { server: { info: async () => ({}) }, session: { create: async () => ({}) , prompt: async () => ({}), context: async () => ([]) } } }
    await probeServer(factory as any, "http://x", { authorization: "Basic zz" })
    expect(seen).toEqual({ authorization: "Basic zz" })
  })
})

describe("ChatController", () => {
  test("ensureSession creates and reuses", async () => {
    const createCalls: any[] = []
    const factory = () => ({
      server: { info: async () => ({}) },
      session: {
        create: async (input: any) => { createCalls.push(input); return { sessionID: "sid-1" } },
        prompt: async () => ({}),
        context: async () => [{ type: "user", text: "hi" }, { type: "assistant", text: "hello" }],
      },
    })
    const c = new ChatController(factory as any, { baseUrl: "http://x", agent: "memory", model: DEFAULT_MODEL })
    expect(await c.ensureSession()).toBe("sid-1")
    expect(await c.ensureSession()).toBe("sid-1")
    expect(createCalls).toHaveLength(1)
    expect(createCalls[0].agent).toBe("memory")
    expect(createCalls[0].model).toEqual(DEFAULT_MODEL)
  })
  test("send polls until assistant reply", async () => {
    let calls = 0
    const factory = () => ({
      server: { info: async () => ({}) },
      session: {
        create: async () => ({ sessionID: "sid-2" }),
        prompt: async () => ({}),
        context: async () => {
          calls++
          if (calls === 1) return [{ type: "user", text: "q" }]
          if (calls === 2) return [{ type: "user", text: "q" }, { type: "assistant", text: "" }] // streaming, empty
          return [{ type: "user", text: "q" }, { type: "assistant", text: "a" }, { type: "idle" }]
        },
      },
    })
    const c = new ChatController(factory as any, { baseUrl: "http://x", agent: "memory", model: DEFAULT_MODEL })
    const msgs = await c.send("q")
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant"])
    expect(msgs[1].text).toBe("a")
  })
  test("send returns on idle even with partial text", async () => {
    let calls = 0
    const factory = () => ({
      server: { info: async () => ({}) },
      session: {
        create: async () => ({ sessionID: "sid-4" }),
        prompt: async () => ({}),
        context: async () => {
          calls++
          if (calls === 1) return [{ type: "user", text: "q" }]
          return [{ type: "user", text: "q" }, { type: "assistant", text: "" }, { type: "idle" }]
        },
      },
    })
    const c = new ChatController(factory as any, { baseUrl: "http://x", agent: "memory", model: DEFAULT_MODEL })
    const msgs = await c.send("q")
    expect(msgs).toHaveLength(1) // empty assistant is filtered out
  })
  test("reset clears session", async () => {
    const factory = () => ({
      server: { info: async () => ({}) },
      session: {
        create: async () => ({ sessionID: "sid-3" }),
        prompt: async () => ({}),
        context: async () => [],
      },
    })
    const c = new ChatController(factory as any, { baseUrl: "http://x", agent: "memory", model: DEFAULT_MODEL })
    await c.ensureSession()
    c.reset()
    expect(await c.history()).toEqual([])
  })

  test("resumeSession reprend la session sauvegardée sans en créer une nouvelle", async () => {
    let creates = 0
    const factory = () => ({
      server: { info: async () => ({}) },
      session: {
        create: async () => { creates++; return { sessionID: "sid-new" } },
        prompt: async () => ({}),
        context: async () => [{ type: "user", text: "ancien message" }, { type: "assistant", text: "ancienne réponse" }],
      },
    })
    const c = new ChatController(factory as any, { baseUrl: "http://x", agent: "memory", model: DEFAULT_MODEL })
    await c.resumeSession("ses_saved")
    expect(c.sessionID).toBe("ses_saved")
    const history = await c.history()
    expect(history).toHaveLength(2)
    expect(history[0].text).toBe("ancien message")
    // ensureSession ne doit PAS créer une nouvelle session
    expect(await c.ensureSession()).toBe("ses_saved")
    expect(creates).toBe(0)
  })

  test("expose la session courante pour la persistance", async () => {
    const factory = () => ({
      server: { info: async () => ({}) },
      session: {
        create: async () => ({ sessionID: "sid-5" }),
        prompt: async () => ({}),
        context: async () => [],
      },
    })
    const c = new ChatController(factory as any, { baseUrl: "http://x", agent: "memory", model: DEFAULT_MODEL })
    expect(c.sessionID).toBeNull()
    await c.ensureSession()
    expect(c.sessionID).toBe("sid-5")
  })
})
