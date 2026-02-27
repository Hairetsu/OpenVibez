# OpenVibez

A local-first, privacy-respecting AI coding assistant for your desktop. Built with Electron, React, and TypeScript.

OpenVibez gives you a native chat interface that connects to the AI providers you already pay for — no middleman, no cloud relay, no telemetry. Your keys stay in your OS keychain, your data stays in a local SQLite database, and your conversations never leave your machine.

![Chat View](docs/screenshots/chat-empty.png)
![Settings](docs/screenshots/settings.png)

> **Status:** Early alpha. Core chat loop works with OpenAI API keys, ChatGPT subscriptions, Anthropic API keys, and local Ollama models, including autonomous local CLI execution and cancellable runs.

> [!WARNING]
> **This is very early alpha software.** I've directed the vision, but fully embraced the vibes while building it — and it shows. OpenVibez has direct CLI access and can be given root execution privileges. **I take zero responsibility** for what happens if you hand it the keys to your system. This is a fun experiment, not production software. Use at your own risk.

---

## Why OpenVibez

Most AI coding tools lock you into a single provider, route your code through their servers, or charge a markup on top of API costs. OpenVibez takes a different approach:

- **Bring your own keys** — connect any provider directly, pay API prices
- **Local-first** — SQLite database, OS keychain for secrets, zero cloud dependency
- **Multi-provider** — use different models for different tasks in the same session
- **Stream-first** — real-time streaming with thought/plan/action trace visibility
- **Workspace-scoped** — attach project directories and control execution scope (sandboxed or root)

---

## Architecture

```
openvibez/
├── apps/desktop/          # Electron desktop app
│   ├── src/main/          # Main process (IPC, DB, providers, keychain)
│   ├── src/preload/       # Context bridge + type contracts
│   └── src/renderer/      # React UI (Vite + Tailwind + Radix)
├── db/                    # Drizzle ORM schema + migrations
│   └── schema/tables/     # providers, sessions, messages, models, usage, jobs
└── packages/shared/       # Shared types and utilities
```

**Main process** handles all sensitive operations — keychain access, database queries, provider runner orchestration, API calls, and subprocess management for Codex CLI integration. The renderer never touches secrets or makes network requests directly.

**Renderer** is a React SPA with Zustand for state, Radix UI primitives, and Tailwind CSS. Communication with main happens exclusively through typed IPC channels exposed via `contextBridge`.

**Database** is SQLite via `better-sqlite3` + Drizzle ORM, stored in the Electron user data directory. Schema covers providers, sessions, messages, model profiles, workspace projects, usage events, app settings, and background jobs.

---

## Getting Started

```bash
# Clone and install
git clone https://github.com/your-org/openvibez.git
cd openvibez
npm install

# Run in development
npm run dev

# Build for production
npm run build

# Type check
npm run typecheck

# Database migrations
npm run db:generate
npm run db:studio
```

### Connect a provider

1. Launch the app and go to **Settings**
2. Add a provider (OpenAI API Key, ChatGPT Subscription, Anthropic API Key, or Local/Ollama)
3. For OpenAI-compatible APIs (OpenAI, OpenRouter, Gemini-compatible, custom): paste key, optionally set API base URL, hit **Save + Test**
4. For subscription: click **Connect ChatGPT** and complete the device login flow
5. For Anthropic: paste key and hit **Save + Test**
6. For Ollama: select **Local (Ollama)** and use **Test Default** (or save a custom endpoint URL)
7. Models sync automatically on successful connection

### Environment variables

| Variable | Description |
|---|---|
| `OPENVIBEZ_DEVTOOLS` | Set to `1` to auto-open DevTools on launch |
| `OPENVIBEZ_CODEX_BIN` | Absolute path to Codex CLI binary (for subscription mode) |

---

## What's Built

- [x] Electron shell with frameless macOS title bar and native drag region
- [x] Provider management — create, configure, test connections
- [x] API key auth with OS keychain storage (keytar)
- [x] Multi-provider chat support: OpenAI API, ChatGPT subscription (Codex), Anthropic API, and local Ollama
- [x] OpenAI-compatible endpoint mode (base URL override) for OpenRouter, Gemini-compatible API, and custom endpoints
- [x] Model discovery and sync per provider
- [x] Session management — create, switch, persist conversations
- [x] Streaming chat with real-time text deltas
- [x] Trace visualization — thought, plan, and action traces during execution (inline in message feed)
- [x] Cancellable in-flight requests across providers
- [x] Workspace scoping — attach project directories, control execution sandbox
- [x] Scoped/root execution modes with command policy enforcement by workspace trust
- [x] Token usage tracking with 30-day cost summary
- [x] Durable run persistence and restart recovery for interrupted tasks
- [x] SQLite persistence for sessions, messages, usage, settings, and background jobs
- [x] Codex approval policy + output schema controls
- [x] Optional OpenAI background mode and Codex SDK pilot (both remain opt-in)

---

## Roadmap

### Multi-Provider Support

Current baseline:

- **OpenAI** (API key + subscription via Codex)
- **Anthropic / Claude** (API key)
- **Local Ollama**
- **OpenAI-compatible endpoints** via base URL override (OpenRouter, Gemini-compatible API, custom providers)

Next up:

- **Gemini native integration** — direct provider path (not compatibility mode) with dedicated model and error handling.
- **OpenRouter first-class mode** — provider-specific headers, clearer model defaults, and usage/cost attribution.
- **Advanced Local / Ollama** — richer runtime controls (provider presets, model options, diagnostics).
- **Custom OpenAI-compatible profiles** — named endpoint profiles, per-endpoint defaults, and validation UX.

### Agent Capabilities

- Tool use and function calling with approval flow
- File read/write with diff preview
- Terminal command execution (sandboxed by workspace scope)
- Multi-step autonomous runs with pause/resume
- Trace-driven debugging — replay thought/plan/action sequences

### UX

- Markdown rendering with syntax highlighting in messages
- Code block copy and apply-to-file actions
- Conversation search and filtering
- Session branching (fork a conversation at any message)
- Keyboard-first navigation
- System prompt management per session or workspace

### Infrastructure

- Auto-updater (electron-updater)
- Crash reporting (opt-in)
- Plugin system for custom providers and tools
- CLI companion for headless usage

---

## Tech Stack

| Layer | Technology |
|---|---|
| Shell | Electron 39 |
| Renderer | React 19, Vite 7, TypeScript 5.9 |
| Styling | Tailwind CSS 3.4, Radix UI, CVA |
| State | Zustand 5 |
| Database | SQLite (better-sqlite3), Drizzle ORM |
| Secrets | OS Keychain (keytar) |
| IPC | Electron contextBridge with typed contracts |

---

## License

MIT
