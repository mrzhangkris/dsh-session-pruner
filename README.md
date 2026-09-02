# dsh-session-pruner

**DSH session lifecycle management plugin** — full-type session lifecycle management: one-shot subagents archived on completion, continuable subagents and main sessions archived when idle, a capacity cap, and projection-cache cleanup. Prevents session-library accumulation stalls at the source.

> Every session type has a defined destination: finished one-shot subagents are archived automatically, idle continuable subagents / main sessions are archived, and overflow is recycled by priority. **Archive first (recoverable), delete after expiry** — the GUI syncs within 30s, fully panel-configured with hot reload.

[简体中文](README.zh-CN.md) · [Apache-2.0](LICENSE) · [npm](https://www.npmjs.com/package/dsh-session-pruner)

## Why

DSH (DeepSeek Harness) caches a full projection of every session in `session_projcache.json` (token stats, context pressure, ...), and the storage backend rewrites the whole file atomically on **every** write. When the session library accumulates thousands of subagent sessions:

- The cache balloons past 100MB and each checkpoint fully re-serializes → main process CPU 250%+
- The single-threaded event loop is saturated → **every session load stalls, even `GET /` times out**

Managing session lifecycle (this plugin) is the root fix: no session accumulation → no cache rows → no stalls.

## Features: full-type lifecycle

| Session type | Trigger | Action | Default |
|---|---|---|---|
| **one-shot subagent** | `subagent/end` / `agent/disposed` event (+ grace) | archive within seconds (event-driven) | event + 3min grace |
| **continuable subagent** | idle over N days | archive (recoverable) | off (0 days) |
| **main session** | idle over N days | archive (recoverable) | off (0 days) |
| **any type** | total exceeds capacity cap | recycle by `one-shot → continuable → main` + oldest | 400 |
| **archive directory** | kept over N hours | physically deleted | 24 hours |

> **行为说明（v0.3+）**：one-shot 子代理统一按 `oneShotMinAgeMinutes`（默认 3 分钟）闲置阈值归档，有/无 end-seed 阈值一致。早期版本中「未写 end-seed 的 one-shot 需闲置满 1 小时才归档」的兜底已移除。

### Archive mechanism (recoverable)

Cleaned sessions are **moved to `~/.dsh/sessions-archive/`** first (workspace/session-id structure preserved) — they disappear from the GUI immediately (the list only reads the sessions directory), but the files remain and can be restored manually:

```sh
# Restore: mv back into the sessions directory
mv ~/.dsh/sessions-archive/<workspace>/<session-id> ~/.dsh/sessions/<workspace>/
```

A "delete directly" mode (no archive, irreversible) is also available.

### Safety (double protection)

- **Running sessions are never touched**: live sessions (still held in the in-memory session store, open/loading) are skipped — and the live check is **fail-closed**: a store query error treats the session as live, never deleting on uncertainty
- **Idle = last log write**: idle is judged by the session log file mtime (last write time), not the directory mtime — DSH appends to `session.jsonl.zstd`, so active sessions keep refreshing their mtime and are never misjudged idle
- **one-shot**: finished one-shot subagents are archived uniformly by the `oneShotMinAgeMinutes` idle threshold (with or without end-seed, same threshold); the capacity cap additionally skips sessions lacking `session/end-seed`
- Main sessions do not participate in capacity recycling by default (configurable)
- Per-action failure isolation: every action is try/catch wrapped

## How it works

```
Dual-track triggers (events = hot path, disk = source of truth)
  ┌─ Event-driven (seconds): subagent/end + agent/disposed
  │     ├─ 500ms batch window merges storms → oneShotMinAge grace re-check
  │     └─ single-session check (memory-first, at most one zstd decompress) → archive
  └─ Scheduled reconcile (fallback, default 60min)
        ├─ pruneArchive: physically delete expired archive sessions
        ├─ iterate ~/.dsh/sessions/*/ decompress log (system zstd, multi-frame)
        │     ├─ origin: main | subagent       (session header)
        │     ├─ mode: one-shot | continuable  (subagent/descriptor event)
        │     └─ ended: contains session/end-seed
        ├─ one-shot + ended ──→ archive (archiveMode)
        ├─ continuable/main idle N days ──→ archive
        ├─ total > cap ──→ recycle by priority + oldest (skip running/live)
        └─ each archive also: purge projcache row + workspace accounting
```

GUI sync — change-driven primary, full-refresh fallback:
- **dirty-flag (primary)**: host keeps an in-memory monotonic archive log; the
  client polls `/plugins/dsh-session-pruner/archived` every 3s and only issues
  `refreshList()` + `refreshSubagents()` when a change is reported — sidebar and
  task panel stay consistent within seconds, zero RPC when nothing changed.
- **Full fallback**: every `uiRefreshSeconds` seconds the client refreshes both
  data sources anyway (main list via `refreshList()`, each known parent's
  subagent catalog via `refreshSubagents()`), covering dirty-flag failures
  (older host / route unavailable). No page reload needed.

## Install

### From npm (recommended)

```sh
dsh plugin --profile web add dsh-session-pruner
```

### From source (development)

```sh
dsh plugin --profile web add /path/to/dsh-session-pruner
```

Restart dsh web after install (`launchctl kickstart -k gui/$(id -u)/com.deepseek.dsh-web`).

## Configuration (settings panel, hot reload)

After install, open **Settings → Plugins → 会话生命周期管理** card. All 9 options save with hot reload (no restart):

| Field | Default | Description |
|---|---|---|
| Scan interval (min) | 60 | reconcile fallback (events are primary) |
| Capacity cap (sessions) | 400 | recycle by priority + oldest when exceeded |
| UI fallback refresh interval (s) | 30 | dirty-flag primary (3s change poll); full refresh fallback |
| Archive retention (hours) | 24 | physical delete after retention |
| Archive mode | archive | archive (recoverable) / delete directly (irreversible) |
| Continuable idle archive (days) | 0 | archive after N idle days, 0 = off |
| Main idle archive (days) | 0 | archive after N idle days, 0 = off |
| Clean main on overflow | off | main participates in capacity recycling |
| One-shot min survival (min) | 3 | newly finished subagents are not cleaned within N minutes (protects finishing/references) |

Env vars (fallback, panel wins): `DSH_SESSION_PRUNER_INTERVAL_MS` / `_MAX` / `_CLEAN_MAIN` / `_ARCHIVE_HOURS` / `_ARCHIVE_MODE` / `_CONTINUABLE_IDLE_DAYS` / `_MAIN_IDLE_DAYS` / `_ONE_SHOT_MIN_AGE_MINUTES`.

## Logs

Output in guard `server-*.out.log`:

```
[dsh-session-pruner] armed: interval=60min cap=400 cleanMain=false
[dsh-session-pruner] hot-reloaded: interval=60min cap=400 ... contIdle=0d mainIdle=0d
[dsh-session-pruner] archived a1b2c3d4 (subagent/one-shot) one-shot idle cache=true
[dsh-session-pruner] archive pruned: 2 expired
```

`cache=true/false` tells whether the projection cache row was purged along with the session.

## Tests

```sh
node test/dry-run.js   # read-only full-library scan, verify classification (no deletion)
node test/e2e.js       # create a fake one-shot session, verify the real cleanup path
```

## Implementation notes

- **Multi-frame zstd**: DSH session logs are concatenated zstd frames (append writes); Node `zlib` decodes a single frame only, so the plugin shells out to the system `zstd` CLI (`brew install zstd` on macOS)
- **Cache row purge**: `storageDomain.get('session_projcache').table('sessions').delete(id)` — the official write chain (atomic persistence + in-memory sync)
- **Workspace accounting**: the session id is removed from the workspace domain on archive, keeping the data source consistent with disk
- **Zero npm deps**: plain Node built-ins + cordis runtime injection
- **Panel + hot reload**: `installSettingsSection` + hand-written client card (`__ModuleLoader__` bundle), `onChange` re-schedules the timer instantly

## Developer guide

[`docs/DEVELOPMENT-GUIDE.md`](docs/DEVELOPMENT-GUIDE.md) — DSH plugin development practice guide (architecture, Host/Client, settings panel, deployment ops, 10 pitfalls with fixes), the foundation for future plugin work.

## Known limits

- A finished one-shot subagent survives at most one scan interval
- Requires the system `zstd` CLI
- The root fix lives upstream: projcache stale-session eviction / incremental storage writes, see [deepseek-harness Discussion #1550](https://github.com/deepseek-ai/deepseek-harness/discussions/1550)

## License

[Apache-2.0](LICENSE)
