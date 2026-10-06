#!/usr/bin/env node
/**
 * assert-delivered-once — 「交付恰好一次」的机械判据（2026-10-06）。
 *
 * 背景：job.assertCmd 原先只验「报告文件存在/非空/新鲜」，**不验发了几条**。而 job prompt
 * 里的推送是 agent 执行的，agent 若换了 `--key`（或漏传），key 幂等就失效——同一触发可以
 * 发多条，而本地台账只看得到 finish 行的 push 字段（0/1 条事实），看不见第 2 条。
 * 2026-10-06 起 scheduler 把交付写成独立 side 事件 `evt:'delivered'`（带 deliveryKey =
 * jobId|scheduledFor），于是「这个 key 交付了几次」成为**可机械折叠**的事实。
 *
 * 判据（三态，与 scheduler 的交付派生同源）：
 *   恰好 1 条（delivered 或 skipped）→ 0 通过（skipped = 有意静默，合法）
 *   0 条                              → 1 失败（missing；--allow-missing 可放行）
 *   ≥2 条                             → 1 失败（duplicate，列出每条的 status/at）
 * 台账轮转（archive/runs-*.jsonl）也要扫——否则旧 key 会被读成 missing。
 *
 * 用法：
 *   node assert-delivered-once.mjs <runs.jsonl> <deliveryKey> [--allow-missing] [--json]
 * 例（job.assertCmd，scheduler 会把 runKey 注入子进程 env）：
 *   node .../scripts/assert-delivered-once.mjs "$HOME/.dsh/storages/dsh-scheduler/runs.jsonl" "$DSH_SCHED_RUN_KEY"
 *
 * 退出码：0 通过 / 1 判据失败 / 2 用法或环境错误（fail-closed，绝不把"读不到"当通过）。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** 折叠一份台账文本里的 delivered 事件。纯函数，便于负向控制。 */
export function countDeliveries(text, deliveryKey) {
  const hits = []
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue
    let ev
    try { ev = JSON.parse(line) } catch { continue } // 撕裂行跳过，不猜
    if (ev?.evt !== 'delivered') continue
    if (deliveryKey && ev.deliveryKey !== deliveryKey) continue
    hits.push({
      status: ev.deliveryStatus ?? 'delivered',
      at: ev.completedAt ?? ev.startedAt ?? null,
      runId: ev.id ?? null,
      jobId: ev.jobId ?? null,
    })
  }
  return hits
}

/** 读 runs.jsonl 及其同级 archive/runs-*.jsonl（轮转后旧事件仍在归档里）。 */
export function readLedgerEvents(runsPath) {
  const paths = [runsPath]
  try {
    const archive = join(dirname(runsPath), 'archive')
    for (const name of readdirSync(archive)) {
      if (name.startsWith('runs-') && name.endsWith('.jsonl')) paths.push(join(archive, name))
    }
  } catch { /* 没有归档目录属正常 */ }
  let text = ''
  let read = 0
  for (const path of paths) {
    try { text += readFileSync(path, 'utf8'); text += '\n'; read += 1 } catch { /* 单个文件读不到不算致命 */ }
  }
  return { text, read, paths }
}

export function judge(hits, { allowMissing = false } = {}) {
  const delivered = hits.filter((h) => h.status === 'delivered').length
  const skipped = hits.filter((h) => h.status === 'skipped').length
  if (hits.length === 1) return { ok: true, verdict: hits[0].status, delivered, skipped, hits }
  if (hits.length === 0) {
    return { ok: allowMissing, verdict: allowMissing ? 'missing-allowed' : 'missing', delivered, skipped, hits }
  }
  return { ok: false, verdict: 'duplicate', delivered, skipped, hits }
}

function main(argv) {
  const args = argv.slice(2)
  const flags = new Set(args.filter((a) => a.startsWith('--')))
  const positional = args.filter((a) => !a.startsWith('--'))
  const [runsPath, deliveryKey] = positional
  if (!runsPath || !deliveryKey) {
    process.stderr.write('用法: assert-delivered-once.mjs <runs.jsonl> <deliveryKey> [--allow-missing] [--json]\n')
    return 2
  }
  const { text, read, paths } = readLedgerEvents(runsPath)
  if (read === 0) {
    // fail-closed：台账一个文件都读不到时绝不当成"没有交付"以外的结论——直接报环境错误
    process.stderr.write(JSON.stringify({ ok: false, error: 'ledger_unreadable', runsPath, tried: paths }) + '\n')
    return 2
  }
  const hits = countDeliveries(text, deliveryKey)
  const verdict = judge(hits, { allowMissing: flags.has('--allow-missing') })
  const report = { ok: verdict.ok, verdict: verdict.verdict, deliveryKey, delivered: verdict.delivered, skipped: verdict.skipped, hits: verdict.hits, filesRead: read }
  if (flags.has('--json')) process.stdout.write(JSON.stringify(report, null, 2) + '\n')
  else process.stdout.write(`assert-delivered-once: ${verdict.ok ? 'PASS' : 'FAIL'} verdict=${verdict.verdict} key=${deliveryKey} delivered=${verdict.delivered} skipped=${verdict.skipped}\n`)
  return verdict.ok ? 0 : 1
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  process.exit(main(process.argv))
}
