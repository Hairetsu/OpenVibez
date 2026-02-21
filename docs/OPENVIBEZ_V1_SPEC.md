# OpenVibez v1 Specification

## 1) Product Goal
OpenVibez is a local-first Electron desktop client inspired by Codex-style workflows:
- chat + code assistance UX
- workspace-aware context
- provider/model switching
- secure credential handling
- reliable local history and settings

v1 priority: ship a stable, privacy-conscious single-user desktop app with minimal external dependencies.

## 2) Tech Decisions (v1)
- Runtime: Electron (latest stable)
- Language: TypeScript across main/preload/renderer
- UI: React + Vite (renderer)
- State: Zustand (renderer) + React Query for async/server state
- Validation: Zod
- Local DB: SQLite
- DB Driver: `better-sqlite3`
- ORM/Migrations: Drizzle ORM + drizzle-kit
- Secret Storage: `keytar` (OS keychain)
- Logging: `electron-log`
- Build/Packaging: electron-builder

Rationale:
- SQLite keeps infra/services near-zero.
- `better-sqlite3` is fast and stable for desktop.
- Drizzle gives typed schema + migrations without heavy overhead.
- API keys must never be stored in plain DB rows.

## 3) Architecture

### 3.1 Process Boundaries
- Main process:
  - app lifecycle, windows, tray/menu
  - secure DB access
  - secure keychain access
  - network calls to provider APIs (recommended)
  - file system/workspace operations
  - background jobs (indexing/sync tasks)
- Preload process:
  - strict, typed IPC bridge only
  - no direct Node exposure to renderer
- Renderer process:
  - UI only
  - calls typed APIs from preload
  - no direct secrets and no raw DB driver access

### 3.2 Security Model
- `contextIsolation: true`
- `nodeIntegration: false`
- strict CSP for renderer
- allowlist channels for IPC
- all sensitive operations proxied to main
- API key lifecycle:
  - renderer submits key to main via secure IPC
  - main writes secret to keychain using `keytar`
  - DB stores only non-sensitive metadata (provider id, label, createdAt, lastUsedAt)

## 4) Suggested Repo Layout

```txt
openvibez/
  package.json
  pnpm-lock.yaml
  tsconfig.base.json

  apps/
    desktop/
      electron-builder.yml
      vite.config.ts
      index.html

      src/
        main/
          index.ts                # app bootstrap + BrowserWindow
          window.ts               # window creation/options
          ipc/
            index.ts              # register all handlers
            chat.ts               # chat/session/message handlers
            provider.ts           # model/provider + key metadata
            workspace.ts          # open/read/list workspace files
            settings.ts           # user settings
          services/
            db.ts                 # sqlite connection + pragmas
            keychain.ts           # keytar wrapper
            providers/
              openai.ts           # provider client adapter
              anthropic.ts        # optional future
            usage.ts              # token/cost accounting
          jobs/
            scheduler.ts          # background task coordinator
          util/
            logger.ts
            paths.ts

        preload/
          index.ts                # contextBridge surface
          types.ts                # IPC request/response contracts

        renderer/
          main.tsx
          app/
            App.tsx
            routes.tsx
          features/
            chat/
              ChatView.tsx
              Composer.tsx
              MessageList.tsx
              chat.store.ts
            providers/
              ProviderSettings.tsx
            workspaces/
              WorkspacePicker.tsx
            settings/
              SettingsView.tsx
          shared/
            api/client.ts          # preload bridge wrapper
            ui/
            styles/
              tokens.css           # theme vars
              global.css

  packages/
    shared/
      src/
        contracts/
          ipc.ts                  # shared zod schemas/types
          domain.ts               # shared DTOs
      package.json

  db/
    drizzle.config.ts
    migrations/
    schema/
      index.ts
      tables/
        sessions.ts
        messages.ts
        providers.ts
        model_profiles.ts
        workspace_projects.ts
        app_settings.ts
        usage_events.ts
        background_jobs.ts

  docs/
    OPENVIBEZ_V1_SPEC.md
```

## 5) SQLite Schema (Drizzle)

