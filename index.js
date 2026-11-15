/**
 * dsh-duckdb — query local data files with SQL from inside DeepSeek Harness.
 *
 * Cordis plugin. Registers two model-facing tools over the `ctx.tools`
 * registry:
 *
 *   duckdb_query  - run one SQL statement against attached data files
 *   duckdb_schema - describe a file's columns before querying it
 *
 * Everything is local: no Python, no external service, no network. The
 * workspace root comes from the calling agent's session cwd
 * (`exec.agent.session.header.cwd`), exactly like the first-party bash tool.
 */

import { statSync } from 'node:fs'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { validateWorkspaceFile } from './lib/paths.js'
import { checkStatement, assertSingleStatement } from './lib/guard.js'
import { clampMaxRows, projectRows } from './lib/rows.js'
import { runQuery, readerFor, DUCKDB_BIN_ENV } from './lib/cli.js'
import { Catalog } from './lib/catalog.js'
import { validateConversion, buildConvertStatement } from './lib/convert.js'

const name = 'dsh-duckdb'
const inject = ['tools', 'systemPrompt']

/** Default per-call timeout. Must be cooperative: the CLI is killed on it. */
const DEFAULT_TIMEOUT_MS = 30000

/** Extensions the schema/query tools know how to LOAD when asked. */
const KNOWN_EXTENSIONS = ['luajit']

function sessionWorkspace(exec) {
  const header = exec.agent?.session?.header
  const cwd = header?.cwd
  return typeof cwd === 'string' && cwd.length > 0 ? cwd : process.cwd()
}

/**
 * Resolve every model-supplied file against the session workspace.
 * All-or-nothing: one bad path fails the whole call, so the model never gets a
 * partial view set it might reason about incorrectly.
 */
function resolveFiles(files, root) {
  if (files === undefined || files === null) return { ok: true, files: [] }
  if (!Array.isArray(files)) {
    return { ok: false, code: 'BAD_FILES', detail: 'files must be an array of absolute paths' }
  }
  const resolved = []
  for (const file of files) {
    const verdict = validateWorkspaceFile(file, root)
    if (!verdict.ok) {
      return { ok: false, code: verdict.code, detail: verdict.detail }
    }
    resolved.push(verdict.path)
  }
  return { ok: true, files: resolved }
}

/** Shared failure shape: a structured error object, never a thrown crash. */
function failure(code, detail, extra = {}) {
  return { ok: false, error: { code, detail, ...extra } }
}

