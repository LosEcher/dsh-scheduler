#!/usr/bin/env node
// Fake dsh CLI for dsh-scheduler execution-path tests.
//
// The scheduler spawns `node <cli> --profile headless "<prompt>"`. This stub
// lets tests exercise runJob/finish end-to-end without booting a real agent:
//   - default             → exit 0 (succeeded)
//   - prompt has __FAIL__ → stderr + exit 3 (failed)
//   - prompt has __HANG__ → sleep FAKE_HANG_MS (default 3000) then exit 0
//   - prompt has __PUSH__ → simulate `feishu-push.sh --key "$DSH_SCHED_RUN_KEY"`:
//                           write <DSH_SCHED_DELIVERY_STATE_DIR>/<sha256(key)[0:16]>.sent
//                           (the exact contract the real script implements), exit 0
//   - prompt has __NOENV__→ exit 9 unless the run-context env is present, so the
//                           env-injection contract is asserted, not assumed
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const prompt = process.argv[process.argv.length - 1] ?? ''

function fail(msg) {
  process.stderr.write(`${msg}\n`)
  process.exit(3)
}

if (prompt.includes('__NOENV__')) {
  const missing = ['DSH_SCHED_RUN_KEY', 'DSH_SCHED_JOB_ID', 'DSH_SCHED_DELIVERY_STATE_DIR']
    .filter((k) => !process.env[k])
  if (missing.length) {
    process.stderr.write(`missing run-context env: ${missing.join(',')}\n`)
    process.exit(9)
  }
  process.exit(0)
}

// 回显收到的 prompt：用于断言「spawn 传给 agent 的是替换后的 prompt」。
// 注意这只证明参数到位；真机上 prompt 是 agent 的唯一指令通道（bash 工具不继承
// 进程 env），所以这正是幂等键到达推送点的端到端判据。
if (prompt.includes('__ECHO_PROMPT__')) {
  process.stdout.write(`PROMPT=${prompt}\n`)
  process.exit(0)
}

if (prompt.includes('__HANG__')) {
  const ms = Number(process.env.FAKE_HANG_MS ?? 3000)
  setTimeout(() => process.exit(0), ms)
} else if (prompt.includes('__FAIL__')) {
  fail('fake failure for test')
} else if (prompt.includes('__PUSH__')) {
  const key = process.env.DSH_SCHED_RUN_KEY
  const stateDir = process.env.DSH_SCHED_DELIVERY_STATE_DIR
  if (!key || !stateDir) fail('__PUSH__ requires DSH_SCHED_RUN_KEY + DSH_SCHED_DELIVERY_STATE_DIR')
  const hash = createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 16)
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(
    join(stateDir, `${hash}.sent`),
    JSON.stringify({ key, messageId: 'om_fake_test', sentAt: new Date().toISOString() }),
    'utf8',
  )
  process.exit(0)
} else {
  process.exit(0)
}
