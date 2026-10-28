import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

// Import via the profile symlink so peer `@deepseek-ai/schemastery` resolves
// (see config.test.mjs header: direct ../index.mjs realpaths out of the profile).
const pluginHref = pathToFileURL(
  `${process.env.HOME}/.dsh/profiles/web/node_modules/dsh-scheduler/index.mjs`,
).href

const mod = await import(pluginHref)

/**
 * 2026-10-28 事故回归：stray-key 越界检测只看「本次 run 期间目录里出现了别的 key」，
 * 而它的豁免集原先**只来自其他调度作业**。同一个 deliveryStateDir 还被宿主外的
 * launchd 脚本写入 —— `~/.dsh/scripts/health-alerts.sh`（`health-alerts-<YYYYMMDD-HH>`，
 * 每天 09:05）与 `dsfolder/scripts/los-task-attention.mjs`（`los-task-digest:<日期>`）
 * —— 于是别人的**合法**写入把两个调度作业同时判红：
 *   10-28 09:12/09:13 双红于 health-alerts-20261028-09
 *   10-23 双红于 los-task-digest:2026-10-23
 * 7 天 8 次失败里 6 次是这一类。
 *
 * 这组用例同时钉住**判据的边界**：白名单是精确前缀匹配，同族里 agent 自造的
 * 近似键仍然必须被抓（负向控制），否则「修误报」会变成「关掉检测」。
 */

