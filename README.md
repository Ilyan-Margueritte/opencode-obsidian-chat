# OpenCode Memory Chat (plugin Obsidian)

Petit panneau latéral Obsidian pour discuter avec l'agent `@memory`
d'[opencode-memory-obsidian](https://github.com/Ilyan-Margueritte/opencode-memory-obsidian)
directement depuis votre vault.

## Zéro configuration

1. Copiez `main.js`, `manifest.json`, `styles.css` dans
   `<vault>/.obsidian/plugins/opencode-memory-chat/` (ou lancez `bun run scripts/install.ts <vault>`).
2. Activez le plugin dans Obsidian (Paramètres → Plugins communautaires — il est
   déjà listé si `community-plugins.json` le contient).
3. Cliquez l'icône 🧠 (ruban) : le panneau démarre le serveur OpenCode V2 tout
   seul s'il n'est pas lancé (`opencode serve`, port 17456 par défaut).

## Comment ça marche

- **Serveur** : le plugin détecte un serveur déjà lancé ; sinon il démarre le
  CLI V2 (par défaut le binaire embarqué du desktop :
  `%LOCALAPPDATA%\Programs\@opencodedesktop\resources\opencode-cli.exe`,
  réglage « Chemin du CLI »). Le mot de passe émis par `serve` sur stdout est
  capturé automatiquement (Basic auth `opencode:<password>`) et mémorisé.
  Si le port est occupé par un serveur étranger, les 5 ports suivants sont essayés.
- **Session** : une conversation = une session OpenCode avec l'agent `memory`
  (les 9 outils `tools.memory_*` via le catalogue Code Mode). Bouton
  « Nouvelle discussion » = nouvelle session.
- **Modèle** : réglable. Par défaut `nvidia/nemotron-3.5-super-vl-120b-a12b` —
  vérifié fonctionnant HORS de l'app OpenCode (les modèles gratuits `opencode/*`
  refusent les clients externes).
- **Complétion** : le panneau attend l'entrée `idle` de la session (le message
  assistant apparaît dès le premier token streamé).

## Développement

```bash
bun install
bun run check   # typecheck + tests + build esbuild
bun run scripts/install.ts "C:/path/du/vault"   # installe + active dans le vault
bun run scripts/e2e-chat.ts <serve-stdout-log>  # chat réel bout-en-bout
```

Tests : 17 (logique pure du pont — aucun mock Obsidian).
