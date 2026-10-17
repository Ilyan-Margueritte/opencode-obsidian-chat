// One-shot: enable the plugin in the vault's community-plugins.json.
import { readFileSync, writeFileSync, existsSync } from "node:fs"
const vault = "C:/Users/ordi2525778/Documents/obsidian/opencode-memory"
const file = `${vault}/.obsidian/community-plugins.json`
const id = "opencode-memory-chat"
let ids: string[] = []
if (existsSync(file)) {
  try { ids = JSON.parse(readFileSync(file, "utf8")) } catch { ids = [] }
}
if (!ids.includes(id)) ids.push(id)
writeFileSync(file, JSON.stringify(ids), "utf8")
console.log("ENABLED:", readFileSync(file, "utf8"))
