// Diagnostic : quelle forme d'en-têtes mon shim obsidianFetch reçoit-il du SDK ?
import { OpenCode } from "@opencode/client/promise"
import { readFileSync } from "node:fs"

const v = "C:/Users/ordi2525778/Documents/obsidian/opencode-memory/.obsidian/plugins/opencode-memory-chat/"
const pw = JSON.parse(readFileSync(v + "data.json", "utf8")).passwords["17457"]
const auth = "Basic " + Buffer.from("opencode:" + pw, "binary").toString("base64")

// 1) CONTRÔLE : le serveur vivant sur 17457 répond-il 200 avec la vraie auth ?
const r = await fetch("http://127.0.0.1:17457/api/info", { headers: { authorization: auth } })
console.log("CONTROLE fetch natif : status=" + r.status + " body=" + (await r.text()).slice(0, 80))
const r2 = await fetch("http://127.0.0.1:17457/api/info")
console.log("CONTROLE sans auth   : status=" + r2.status)

// 2) ESPION : que reçoit exactement un fetch custom (celui de mon shim) ?
const spy = (input: any, init: any = {}) => {
  const h = init.headers
  console.log("ESPION input =", typeof input, input instanceof URL ? "(URL)" : "")
  console.log("ESPION headers: typeof=" + typeof h + " | constructor=" + (h && h.constructor && h.constructor.name))
  if (h instanceof Headers) {
    const o: Record<string, string> = {}
    h.forEach((val, key) => { o[key] = val })
    console.log("ESPION headers(Headers) =", JSON.stringify(o))
  } else if (Array.isArray(h)) {
    console.log("ESPION headers(array) =", JSON.stringify(h))
  } else {
    console.log("ESPION headers(objet) =", JSON.stringify(h))
  }
  console.log("ESPION body: typeof=" + typeof init.body + " constructor=" + (init.body && init.body.constructor && init.body.constructor.name))
  return Promise.resolve(new Response("{}", { status: 200, headers: { "content-type": "application/json" } }))
}
const client = OpenCode.make({ baseUrl: "http://127.0.0.1:17457", headers: { authorization: auth }, fetch: spy as any })
try {
  await (client as any).server.info()
  console.log("info() OK avec le fetch espion")
} catch (e) {
  console.log("info() a échoué :", String(e).slice(0, 200))
}

// 3) ESPION avec création de session (méthode POST) : forme du body + headers ?
try {
  await (client as any).session.create({ title: "x", agent: "memory", model: { providerID: "nvidia", id: "nvidia/nemotron-3.5-super-vl-120b-a12b" } })
  console.log("create() OK avec le fetch espion")
} catch (e) {
  console.log("create() a échoué :", String(e).slice(0, 200))
}
