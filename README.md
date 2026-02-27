# OpenVibez

A local-first, privacy-respecting AI coding assistant for your desktop. Built with Electron, React, and TypeScript.

OpenVibez gives you a native chat interface that connects to the AI providers you already pay for — no middleman, no cloud relay, no telemetry. Your keys stay in your OS keychain, your data stays in a local SQLite database, and your conversations never leave your machine.

![Chat View](docs/screenshots/chat-empty.png)
![Settings](docs/screenshots/settings.png)

> **Status:** Early alpha. Core chat loop works with OpenAI API keys, ChatGPT subscriptions, Anthropic API keys, Gemini API keys, OpenRouter API keys, Grok API keys, and local Ollama models, including autonomous local CLI execution and cancellable runs.

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
2. Add a provider (OpenAI API Key, ChatGPT Subscription, Anthropic API Key, Gemini API Key, OpenRouter API Key, or Local/Ollama)
3. For OpenAI-compatible APIs (custom endpoints, LM Studio, vLLM, xAI, etc.): choose OpenAI, add key, pick/set endpoint profile or API base URL, then hit **Save + Test**
4. For subscription: click **Connect ChatGPT** and complete the device login flow
5. For Anthropic, Gemini, or OpenRouter: paste key and hit **Save + Test**
6. For Ollama: select **Local (Ollama)** and use **Test Default** (or save a custom endpoint URL)
7. Optional: for OpenAI compatibility mode, save named endpoint profiles and set a default fallback
8. Models sync automatically on successful connection

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
- [x] Multi-provider chat support: OpenAI API, ChatGPT subscription (Codex), Anthropic API, Gemini API, OpenRouter API, and local Ollama
- [x] Native Gemini provider path with provider-specific model sync and response/error handling
- [x] OpenRouter first-class provider mode with provider headers (`HTTP-Referer`, `X-Title`) and model pricing sync
- [x] OpenRouter usage/cost attribution via model pricing map (microunit tracking in usage events)
- [x] OpenAI-compatible endpoint profiles (named profiles, default profile fallback, per-provider profile selection)
- [x] OpenAI-compatible endpoint mode (base URL override) for custom OpenAI-style providers (LM Studio, vLLM, xAI, etc.)
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
- [x] Advanced Ollama controls (temperature, output tokens, `num_ctx`) plus local diagnostics

---

## Roadmap

### Multi-Provider Support

Current baseline:

- **OpenAI** (API key + subscription via Codex)
- **Anthropic / Claude** (API key)
- **Gemini** native provider mode
- **OpenRouter** first-class provider mode with usage/cost attribution
- **Local Ollama** with runtime controls + diagnostics
- **OpenAI-compatible endpoints** with named profiles and per-provider selection

Next up:

- **xAI / Grok direct provider mode** — dedicated native path instead of compatibility-only setup.
- **Provider health monitor** — background checks and actionable status for stale keys/endpoints.
- **Per-provider model presets** — stronger defaults and quick-select packs by workload.

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
