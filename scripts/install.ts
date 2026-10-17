// Install the built plugin into an Obsidian vault and enable it.
// Usage: bun run scripts/install.ts "<vault path>"
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const vault = process.argv[2]
if (!vault) { console.error("usage: bun run scripts/install.ts <vault>"); process.exit(1) }
const here = import.meta.dir + "/.."
const dest = join(vault, ".obsidian", "plugins", "opencode-memory-chat")
mkdirSync(dest, { recursive: true })
for (const f of ["main.js", "manifest.json", "styles.css"]) {
  copyFileSync(join(here, f), join(dest, f))
  console.log("copied", f)
}
const listFile = join(vault, ".obsidian", "community-plugins.json")
const id = "opencode-memory-chat"
let ids: string[] = []
if (existsSync(listFile)) {
  try { ids = JSON.parse(readFileSync(listFile, "utf8")) } catch { ids = [] }
}
if (!ids.includes(id)) ids.push(id)
writeFileSync(listFile, JSON.stringify(ids), "utf8")
console.log("enabled:", readFileSync(listFile, "utf8"))
