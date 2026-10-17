// Probe: list providers/models available to the spawned server, then try ONE
// prompt with a candidate model to see which providers work OUTSIDE the app.
import { OpenCode } from "@opencode/client/promise"

const logPath = process.argv[2]
const log = await Bun.file(logPath).text()
const password = /server password (\S+)/.exec(log)![1]
const headers = { authorization: "Basic " + Buffer.from(`opencode:${password}`).toString("base64") }
const client = OpenCode.make({ baseUrl: "http://127.0.0.1:17456", headers })

const models = await client.model.list()
console.log("MODELS RAW:", JSON.stringify(models).slice(0, 600))

// try candidates
const candidates = [
  { providerID: "nvidia", id: "z-ai/glm-5.3-flash" },
  { providerID: "nvidia", id: "nvidia/nemotron-3.5-super-vl-120b-a12b" },
]
for (const model of candidates) {
  try {
    const s = await client.session.create({ title: "probe", model } as any)
    const sid = (s as any).sessionID ?? (s as any).id
    await client.session.prompt({ sessionID: sid, text: "Réponds juste: OK" } as any)
    const deadline = Date.now() + 60000
    let reply = ""
    while (Date.now() < deadline) {
      const ctx = await client.session.context({ sessionID: sid }) as any[]
      const last = ctx[ctx.length - 1]
      if (ctx.length >= 2 && last && String(last.type ?? "").includes("assistant")) {
        reply = (last.content ?? []).map((p: any) => p?.text ?? "").join(" ")
        break
      }
      await Bun.sleep(800)
    }
    console.log(`MODEL ${model.providerID}/${model.id} -> ${reply ? "OK: " + reply.slice(0, 80) : "EMPTY/TIMEOUT"}`)
    const ctx = await client.session.context({ sessionID: sid }) as any[]
    for (const msg of ctx) {
      const text = typeof msg.text === "string" && msg.text ? msg.text : Array.isArray(msg.content) ? msg.content.map((p: any) => p?.text ?? "").join(" ") : ""
      console.log(`   [${msg.type}] ${String(text).slice(0, 200)}`)
    }
  } catch (e) {
    console.log(`MODEL ${model.providerID}/${model.id} -> ERROR ${String(e).slice(0, 120)}`)
  }
}