### 5.1 `providers`
Stores provider account metadata, never raw secrets.
- `id` TEXT PK (`prov_xxx`)
- `type` TEXT NOT NULL (`openai`, `anthropic`, `local`)
- `display_name` TEXT NOT NULL
- `auth_kind` TEXT NOT NULL (`api_key`, `oauth_subscription`)
- `keychain_ref` TEXT NULL (reference label used by keychain wrapper)
- `is_active` INTEGER NOT NULL DEFAULT 1
- `created_at` INTEGER NOT NULL
- `updated_at` INTEGER NOT NULL
- `last_used_at` INTEGER NULL

Indexes:
- `idx_providers_type`
- `idx_providers_active`

### 5.2 `model_profiles`
Model defaults + generation behavior presets.
- `id` TEXT PK (`model_xxx`)
- `provider_id` TEXT NOT NULL FK -> `providers.id`
- `model_id` TEXT NOT NULL (e.g. `gpt-5-codex`)
- `label` TEXT NOT NULL
- `temperature` REAL NULL
- `top_p` REAL NULL
- `max_output_tokens` INTEGER NULL
- `is_default` INTEGER NOT NULL DEFAULT 0
- `created_at` INTEGER NOT NULL
- `updated_at` INTEGER NOT NULL

Indexes:
- `idx_model_profiles_provider`
- unique (`provider_id`, `model_id`)

### 5.3 `workspace_projects`
Known user workspaces.
- `id` TEXT PK (`ws_xxx`)
- `name` TEXT NOT NULL
- `root_path` TEXT NOT NULL UNIQUE
- `trust_level` TEXT NOT NULL (`trusted`, `read_only`, `untrusted`)
- `created_at` INTEGER NOT NULL
- `updated_at` INTEGER NOT NULL
- `last_opened_at` INTEGER NULL

### 5.4 `sessions`
Top-level conversations/tasks.
- `id` TEXT PK (`sess_xxx`)
- `workspace_id` TEXT NULL FK -> `workspace_projects.id`
- `title` TEXT NOT NULL
- `provider_id` TEXT NOT NULL FK -> `providers.id`
- `model_profile_id` TEXT NULL FK -> `model_profiles.id`
- `status` TEXT NOT NULL (`active`, `archived`, `error`)
- `created_at` INTEGER NOT NULL
- `updated_at` INTEGER NOT NULL
- `last_message_at` INTEGER NULL

Indexes:
- `idx_sessions_workspace`
- `idx_sessions_last_message_at`
- `idx_sessions_status`

### 5.5 `messages`
All message events in a session.
- `id` TEXT PK (`msg_xxx`)
- `session_id` TEXT NOT NULL FK -> `sessions.id`
- `role` TEXT NOT NULL (`system`, `user`, `assistant`, `tool`)
- `content` TEXT NOT NULL (markdown/text)
- `content_format` TEXT NOT NULL DEFAULT `markdown`
- `tool_name` TEXT NULL
- `tool_call_id` TEXT NULL
- `seq` INTEGER NOT NULL
- `input_tokens` INTEGER NULL
- `output_tokens` INTEGER NULL
- `cost_microunits` INTEGER NULL
- `created_at` INTEGER NOT NULL

Indexes:
- unique (`session_id`, `seq`)
- `idx_messages_session_created`

### 5.6 `usage_events`
Usage telemetry for local analytics/cost dashboard.
- `id` TEXT PK (`use_xxx`)
- `provider_id` TEXT NOT NULL FK -> `providers.id`
- `session_id` TEXT NULL FK -> `sessions.id`
- `message_id` TEXT NULL FK -> `messages.id`
- `event_type` TEXT NOT NULL (`completion`, `embedding`, `tool`)
- `input_tokens` INTEGER NOT NULL DEFAULT 0
- `output_tokens` INTEGER NOT NULL DEFAULT 0
- `cost_microunits` INTEGER NOT NULL DEFAULT 0
- `created_at` INTEGER NOT NULL

Indexes:
- `idx_usage_provider_created`
- `idx_usage_session_created`