export function apply(ctx) {
  const binary = process.env[DUCKDB_BIN_ENV]
  const catalog = new Catalog()

  ctx.systemPrompt.section({
    name: 'tool:duckdb',
    order: 106,
    text:
      'duckdb_query and duckdb_schema run SQL against local data files (CSV/Parquet/JSON) ' +
      'through the DuckDB engine. Files must be absolute paths inside the workspace; they are ' +
      'attached as views f0, f1, ... in the order given. Call duckdb_schema first when a file is ' +
      'unfamiliar. Results are capped — a truncated result reports row_count and truncated=true, ' +
      'so refine the query instead of asking for more rows. Writes are rejected unless the call ' +
      'sets read_only=false. ' +
      'For datasets reused across calls, attach them once with duckdb_attach (an alias, then query ' +
      'it as a table); duckdb_catalog lists attached aliases. duckdb_convert writes a workspace file ' +
      'in parquet/csv/json/duckdb format.',
  })

  ctx.tools.register(defineTool({
    name: 'duckdb_query',
    description:
      'Run one SQL statement against local data files using the DuckDB engine. ' +
      'Attach files with the `files` argument (absolute workspace paths); they become views ' +
      'named f0, f1, ... in the order given. Read-only by default. ' +
      'Results are truncated at max_rows (default 200, hard cap 1000) and report the true ' +
      'row_count so you can decide whether to aggregate further.',
    timeoutMs: DEFAULT_TIMEOUT_MS,
    parameters: {
      sql: {
        type: 'string',
        required: true,
        description:
          'One SQL statement. No statement batches. Reference attached files as f0, f1, ... ' +
          'or a catalog alias attached via duckdb_attach as a plain table name, ' +
          'or call read_csv_auto/read_parquet on a workspace path directly.',
      },
      files: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Absolute paths of data files to attach, in order. Each becomes a view f0, f1, ... ' +
          'Supported: .csv .tsv .parquet .json .jsonl .ndjson .duckdb',
      },
      alias: {
        type: 'string',
        description:
          'Name of an alias previously attached with duckdb_attach; its files become views ' +
          'f0, f1, ... exactly as if passed via `files` (existing files list is prepended).',
      },
      max_rows: {
        type: 'integer',
        description: 'Row cap for the returned preview. Default 200, hard cap 1000.',
      },
      read_only: {
        type: 'boolean',
        description:
          'Default true: only SELECT/WITH/DESCRIBE/SHOW/EXPLAIN are allowed. Set false to run ' +
          'writes (CREATE/INSERT/UPDATE) inside the workspace.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean', required: true },
          columns: { type: 'array', items: { type: 'string' } },
          rows: { type: 'array', items: { type: 'array' } },
          row_count: { type: 'integer' },
          truncated: { type: 'boolean' },
          duration_ms: { type: 'integer' },
          error: {
            type: 'object',
            additionalProperties: true,
            properties: {
              code: { type: 'string', required: true },
              detail: { type: 'string', required: true },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.ok ? renderQuerySuccess(value) : `duckdb_query failed [${value.error.code}]: ${value.error.detail}`,
      }],
    },
    async execute(args, exec) {
      const root = sessionWorkspace(exec)

      const single = assertSingleStatement(args.sql)
      if (!single.ok) return failure(single.code, single.detail)

      const readOnly = args.read_only === undefined ? true : args.read_only === true
      const verdict = checkStatement(single.sql, readOnly)
      if (!verdict.ok) return failure(verdict.code, verdict.detail)

      const attached = resolveFiles(args.files, root)
      if (!attached.ok) return failure(attached.code, attached.detail)

      // Merge catalog alias files behind explicit files, then dedupe.
      let files = attached.files
      if (args.alias !== undefined) {
        const resolvedAlias = catalog.resolve(args.alias, root)
        if (!resolvedAlias.ok) return failure(resolvedAlias.code, resolvedAlias.detail)
        files = [...files, ...resolvedAlias.files.filter((f) => !files.includes(f))]
      }

      const maxRows = clampMaxRows(args.max_rows)
      const started = Date.now()

      const result = await runQuery({
        statement: single.sql,
        files,
        maxRows,
        unsigned: false,
        timeoutMs: DEFAULT_TIMEOUT_MS,
        signal: exec.signal,
        ...(binary !== undefined ? { binary } : {}),
      })

      const durationMs = Date.now() - started
      if (!result.ok) {
        return failure(result.code, result.detail, {
          ...(result.exitCode !== undefined ? { exit_code: result.exitCode } : {}),
        })
      }

      // duckdb renders HUGEINT/DECIMAL as JSON strings; recover real numbers
      // from the column types so the model can do arithmetic on them.
      // The DESCRIBE must replay the same view prelude as the query itself,
      // otherwise `f0` is unknown and the type map silently comes back empty.
      let columnTypes
      try {
        const described = await runQuery({
          statement: describeStatementFor(single.sql, files),
          files: [],
          maxRows: 1,
          unsigned: false,
          timeoutMs: DEFAULT_TIMEOUT_MS,
          signal: exec.signal,
          wrap: false,
          ...(binary !== undefined ? { binary } : {}),
        })
        if (described.ok) {
          columnTypes = (described.rows ?? []).map((row) => ({
            name: String(row.column_name),
            type: String(row.column_type),
          }))
        }
      } catch {
        columnTypes = undefined
      }

      const projected = projectRows(result.rows, columnTypes)
      return {
        ok: true,
        columns: projected.columns,
        rows: projected.rows,
        row_count: projected.row_count,
        truncated: projected.truncated,
        duration_ms: durationMs,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'duckdb_schema',
    description:
      'Describe a local data file (or an already-attached view): column names, types, nullability, ' +
      'a few sample rows and an approximate row count. Call this before querying an unfamiliar file.',
    timeoutMs: DEFAULT_TIMEOUT_MS,
    parameters: {
      target: {
        type: 'string',
        required: true,
        description:
          'Absolute path of a data file, or the name of an attached view (f0, f1, ...).',
      },
      sample_rows: {
        type: 'integer',
        description: 'How many sample rows to return. Default 5, hard cap 50.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean', required: true },
          target: { type: 'string' },
          columns: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: true,
              properties: {
                name: { type: 'string', required: true },
                type: { type: 'string', required: true },
                nullable: { type: 'boolean', required: true },
              },
            },
          },
          sample: { type: 'array', items: { type: 'array' } },
          row_count_approx: { type: 'integer' },
          size_bytes: { type: 'integer' },
          error: {
            type: 'object',
            additionalProperties: true,
            properties: {
              code: { type: 'string', required: true },
              detail: { type: 'string', required: true },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.ok ? renderSchemaSuccess(value) : `duckdb_schema failed [${value.error.code}]: ${value.error.detail}`,
      }],
    },
    async execute(args, exec) {
      const root = sessionWorkspace(exec)
      const isView = /^f\d+$/.test(args.target)

      let statement
      let sizeBytes
      if (isView) {
        statement = args.target
      } else {
        const verdict = validateWorkspaceFile(args.target, root)
        if (!verdict.ok) return failure(verdict.code, verdict.detail)
        sizeBytes = fileSize(verdict.path)
        statement = `SELECT * FROM ${readerFor(verdict.path)}`
      }

      const sampleRows = clampSampleRows(args.sample_rows)
      const describeStatement = `DESCRIBE ${statement}`
      const sampleStatement = `SELECT *, count(*) OVER () AS __duckdb_total FROM (${statement}) LIMIT ${sampleRows}`

      const started = Date.now()
      const describe = await runQuery({
        statement: describeStatement,
        files: [],
        maxRows: 1,
        unsigned: false,
        timeoutMs: DEFAULT_TIMEOUT_MS,
        signal: exec.signal,
        wrap: false,
        ...(binary !== undefined ? { binary } : {}),
      })
      if (!describe.ok) return failure(describe.code, describe.detail)

      const sample = await runQuery({
        statement: sampleStatement,
        files: [],
        maxRows: sampleRows,
        unsigned: false,
        timeoutMs: DEFAULT_TIMEOUT_MS,
        signal: exec.signal,
        ...(binary !== undefined ? { binary } : {}),
      })
      if (!sample.ok) return failure(sample.code, sample.detail)

      const projected = projectRows(sample.rows)
      const columns = (describe.rows ?? []).map((row) => ({
        name: String(row.column_name),
        type: String(row.column_type),
        nullable: String(row.null).toUpperCase() === 'YES',
      }))

      return {
        ok: true,
        target: args.target,
        columns,
        sample: projected.rows,
        row_count_approx: projected.row_count,
        ...(sizeBytes !== undefined ? { size_bytes: sizeBytes } : {}),
        duration_ms: Date.now() - started,
      }
    },
  }))
  ctx.tools.register(defineTool({
    name: 'duckdb_attach',
    description:
      'Register data files (or glob patterns) under a short alias, once per session. Later calls ' +
      'pass `alias` to duckdb_query/duckdb_schema instead of repeating long paths. Paths must be ' +
      'absolute and inside the workspace; aliases are lowercase identifiers.',
    timeoutMs: 10000,
    parameters: {
      alias: {
        type: 'string',
        required: true,
        description: "Alias name, e.g. 'sales'. Match /^[a-z][a-z0-9_]{0,63}$/.",
      },
      files: {
        type: 'array',
        items: { type: 'string' },
        required: true,
        description:
          'Absolute workspace paths or glob patterns (e.g. /ws/data/*.parquet). Each becomes a view ' +
          'f0, f1, ... in sorted order when the alias is used.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean', required: true },
          alias: { type: 'string' },
          files: { type: 'array', items: { type: 'string' } },
          file_count: { type: 'integer' },
          error: {
            type: 'object',
            additionalProperties: true,
            properties: {
              code: { type: 'string', required: true },
              detail: { type: 'string', required: true },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.ok
          ? `attached ${value.alias}: ${value.file_count} file(s) → views f0..f${Math.max(0, value.file_count - 1)} on use`
          : `duckdb_attach failed [${value.error.code}]: ${value.error.detail}`,
      }],
    },
    execute(args, exec) {
      const root = sessionWorkspace(exec)
      const result = catalog.attach(args.files, args.alias, root)
      if (!result.ok) return failure(result.code, result.detail)
      return { ok: true, alias: result.alias, files: result.files, file_count: result.files.length }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'duckdb_catalog',
    description: 'List aliases attached in this workspace with their file counts.',
    timeoutMs: 5000,
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean', required: true },
          attachments: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: true,
              properties: {
                alias: { type: 'string', required: true },
                file_count: { type: 'integer', required: true },
                created_at: { type: 'integer' },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.attachments.length === 0
          ? 'no attachments; call duckdb_attach first'
          : value.attachments.map((a) => `${a.alias}: ${a.file_count} file(s)`).join('\n'),
      }],
    },
    execute(_args, exec) {
      return { ok: true, attachments: catalog.list(sessionWorkspace(exec)) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'duckdb_convert',
    description:
      'Convert a workspace data file to parquet/csv/json/duckdb. The plugin builds the statement; ' +
      'you supply paths and a format only. Output must be a new file inside the workspace.',
    timeoutMs: DEFAULT_TIMEOUT_MS,
    parameters: {
      input: {
        type: 'string',
        required: true,
        description: 'Absolute workspace path of the source file.',
      },
      output: {
        type: 'string',
        required: true,
        description: 'Absolute workspace path of the target; must end with .parquet/.csv/.json/.duckdb.',
      },
      output_format: {
        type: 'string',
        required: true,
        description: 'One of: parquet, csv, json, duckdb.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean', required: true },
          output_path: { type: 'string' },
          bytes_out: { type: 'integer' },
          duration_ms: { type: 'integer' },
          error: {
            type: 'object',
            additionalProperties: true,
            properties: {
              code: { type: 'string', required: true },
              detail: { type: 'string', required: true },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.ok
          ? `converted → ${value.output_path} (${value.bytes_out} bytes, ${value.duration_ms}ms)`
          : `duckdb_convert failed [${value.error.code}]: ${value.error.detail}`,
      }],
    },
    async execute(args, exec) {
      const root = sessionWorkspace(exec)
      const verdict = validateConversion(args.input, args.output, args.output_format, root)
      if (!verdict.ok) return failure(verdict.code, verdict.detail)

      const started = Date.now()
      const result = await runQuery({
        statement: buildConvertStatement(verdict.input, verdict.output, verdict.format),
        files: [],
        maxRows: 0,
        unsigned: false,
        timeoutMs: DEFAULT_TIMEOUT_MS,
        signal: exec.signal,
        wrap: false,
        ...(binary !== undefined ? { binary } : {}),
      })
      if (!result.ok) return failure(result.code, result.detail)

      const bytesOut = fileSize(verdict.output)
      if (bytesOut === undefined) {
        return failure('NO_OUTPUT', `conversion reported success but no file appeared at ${verdict.output}`)
      }
      return { ok: true, output_path: verdict.output, bytes_out: bytesOut, duration_ms: Date.now() - started }
    },
  }))
}

