/**
 * duckdb_pipeline — SQL pipeline as an in-process background job.
 *
 * Runs a sequence of guarded statements through the same execution path as
 * duckdb_query/duckdb_convert (guard → remote gate → extension prelude →
 * wrap), narrating progress into the job ring so the model keeps its turn
 * while the pipeline runs, then reads results via job_output.
 *
 * Requires @deepseek-ai/dsh-jobs-local (ctx.jobs) in the composition; when
 * absent the tool fails with a clear code instead of blocking the turn.
 */

import { assertSingleStatement, checkStatement, checkRemoteAccess } from './guard.js'
import { runQuery } from './cli.js'

/** Fixed timeout per pipeline step (jobs have their own lifecycle). */
export const STEP_TIMEOUT_MS = 120_000

/**
 * Validate a pipeline spec (shape only — statements are guarded per step at
 * run time so the same rules as duckdb_query apply).
 *
 * @returns {{ok: true, steps: Array<{sql: string, read_only: boolean, label: string}>} |
 *           {ok: false, code: string, detail: string}}
 */
export function validatePipeline(spec) {
  if (typeof spec !== 'object' || spec === null) return { ok: false, code: 'BAD_PIPELINE', detail: 'pipeline must be an object' }
  const steps = spec.steps
  if (!Array.isArray(steps) || steps.length === 0) return { ok: false, code: 'BAD_PIPELINE', detail: 'steps must be a non-empty array' }
  if (steps.length > 20) return { ok: false, code: 'BAD_PIPELINE', detail: 'at most 20 steps per pipeline' }
  const normalized = []
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]
    if (typeof step.sql !== 'string' || step.sql.trim() === '') {
      return { ok: false, code: 'BAD_PIPELINE', detail: `steps[${i}].sql must be a non-empty string` }
    }
    normalized.push({
      sql: step.sql,
      files: Array.isArray(step.files) ? step.files : undefined,
      read_only: step.read_only === undefined ? true : step.read_only === true,
      label: typeof step.label === 'string' && step.label.length > 0 ? step.label.slice(0, 80) : `step ${i + 1}`,
    })
  }
  return { ok: true, steps: normalized }
}

/**
 * Create the JobSpec for a validated pipeline. `ctx`-free: everything the
 * runner needs is passed in, so this stays unit-testable.
 *
 * @param {object} opts
 * @param {Array} opts.steps - normalized steps from validatePipeline
 * @param {string} opts.label - job label (the pipeline name)
 * @param {() => string[]} opts.extensionPrelude - per-query prelude provider
 * @param {(files: string[]|undefined, root: string) => {ok: boolean, code?: string, detail?: string, paths?: string[]}} opts.resolveFiles
 * @param {string} opts.root - session workspace root
 * @param {string} [opts.binary] - duckdb binary override
 * @param {string} [opts.owner] - owning session id
 */
export function pipelineJobSpec({ steps, label, extensionPrelude, resolveFiles, root, binary, owner }) {
  return {
    kind: 'duckdb',
    label,
    ...(owner !== undefined ? { owner } : {}),
    outputLimitBytes: 32_768,
    run(job) {
      let cancelled = false
      const done = (async () => {
        const results = []
        const prelude = await extensionPrelude()
        for (let i = 0; i < steps.length; i++) {
          if (cancelled) break
          const step = steps[i]
          job.updateProgress(`${i}/${steps.length} ${step.label}`)
          const outcome = await runStep({ step, prelude, resolveFiles, root, binary })
          results.push({ step: i + 1, label: step.label, ...outcome })
          job.append(JSON.stringify({ step: i + 1, label: step.label, ...outcome }) + '\n')
          if (!outcome.ok) break
        }
        job.updateProgress(`${Math.min(results.length, steps.length)}/${steps.length}`)
        const failed = results.find((r) => !r.ok)
        return {
          status: failed ? 'failed' : cancelled ? 'cancelled' : 'succeeded',
          detail: failed ? `step ${failed.step} (${failed.label}) failed: ${failed.code}` : 'all steps completed',
          result: JSON.stringify({ ok: !failed && !cancelled, steps: results.length, results }),
        }
      })()
      return {
        cancel() { cancelled = true },
        done,
      }
    },
  }
}

/** Run one guarded step. Files were pre-resolved by the tool layer. */
async function runStep({ step, prelude, resolveFiles, root, binary }) {
  const single = assertSingleStatement(step.sql)
  if (!single.ok) return { ok: false, ...single }
  const verdict = checkStatement(single.sql, step.read_only)
  if (!verdict.ok) return { ok: false, ...verdict }
  const remote = checkRemoteAccess(single.sql, step.allow_remote === true)
  if (!remote.ok) return { ok: false, ...remote }

  // Steps carry pre-resolved files from the tool layer; resolveFiles is the
  // pass-through for that. A step without files runs bare (views may come from
  // attached aliases only if this engine supported them — it does not, so
  // bare steps are pure compute like SELECT 1 or file-less DDL-free reads).
  const files = step.resolvedFiles ?? []
  void resolveFiles
  void root

  const started = Date.now()
  const result = await runQuery({
    statement: single.sql,
    files,
    maxRows: 20,
    unsigned: false,
    timeoutMs: STEP_TIMEOUT_MS,
    extensionPrelude: prelude,
    ...(binary !== undefined ? { binary } : {}),
  })
  if (!result.ok) return { ok: false, code: result.code, detail: result.detail, duration_ms: Date.now() - started }
  return { ok: true, rows_sampled: result.rows.length, duration_ms: Date.now() - started }
}
