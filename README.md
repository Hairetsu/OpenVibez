# OpenVibez

A local-first, privacy-respecting AI coding assistant for your desktop. Built with Electron, React, and TypeScript.

OpenVibez gives you a native chat interface that connects to the AI providers you already pay for — no middleman, no cloud relay, no telemetry. Your keys stay in your OS keychain, your data stays in a local SQLite database, and your conversations never leave your machine.

![Chat View](docs/screenshots/chat-empty.png)
![Settings](docs/screenshots/settings.png)

> **Status:** Early alpha. Core chat loop works with OpenAI API keys, ChatGPT subscriptions, and local Ollama models, including autonomous local CLI execution and cancellable runs.

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

**Main process** handles all sensitive operations — keychain access, database queries, API calls to providers, and subprocess management for Codex CLI integration. The renderer never touches secrets or makes network requests directly.

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
2. Add a provider (OpenAI API Key, ChatGPT Subscription, or Local/Ollama)
3. For OpenAI API key: paste your key, hit **Save + Test**
4. For subscription: click **Connect ChatGPT** and complete the device login flow
5. For Ollama: select **Local (Ollama)** and use **Test Default** (or save a custom endpoint URL)
6. Models sync automatically on successful connection

### Environment variables

| Variable | Description |
|---|---|
| `OPENVIBEZ_DEVTOOLS` | Set to `1` to auto-open DevTools on launch |
| `OPENVIBEZ_CODEX_BIN` | Absolute path to Codex CLI binary (for subscription mode) |

---

## Recent Improvements

- **Local tool-calling agent loop (Ollama)** — local models now receive a strict tool protocol and can run iterative CLI actions (`run_shell`) until tasks are complete.
- **Checklist-driven execution** — local runs now require an explicit plan, step checkoffs, and finalization only after all steps are complete.
- **Inline iteration feed** — action traces (planned steps, commands, exit codes, truncated stdout/stderr) now render directly in the message feed.
- **Cross-provider cancel support** — active runs can be cancelled from the composer button for OpenAI, Codex subscription, and local/Ollama sessions.
- **Send-vs-cancel composer behavior** — when text exists, pressing the button sends new input; when empty during an active run, it cancels the run.
- **Interrupt-and-replace flow** — sending a new message during an active run now cancels the in-flight run first, then starts the new request.

---

## What's Built

- [x] Electron shell with frameless macOS title bar and native drag region
- [x] Provider management — create, configure, test connections
- [x] API key auth with OS keychain storage (keytar)
- [x] ChatGPT subscription auth via Codex CLI device login
- [x] Local model support via Ollama (default `http://127.0.0.1:11434`)
- [x] Local CLI tool execution loop (`run_shell`) with multi-step autonomous task completion
- [x] Plan/checklist enforcement for local agent runs
- [x] Model discovery — auto-sync available models from provider
- [x] Session management — create, switch, persist conversations
- [x] Streaming chat with real-time text deltas
- [x] Trace visualization — thought, plan, and action traces during execution (inline in message feed)
- [x] Cancel in-flight requests (OpenAI, Codex, and local/Ollama)
- [x] Workspace scoping — attach project directories, control execution sandbox
- [x] Scoped vs root execution modes
- [x] Token usage tracking with 30-day cost summary
- [x] SQLite persistence for all data (Drizzle ORM)
- [x] Background job scheduler infrastructure

---

## Roadmap

### Multi-Provider Support

The type system already supports `openai | anthropic | local` provider types. Next up:

- **Anthropic / Claude** — Direct API integration with Claude 4 family models. Same key-in-keychain pattern as OpenAI.
- **Google Gemini** — API key auth, model sync, streaming completions.
- **OpenRouter** — Single key, access to 100+ models from every major provider.
- **Advanced Local / Ollama** — richer local runtime controls (per-provider endpoint presets, model options, and diagnostics).
- **Custom OpenAI-compatible** — Any endpoint that speaks the OpenAI chat completions API (LM Studio, vLLM, text-generation-webui, etc.)

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