### 5.7 `app_settings`
Simple typed settings KV store.
- `key` TEXT PK
- `value_json` TEXT NOT NULL
- `updated_at` INTEGER NOT NULL

Recommended keys:
- `theme`
- `default_workspace_id`
- `default_provider_id`
- `default_model_profile_id`
- `editor_font_size`
- `telemetry_enabled`

### 5.8 `background_jobs`
Track durable jobs if app closes mid-task.
- `id` TEXT PK (`job_xxx`)
- `kind` TEXT NOT NULL (`workspace_index`, `sync`, `cleanup`)
- `state` TEXT NOT NULL (`queued`, `running`, `done`, `failed`)
- `payload_json` TEXT NOT NULL
- `attempt_count` INTEGER NOT NULL DEFAULT 0
- `last_error` TEXT NULL
- `created_at` INTEGER NOT NULL
- `updated_at` INTEGER NOT NULL

Indexes:
- `idx_jobs_state_kind`

## 6) Keychain Strategy
Use `keytar` service name: `OpenVibez`.
- account name pattern: `<providerId>:<authKind>`
- secret value: API key or OAuth refresh token

DB relation model:
- `providers.keychain_ref` stores account string
- on delete provider:
  1. remove key from keychain
  2. soft-disable provider row (or hard delete if no references)

## 7) IPC Contract (Typed)

Expose only explicit methods from preload:
- `provider.list()`
- `provider.create(metadata)`
- `provider.saveSecret(providerId, secret)`
- `provider.testConnection(providerId)`
- `session.create(input)`
- `session.list(filter)`
- `session.archive(sessionId)`
- `message.send(sessionId, content)`
- `message.list(sessionId)`
- `workspace.add(path)`
- `workspace.list()`
- `settings.get(key)`
- `settings.set(key, value)`
- `usage.summary(range)`

Every request/response validated with shared Zod schemas.

## 8) Initial Migration Order
1. `providers`
2. `model_profiles`
3. `workspace_projects`
4. `sessions`
5. `messages`
6. `usage_events`
7. `app_settings`
8. `background_jobs`

## 9) v1 Milestones

### Milestone A: Foundation
- Electron + Vite + React + TS bootstrap
- strict security flags + preload bridge
- logging + error boundaries
- drizzle + sqlite wired
- first migration pipeline works

### Milestone B: Provider/Auth
- provider CRUD metadata
- keychain save/get/delete
- test provider connection
- set default provider/model

### Milestone C: Chat Core
- session list/create/archive
- send/receive messages
- persist sequence + token usage
- restart app and fully restore session history

### Milestone D: Workspace Awareness
- add trusted workspace
- attach workspace context metadata to session
- safe file listing/read with trust rules

### Milestone E: Usage + Polish
- local usage dashboard
- background jobs table for resumable tasks
- packaging/signing/distribution pipeline

## 10) Operational Defaults
- SQLite path:
  - macOS: `~/Library/Application Support/OpenVibez/openvibez.db`
  - Windows/Linux equivalent app-data path via Electron `app.getPath('userData')`
- SQLite pragmas:
  - `journal_mode = WAL`
  - `foreign_keys = ON`
  - `synchronous = NORMAL`
- backups:
  - periodic copy on app close/startup for last known-good state (optional in v1.1)

## 11) Recommended npm Packages (v1)
- Core:
  - `electron`, `react`, `react-dom`, `vite`, `typescript`
- Desktop:
  - `electron-builder`, `electron-log`, `keytar`
- DB:
  - `better-sqlite3`, `drizzle-orm`, `drizzle-kit`
- Validation/State:
  - `zod`, `zustand`, `@tanstack/react-query`
- Utilities:
  - `nanoid`, `date-fns`

## 12) Future Extensions (v1.1+)
- optional cloud sync (encrypted)
- extension/tool marketplace
- multi-provider routing policies
- prompt templates and reusable workflows
- local embeddings/vector search for workspace recall

---

This spec keeps OpenVibez local-first, secure, and fast while still giving enough structure to scale past v1 without a rewrite.
