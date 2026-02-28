# OpenVibez

OpenVibez is a local-first desktop AI coding assistant built with Electron, React, and TypeScript.

It connects directly to the providers you already use, stores secrets in your OS keychain, keeps app data in local SQLite, and runs provider and shell orchestration in the Electron main process instead of a hosted relay.

![Chat View](docs/screenshots/chat-empty.png)
![Settings](docs/screenshots/settings.png)

> **Status:** Early alpha.
>
> OpenVibez can execute local shell commands and supports elevated/root-style execution modes. Treat it like powerful experimental software, not a sandboxed product.

## What It Does Today

- Direct provider connections with no OpenVibez cloud relay
- Local persistence for sessions, messages, settings, usage, and run recovery state
- OS keychain secret storage via `keytar`
- Streaming chat with live status updates and trace/timeline output
- Workspace attachment with trust levels and scoped vs root execution modes
- Command policy enforcement for high-risk commands, read-only workspaces, and out-of-scope cwd access
- Per-provider model sync and selection
- Markdown rendering with syntax highlighting in chat messages
- 30-day token and cost summary in Settings

## Provider Support

| Provider | Status | Notes |
|---|---|---|
| OpenAI API | Shipped | Native OpenAI path, model sync, custom base URL / OpenAI-compatible endpoints, optional background-mode pilot |
| ChatGPT subscription | Shipped | Codex device login flow, approval policy controls, optional output schema, Codex SDK pilot fallback path |
| Anthropic | Shipped | Native provider connection plus autonomous local CLI execution flow |
| Gemini | Shipped | Native Gemini provider path and model sync |
| OpenRouter | Shipped | Native OpenRouter provider path, provider headers, pricing sync, cost attribution, autonomous local CLI execution with direct-response fallback |
| Grok (xAI) | Shipped | Native Grok provider path with direct xAI API support and autonomous local CLI execution |
| Ollama | Shipped | Local models, diagnostics, runtime controls, native tool-calling path with protocol fallback |

## Feature Breakdown

### Core app

- Electron desktop app with React renderer and typed preload IPC bridge
- Main-process ownership of secrets, DB access, provider calls, background jobs, and shell execution
- SQLite storage for providers, model profiles, workspaces, sessions, messages, usage events, settings, assistant runs, and background jobs
- Automatic session title generation from conversation context

### Chat and agent flow

- Streaming assistant output with cancellable in-flight runs
- Trace rendering for plan, thought, action, command, and command-result events
- Per-session timeline persistence in app settings
- Restart reconciliation for interrupted runs, plus OpenAI background polling for long-running responses

### Workspace and execution controls

- Attach local projects as workspaces
- Trust levels: `trusted`, `read_only`, `untrusted`
- Access modes: `scoped` and `root`
- Policy gates:
  - `scoped` commands must stay inside the selected workspace
  - `read_only` workspaces block mutating commands
  - `untrusted` workspaces block shell execution
  - when a workspace is selected, `root` mode requires it to be trusted
  - known high-risk commands are blocked

### Provider-specific extras

- OpenAI-compatible endpoint profiles with saved defaults
- OpenRouter app origin/title controls and synced pricing map
- Ollama diagnostics plus temperature, output-token, and `num_ctx` controls
- Codex approval-policy and output-schema controls

## Project Layout

```text
openvibez/
├── apps/desktop/     # Electron app (main, preload, renderer)
├── db/               # Drizzle schema + migrations
├── docs/             # specs and architecture notes
└── packages/shared/  # shared contracts/types
```

## Getting Started

```bash
git clone <repo-url> OpenVibez
cd OpenVibez
npm install
npm run dev
```

Other useful commands:

```bash
npm run build
npm run typecheck
npm run db:generate
npm run db:studio
```

### Provider setup

1. Open **Settings**.
2. Add a provider.
3. Save a key or complete ChatGPT device login.
4. Run **Save + Test** or **Check** to sync models.
5. Start a session and pick a model/access mode.

### Environment variables

| Variable | Description |
|---|---|
| `OPENVIBEZ_DEVTOOLS` | Set to `1` to auto-open DevTools on launch |
| `OPENVIBEZ_CODEX_BIN` | Absolute path to the Codex CLI binary for subscription mode |

## Roadmap

### Highest priority

- Code block actions: copy, save/apply-to-file, and tighter code review ergonomics
- Conversation search, filtering, and better session management
- System prompt controls per session or workspace
- Better session branching/forking workflows

### Provider and runtime work left

- Provider health/status checks for stale keys, broken endpoints, and degraded local runtimes
- Broader provider-native tool use instead of compatibility/prompt-protocol fallbacks where possible
- Stronger long-run recovery and resume behavior outside the current OpenAI background pilot
- More explicit per-provider presets and model defaults

### Shipping and hardening

- Packaged release workflow and auto-update support
- Opt-in crash reporting / diagnostics
- Headless or CLI companion mode
- Extension/plugin surface for custom providers or tools
- Automated test coverage for provider flows, restart recovery, and command-policy enforcement

## Tech Stack

| Layer | Stack |
|---|---|
| Desktop shell | Electron 39 |
| UI | React 19, Vite 7, TypeScript 5.9 |
| Styling | Tailwind CSS, Radix UI |
| State | Zustand |
| Persistence | SQLite + `better-sqlite3`, Drizzle ORM |
| Secrets | `keytar` / OS keychain |
| Providers | OpenAI SDK, Codex CLI / SDK pilot, direct provider integrations |

## License

MIT
