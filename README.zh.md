# dsh-duckdb

[English](README.md) | 简体中文

在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）里用 SQL 查本地数据文件——不需要 Python、不需要外部服务、不联网。

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![dsh](https://img.shields.io/badge/dsh-0.2.1--rc.2-4d6bfe)](https://github.com/deepseek-ai/deepseek-harness)
[![duckdb](https://img.shields.io/badge/duckdb-%E5%AE%9E%E6%B5%8B%20v2.0.0--alpha39998-fff000)](https://duckdb.org)

## 它做什么

`dsh-duckdb` 是一个 Cordis 插件，往 `ctx.tools` 注册两个面向模型的工具：

| 工具 | 用途 |
|---|---|
| `duckdb_query` | 对本地数据文件跑**一条** SQL 语句（DuckDB 引擎） |
| `duckdb_schema` | 查询前先看文件的列名、类型、可空性、样例行和近似行数 |

用 `files` 参数挂文件，每个文件按顺序成为视图 `f0`、`f1`……支持 `.csv` `.tsv` `.parquet` `.json` `.jsonl` `.ndjson` `.duckdb`。

## 为什么做它

截至 2026-10-29，DSH 插件生态（854 个公开仓库）里**没有原生 DuckDB 工具**。唯一相近的项目 `Kaalia0912/dsh-data-analysis-mode`（2★）走的是「外部 Python MCP 服务器」路线（`mcp-server-duckdb==1.1.0`，钉死 `mcp<2`，安装脚本面向 Windows）。`dsh-duckdb` 是零依赖 Cordis 插件，直接跑本机 `duckdb` 可执行文件。

## 安装

```bash
dsh plugin --profile web add dsh-duckdb
```

或从 GitHub：

```bash
dsh plugin --profile web add github:alitrack/dsh-duckdb
```

需要 `PATH` 上有 `duckdb`（任意较新版本）。可用 `DSH_DUCKDB_BIN` 环境变量指定其他可执行文件。

### 本地开发（不需要 pnpm）

```bash
npx @deepseek-ai/dsh --patch ./local-overlay.yml "你的任务"
```

```yaml
# local-overlay.yml
- insert:
    - id: dsh-duckdb
      name: '/绝对路径/dsh-duckdb/index.js'
```

> **版本兼容门**：dsh 会校验插件的 `peerDependencies` 与运行时是否匹配，不匹配就拒绝加载。本插件声明 `@deepseek-ai/dsh-tools: ^0.0.1-rc.1`，实测基线是 dsh `0.2.1-rc.2`。如果你跑的 dsh 更新导致插件被禁用，要么把 dsh 钉到实测版本，要么用 `dsh plugin allow-version` 授予精确版本豁免。

## 安全模型

一切在本机执行，插件本身不持有任何凭据、不开任何网络连接。模型生成的 SQL 是不可信输入，因此：

- **工作区禁锢**：每个文件路径必须是绝对路径，且解析后落在调用会话的工作区内（`exec.agent.session.header.cwd`）。`..` 穿越、指向外部的符号链接、根外绝对路径、目录、不存在的文件，全部按不同错误码拒绝。
- **默认只读**：只接受 `SELECT` / `WITH` / `VALUES` / `FROM` / `DESCRIBE` / `SHOW` / `SUMMARIZE` / `EXPLAIN` / `PRAGMA`。写入必须显式 `read_only: false`。
- **写模式下也永久阻断**：`COPY`、`ATTACH`、`DETACH`、`INSTALL`、`LOAD`、`SET`、`RESET`、`CALL`、`CHECKPOINT`、`EXPORT`、`IMPORT`——这些语句能摸到进程外面。一个漏过闸门的 `COPY ... TO '/tmp/x.parquet'` 会真的写文件（已在 duckdb v2.0.0-alpha39998 实测：内存库不能用 `-readonly` 打开，且该模式下 `COPY` 会成功）。
- **行数上限**：结果按 `max_rows` 截断（默认 200，硬顶 1000），同时返回真实 `row_count`，大结果集不会灌进模型上下文。
- **一次一条语句**：拒绝语句批次。CLI 对每条语句各打印一个 JSON 数组，无法归属到单一结果；而且批次会让写入顺着第一条只读语句混过去。
- **超时**：每次调用上限 30 秒，超时或调用方取消（`exec.signal`）即杀子进程。

## 用法

```
你：看看 /workspace/sales.csv，按城市汇总金额。

Agent：[duckdb_schema target=/workspace/sales.csv]
       columns: city VARCHAR, amount BIGINT
       approx rows: 3

       [duckdb_query sql="SELECT city, sum(amount) AS total FROM f0 GROUP BY city ORDER BY city"
        files=["/workspace/sales.csv"]]
       BJ | 300
       HZ | 100
       SH | 200
```

### 工具参数

**`duckdb_query`**

| 参数 | 类型 | 说明 |
|---|---|---|
| `sql` | string（必填） | 一条语句。挂进来的文件用 `f0`、`f1`……引用 |
| `files` | string 数组 | 工作区内绝对路径，按顺序挂成视图 |
| `max_rows` | integer | 行数上限，默认 200，硬顶 1000 |
| `read_only` | boolean | 默认 `true` |

**`duckdb_schema`**

| 参数 | 类型 | 说明 |
|---|---|---|
| `target` | string（必填） | 文件绝对路径，或已挂视图名 |
| `sample_rows` | integer | 默认 5，硬顶 50 |

## 开发

```bash
node --test                    # 59 条单测
node tests/e2e/keyless.mjs     # 10 条免 key e2e（真跑 duckdb CLI）
bash tests/e2e/run_e2e.sh      # 完整 headless e2e，同样不需要 API key
```

免 key 的 e2e harness 直接驱插件的 Cordis 契约（假 `ctx` + 假 `exec`），不需要模型和 API key。

完整 headless e2e 也不需要 key：`tests/e2e/run_e2e.sh` 通过 `llm-pi-ai` 适配器把 dsh 指向本地 OpenAI 兼容端点。要换成你自己的模型，改 `tests/e2e/local-model-overlay.yml`。两点注意：

- **本地服务器不能走 `llm-deepseek`**——那个适配器只说 Anthropic Messages 协议。`DEEPSEEK_BASE_URL` 只能挪端点，改不了协议。
- **版本兼容门不是 CLI 命令**。dsh 的报错让你跑 `dsh plugin allow-version`，但那命令不存在，会 fallthrough 到 pnpm 然后失败。真机制是 profile 本地的 `compatibility.json`，把精确 `name@version` 映射到精确 dsh 版本。`run_e2e.sh` 会自动写它。

### 已实测的 duckdb CLI 行为

以下行为都已在 `v2.0.0-alpha39998` 上验证，并直接塑造了实现：

- `-readonly` **不能**用于内存库（报 `Cannot launch in-memory database in read-only mode!`），所以只读 enforcement 放在语句闸门里，不靠 CLI flag。
- 内存库上 `COPY (SELECT 1) TO '/tmp/x.parquet'` **会成功**并真的写出文件。
- `-json -c` 对每条语句打印一个 JSON 数组，且是美化过的多行格式。
- `sum()` 对 BIGINT 求和返回 **HUGEINT**，`-json` 把它渲染成**字符串**（`"300"`）；`DECIMAL` 同理。两者都按列类型回转成 JSON 数字；而 `VARCHAR` 里的数字（邮编、电话号）**故意不转**。
- 把 DDL 语句包进 SELECT 包装器会报 parser error，所以非查询语句原样执行。

## License

MIT
