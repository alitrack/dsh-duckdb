# dsh-duckdb

English | [简体中文](README.zh.md)

Query local data files with SQL from inside [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) — no Python, no external service, no network.

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![dsh](https://img.shields.io/badge/dsh-0.2.1--rc.2-4d6bfe)](https://github.com/deepseek-ai/deepseek-harness)
[![duckdb](https://img.shields.io/badge/duckdb-tested%20v2.0.0--alpha39998-fff000)](https://duckdb.org)

## What it does

`dsh-duckdb` registers two model-facing tools over the Cordis `ctx.tools` registry:

| Tool | Purpose |
|---|---|
| `duckdb_query` | Run **one** SQL statement against local data files through the DuckDB engine |
| `duckdb_schema` | Describe a file's columns, types, nullability, sample rows and approximate row count before querying it |

Attach files with the `files` argument; each becomes a view named `f0`, `f1`, ... in the order given. Supported inputs: `.csv` `.tsv` `.parquet` `.json` `.jsonl` `.ndjson` `.duckdb`.

## Why it exists

The DSH plugin ecosystem (854 public repositories as of 2026-10-29) has **no native DuckDB tool**. The only comparable project, `Kaalia0912/dsh-data-analysis-mode` (2 stars), wires DuckDB in as an external Python MCP server (`mcp-server-duckdb==1.1.0`, pinned to `mcp<2`) plus a Windows-oriented installer. `dsh-duckdb` is a zero-dependency Cordis plugin that runs the local `duckdb` binary directly.

## Install

```bash
dsh plugin --profile web add dsh-duckdb
```

Or from GitHub:

```bash
dsh plugin --profile web add github:alitrack/dsh-duckdb
```

Requires `duckdb` on `PATH` (any recent build). Override the binary with the `DSH_DUCKDB_BIN` environment variable.

### Local development (no pnpm needed)

```bash
# from the dsh source checkout or a profile directory
npx @deepseek-ai/dsh --patch ./local-overlay.yml "your task"
```

```yaml
# local-overlay.yml
- insert:
    - id: dsh-duckdb
      name: '/absolute/path/to/dsh-duckdb/index.js'
```

> **Version gate.** dsh refuses to load a plugin whose `peerDependencies` do not match the runtime. This plugin declares `@deepseek-ai/dsh-tools: ^0.0.1-rc.1` and is tested against dsh `0.2.1-rc.2`. If you run a newer dsh and the loader disables the plugin, either pin dsh to the tested version or grant an exact-version exemption with `dsh plugin allow-version`.

## Security model

Everything runs locally; the plugin itself holds no credentials and opens no network connection. The model's SQL is untrusted input, so:

- **Workspace confinement.** Every file path must be absolute and resolve inside the calling session's workspace (`exec.agent.session.header.cwd`). `..` traversal, symlinks pointing outside, absolute paths outside the root, directories and missing files are all rejected with a distinct error code.
- **Read-only by default.** Only `SELECT` / `WITH` / `VALUES` / `FROM` / `DESCRIBE` / `SHOW` / `SUMMARIZE` / `EXPLAIN` / `PRAGMA` are accepted. Writes require an explicit `read_only: false`.
- **Always blocked, even in write mode.** `COPY`, `ATTACH`, `DETACH`, `INSTALL`, `LOAD`, `SET`, `RESET`, `CALL`, `CHECKPOINT`, `EXPORT`, `IMPORT` — statements that can reach outside the process. A `COPY ... TO '/tmp/x.parquet'` that survives the guard would write a real file (verified on duckdb v2.0.0-alpha39998: an in-memory database cannot be opened `-readonly`, and `COPY` succeeds in that mode).
- **Row cap.** Results are truncated at `max_rows` (default 200, hard cap 1000) and report the true `row_count`, so a large result set never floods the model's context.
- **One statement per call.** Statement batches are rejected. The CLI runs each statement separately and prints one JSON array per statement, which cannot be attributed to a single result; and a batch would let a write slip past a read-only check on the first statement.
- **Timeout.** Each call is bounded at 30 s; the child process is killed on expiry or on caller cancellation (`exec.signal`).

## Usage

```
You: Look at /workspace/sales.csv and total the amount by city.

Agent: [duckdb_schema target=/workspace/sales.csv]
       columns: city VARCHAR, amount BIGINT
       approx rows: 3

       [duckdb_query sql="SELECT city, sum(amount) AS total FROM f0 GROUP BY city ORDER BY city"
        files=["/workspace/sales.csv"]]
       BJ | 300
       HZ | 100
       SH | 200
```

### Tool reference

**`duckdb_query`**

| Arg | Type | Notes |
|---|---|---|
| `sql` | string (required) | One statement. Reference attached files as `f0`, `f1`, ... |
| `files` | array of strings | Absolute workspace paths, attached as views in order |
| `max_rows` | integer | Row cap. Default 200, hard cap 1000 |
| `read_only` | boolean | Default `true` |

**`duckdb_schema`**

| Arg | Type | Notes |
|---|---|---|
| `target` | string (required) | Absolute file path, or an attached view name |
| `sample_rows` | integer | Default 5, hard cap 50 |

## Development

```bash
node --test                    # 59 unit tests
node tests/e2e/keyless.mjs     # 10 key-free e2e checks against the real duckdb CLI
bash tests/e2e/run_e2e.sh      # full headless e2e, no API key needed
```

The key-free harness drives the plugin's Cordis contract directly (fake `ctx` + fake `exec`) and needs no model or API key.

The headless run needs no API key either: `tests/e2e/run_e2e.sh` points dsh at a local OpenAI-compatible endpoint through the `llm-pi-ai` adapter. To retarget it at your own model, edit `tests/e2e/local-model-overlay.yml`. Two things to know:

- **`llm-deepseek` will not work for a local server** — that adapter only speaks the Anthropic Messages protocol. `DEEPSEEK_BASE_URL` moves the endpoint but not the protocol.
- **The version gate is not a CLI command.** dsh's error message points you at `dsh plugin allow-version`, which does not exist; it falls through to pnpm and fails. The real mechanism is a profile-local `compatibility.json` mapping exact `name@version` to exact dsh versions. `run_e2e.sh` writes it automatically.

### Verified duckdb CLI behaviour

Behaviour that shaped the implementation, all verified on `v2.0.0-alpha39998`:

- `-readonly` **cannot** be used with an in-memory database (`Cannot launch in-memory database in read-only mode!`), so read-only enforcement lives in the statement guard, not a CLI flag.
- `COPY (SELECT 1) TO '/tmp/x.parquet'` **succeeds** on an in-memory database and really writes the file.
- `-json -c` prints one JSON array per statement, pretty-printed.
- `sum()` over BIGINT returns **HUGEINT**, which `-json` renders as a *string* (`"300"`). `DECIMAL` does the same. Both are coerced back to JSON numbers from the column types; a `VARCHAR` holding digits is deliberately **not** coerced.
- Wrapping a DDL statement in a SELECT wrapper is a parser error, so non-query statements run verbatim.

## License

MIT