/**
 * Build the `DESCRIBE <statement>` form that replays the same view prelude as
 * the query. Without the prelude, a statement referencing an attached view
 * (f0, f1, ...) fails with "Table with name f0 does not exist", which used to
 * make the type-coercion step silently degrade to a no-op.
 */
function describeStatementFor(statement, files) {
  const prelude = (files ?? []).map((file, index) => {
    return `CREATE VIEW f${index} AS SELECT * FROM ${readerFor(file)}`
  })
  return [...prelude, `DESCRIBE ${statement}`].join(';\n')
}

function clampSampleRows(requested) {
  const n = Number(requested)
  if (!Number.isFinite(n) || n < 1) return 5
  return Math.min(Math.floor(n), 50)
}

function fileSize(path) {
  try {
    return statSync(path).size
  } catch {
    return undefined
  }
}

function renderQuerySuccess(value) {
  const lines = []
  if (value.columns.length === 0) {
    lines.push('(no columns)')
    return lines.join('\n')
  }
  lines.push(`columns: ${value.columns.join(' | ')}`)
  lines.push(`rows: ${value.rows.length} of ${value.row_count}${value.truncated ? ' (truncated)' : ''}`)
  for (const row of value.rows.slice(0, 50)) {
    lines.push(row.map((cell) => (cell === null ? 'NULL' : String(cell))).join(' | '))
  }
  if (value.rows.length > 50) lines.push(`... ${value.rows.length - 50} more rows omitted from this rendering`)
  lines.push(`[${value.duration_ms}ms]`)
  return lines.join('\n')
}

function renderSchemaSuccess(value) {
  const lines = [`schema for ${value.target}`]
  for (const column of value.columns) {
    lines.push(`  ${column.name} ${column.type}${column.nullable ? '' : ' NOT NULL'}`)
  }
  lines.push(`approx rows: ${value.row_count_approx}`)
  if (value.size_bytes !== undefined) lines.push(`file size: ${value.size_bytes} bytes`)
  if (value.sample.length > 0) {
    lines.push('sample:')
    for (const row of value.sample) {
      lines.push('  ' + row.map((cell) => (cell === null ? 'NULL' : String(cell))).join(' | '))
    }
  }
  return lines.join('\n')
}

export { name, inject }