function withStateDir(files, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-sched-stray-'))
  try {
    for (const [name, key] of Object.entries(files)) {
      writeFileSync(join(dir, name), JSON.stringify({ key, at: new Date().toISOString() }))
    }
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const SINCE = Date.now() - 1000
const DELIVERY_KEY = 'feed-20261028-0835'

test('外部写者前缀（health-alerts / los-task-digest）不再被判成越界', () => {
  withStateDir({
    'h.sent': 'health-alerts-20261028-09',
    'l.sent': 'los-task-digest:2026-10-28',
  }, (dir) => {
    // 未接白名单时：这正是 10-28 那次双红的形态
    assert.deepEqual(
      mod.findStrayDeliveries(dir, DELIVERY_KEY, SINCE).sort(),
      ['health-alerts-20261028-09', 'los-task-digest:2026-10-28'],
    )
    // 接入外部前缀后：干净
    const prefixes = mod.collectKnownDeliveryPrefixes([], 'job-a', mod.DEFAULT_EXTERNAL_DELIVERY_PREFIXES)
    assert.deepEqual(mod.findStrayDeliveries(dir, DELIVERY_KEY, SINCE, prefixes), [])
  })
})

test('负向控制：同族的自造近似键仍必须被抓（白名单是精确前缀，不是模糊匹配）', () => {
  withStateDir({
    // 缺分隔符/少字符/前缀在前但不同族 —— 都不是外部写者的真实形态
    'a.sent': 'los-task-digestx:2026-10-28',
    'b.sent': 'healthalert-20261028-09',
    'c.sent': 'feed-20261028-0900',
  }, (dir) => {
    const prefixes = mod.collectKnownDeliveryPrefixes([], 'job-a', mod.DEFAULT_EXTERNAL_DELIVERY_PREFIXES)
    assert.deepEqual(
      mod.findStrayDeliveries(dir, DELIVERY_KEY, SINCE, prefixes).sort(),
      ['feed-20261028-0900', 'healthalert-20261028-09', 'los-task-digestx:2026-10-28'],
    )
  })
})

test('负向控制：本次注入的交付键本身不算越界，缺失由主判据负责', () => {
  withStateDir({ 'me.sent': DELIVERY_KEY }, (dir) => {
    const prefixes = mod.collectKnownDeliveryPrefixes([], 'job-a', mod.DEFAULT_EXTERNAL_DELIVERY_PREFIXES)
    assert.deepEqual(mod.findStrayDeliveries(dir, DELIVERY_KEY, SINCE, prefixes), [])
  })
})

test('collectKnownDeliveryPrefixes：并集、排自己、剔空、容忍非数组输入', () => {
  const jobs = [
    { id: 'job-a', notify: { require: false }, deliveryKey: 'feed-{{DSH_SCHED_RUN_KEY}}' },
    { id: 'job-b', notify: {}, deliveryKey: 'weekly-digest-{{DSH_SCHED_DELIVERY_KEY}}' },
    { id: 'job-c', notify: null, deliveryKey: 'ignored-{{X}}' },      // 不投递 ⇒ 不入白名单
    { id: 'job-d', notify: { require: false } },                       // 无 deliveryKey ⇒ 跳过
    { id: 'job-e', notify: {}, deliveryKey: '{{X}}-leading' },         // 模板在开头 ⇒ 原文
  ]
  const got = mod.collectKnownDeliveryPrefixes(jobs, 'job-a', ['health-alerts-', '', null, 'los-task-digest:'])
  assert.deepEqual(got, ['weekly-digest-', '{{X}}-leading', 'health-alerts-', 'los-task-digest:'])

  // 非数组/缺参一律不抛，退化成空集（配置坏掉不该打断 finish 的台账写入）
  assert.deepEqual(mod.collectKnownDeliveryPrefixes(null, 'job-a', undefined), [])
  assert.deepEqual(mod.collectKnownDeliveryPrefixes(jobs, 'job-a', 'not-an-array'), ['weekly-digest-', '{{X}}-leading'])
})

test('Config / resolveConfig 都带同一份默认前缀（单一真源）', () => {
  const { Config, resolveConfig, DEFAULT_EXTERNAL_DELIVERY_PREFIXES } = mod
  assert.deepEqual(DEFAULT_EXTERNAL_DELIVERY_PREFIXES, ['health-alerts-', 'los-task-digest:'])
  // schemastery .default() 存的是字面量：schema 默认与运行时回落必须是同一份内容
  assert.deepEqual(Config({}).externalDeliveryPrefixes, DEFAULT_EXTERNAL_DELIVERY_PREFIXES)
  assert.deepEqual(resolveConfig({}).externalDeliveryPrefixes, DEFAULT_EXTERNAL_DELIVERY_PREFIXES)
})

test('resolveConfig：显式配置覆盖默认；空数组=有意关闭豁免；脏值被过滤', () => {
  const { resolveConfig } = mod
  assert.deepEqual(
    resolveConfig({ externalDeliveryPrefixes: ['custom-'] }).externalDeliveryPrefixes,
    ['custom-'],
  )
  // 空数组是**有意的逃生口**（用户判断没有外部写者时不豁免），不能回落成默认
  assert.deepEqual(resolveConfig({ externalDeliveryPrefixes: [] }).externalDeliveryPrefixes, [])
  assert.deepEqual(
    resolveConfig({ externalDeliveryPrefixes: ['ok-', '', null, 42] }).externalDeliveryPrefixes,
    ['ok-'],
  )
})

/**
 * 接线断言（结构级，非行为级）：上面的纯函数测试无法证明**调用点**真的把
 * `cfg.externalDeliveryPrefixes` 传了进去 —— 那正是本仓最贵的缺陷类别
 * 「声明了但没生效」（字段进了 Config，调用点忘了传，于是行为静默退回修复前）。
 * 这里读源码断言调用形态；它只能抓"被删掉/被改坏"，抓不到语义错误，
 * 所以与上面的行为测试**配对存在**，不能替代它们。
 */
test('接线：stray 检测的调用点确实传入了 cfg.externalDeliveryPrefixes', () => {
  const src = readFileSync(new URL('../index.mjs', import.meta.url), 'utf8')
  const at = src.indexOf('const knownPrefixes = collectKnownDeliveryPrefixes(')
  assert.ok(at > 0, '调用点缺失：collectKnownDeliveryPrefixes 未被用于构造白名单')
  const call = src.slice(at, at + 400)
  assert.match(call, /cfg\.externalDeliveryPrefixes/, '调用点没有传入配置 → 白名单退化为只有并发作业前缀')
  // 主判据仍在：白名单之外还要有「本次注入键必须出现」这条检查
  assert.match(src, /strays\.length > 0/, '越界检测本身被移除')
})
