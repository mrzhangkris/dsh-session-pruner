# dsh-session-lifecycle

**DSH session lifecycle management plugin** — prevent `session_projcache` cache bloat and Web stalls caused by session accumulation, at the source.

> Subagent sessions are kept on demand: one-shot subagents are auto-cleaned after completion, continuable subagents and main sessions are kept, and a capacity cap recycles the oldest when the total exceeds the limit. Every deleted session also purges its projection cache row, keeping the cache permanently small.

[English](README.en.md) · [Apache-2.0](LICENSE)

## Why

DSH (DeepSeek Harness) caches a full projection of every session in `session_projcache.json` (token stats, context pressure, ...), and the storage backend rewrites the whole file atomically on **every** write. When the session library accumulates thousands of subagent sessions:

- The cache balloons past 100MB and each checkpoint fully re-serializes → main process CPU 250%+
- The single-threaded event loop is saturated → **every session load stalls, even `GET /` times out**

Cleaning the session library (this plugin) is the root fix: no session accumulation → no cache rows → no stalls.

## Features

| Strategy | Behavior | Default |
|---|---|---|
| **one-shot auto-clean** | Subagents with `mode=one-shot` are deleted at the next scan once their log contains `session/end-seed` | 30min interval |
| **Capacity cap** | When total sessions exceed the cap, recycle by priority `one-shot → continuable → main` then by last-activity (oldest first) | 400 |
| **Cache row purge** | Deleting a session also deletes its `session_projcache` row via the storageDomain write chain (atomic, durable) | on |

### Safety

- **Running sessions are never touched**: only logs containing `session/end-seed` (finished) are deleted
- **Main sessions are never auto-deleted** unless `CLEAN_MAIN=1` and the cap is exceeded
- **Per-delete isolation**: every removal is try/catch wrapped; a failure logs and does not block the rest
- Continuable subagents and main sessions are kept long-term, recycled only by the cap (oldest first)

## How it works

```
scan (scheduled)
  └─ iterate ~/.dsh/sessions/*/ decompress log (zstd)
      ├─ origin: main | subagent      (session header)
      ├─ mode: one-shot | continuable (subagent/descriptor event)
      └─ ended: contains session/end-seed
          │
          ├─ one-shot + ended  ──→ delete session dir + purge cache row
          └─ total > cap        ──→ recycle by priority + oldest (skip running)
```

## Install

```sh
dsh plugin --profile web add <repo-path-or-url>
# restart dsh web to load
```

## Configuration (env vars)

| Variable | Default | Description |
|---|---|---|
| `DSH_SESSION_LIFECYCLE_INTERVAL_MS` | `1800000` (30min) | scan interval |
| `DSH_SESSION_LIFECYCLE_MAX` | `400` | session count cap |
| `DSH_SESSION_LIFECYCLE_CLEAN_MAIN` | `0` | allow cleaning main sessions when over cap (`1` to enable) |

On macOS + launchd, add the vars to `EnvironmentVariables` in `~/Library/LaunchAgents/com.deepseek.dsh-web.plist`, then:

```sh
launchctl kickstart -k gui/$(id -u)/com.deepseek.dsh-web
```

## Logs

The first scan runs 5s after startup, then on the interval (output in guard `server-*.out.log`):

```
[session-lifecycle] armed: interval=0.5h cap=400 cleanMain=false
[session-lifecycle] removed 1a2b3c4d5e6f (subagent/one-shot) one-shot done cache=true
[session-lifecycle] scan done: 158 total, removed 0
```

`cache=true/false` tells whether the projection cache row was also purged.

## Tests

```sh
node test/dry-run.js   # read-only scan of the whole library, verify classification (no deletion)
node test/e2e.js       # create a fake one-shot session, verify the real cleanup path
```

## Implementation notes

- **Multi-frame zstd**: DSH session logs are concatenated zstd frames (append writes); Node `zlib` decodes a single frame only, so the plugin shells out to the system `zstd` CLI (`brew install zstd` on macOS)
- **Cache row purge**: `ctx.storageDomain.get('session_projcache').tables.sessions.delete(id)` — the official write chain (atomic persistence + in-memory sync); if the handle is unavailable it skips with a warning and does not block session deletion
- **Zero runtime deps**: plain Node built-ins + cordis (`timer` / `storageDomain` injection)

## Known limits

- A finished one-shot subagent survives at most one scan interval (default 30min)
- Requires the system `zstd` CLI (install per platform)
- The root fix lives upstream: projcache stale-session eviction / incremental storage writes, see [deepseek-harness Discussion #1550](https://github.com/deepseek-ai/deepseek-harness/discussions/1550)

## License

[Apache-2.0](LICENSE)
