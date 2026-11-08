/**
 * 运行链的**异常兜底不得报成功**（2026-11-08，Codex 只读评审指出）。
 *
 * 事故形态：`index.mjs` 里 headless 运行 → assert 这条 Promise 链尾部的 `.catch` 原文是
 *
 *     finish({ status: 'succeeded', exitCode: 0, assertError: renderThrown(error) })
 *
 * 于是**链上任何异常**（assert 装配出错、后处理 TypeError、判据自身崩）都被记成"成功"，
 * 连 exitCode 都写成 0：台账说绿、人以为跑了，实际判据根本没跑完。这正是本仓反复要消的假绿。
 *
 * 为什么用"源码形态"判据而不是行为测试：这段代码在 `start()` 的闭包里，没有可注入的
 * 依赖缝（要真跑一次 headless + assert 才能触发），而把它整体抽出来重构的半径远大于收益。
 * 所以判据锚在最窄的形态上，并且**自带负向控制**——证明这个 matcher 对旧写法真的会红，
 * 否则它就只是一条恒绿的装饰。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const INDEX = fileURLToPath(new URL('../index.mjs', import.meta.url))

/**
 * "把 assertError 与 succeeded 写进同一个 finish(...)" —— 旧形态。
 * 允许跨行（防止有人改写成多行就绕过判据）。
 */
const SUCCEEDED_WITH_ASSERT_ERROR = /finish\(\{[^}]*status:\s*'succeeded'[^}]*assertError[^}]*\}\)/s

test('负向控制：matcher 对旧写法必须命中（否则这条判据是恒绿的装饰）', () => {
  const legacy = `        }).catch((error) => {
          if (settled) return
          finish({ status: 'succeeded', exitCode: 0, assertError: renderThrown(error) })
        })`
  assert.match(legacy, SUCCEEDED_WITH_ASSERT_ERROR, 'matcher 对旧写法不命中 ⇒ 判据无效')
})

test('负向控制：多行改写也要命中（不能靠换行绕过）', () => {
  const legacyMultiline = `finish({
            status: 'succeeded',
            exitCode: 0,
            assertError: renderThrown(error),
          })`
  assert.match(legacyMultiline, SUCCEEDED_WITH_ASSERT_ERROR)
})

test('index.mjs 的运行链异常兜底必须记 failed（不得再出现 succeeded + assertError）', () => {
  const src = readFileSync(INDEX, 'utf8')
  assert.doesNotMatch(
    src,
    SUCCEEDED_WITH_ASSERT_ERROR,
    '运行链异常的 catch 又写成 succeeded 了 ⇒ 任何异常都会被记成"成功"（假绿）',
  )
})

test('异常兜底必须留下可读的真因（run pipeline threw + assertError）', () => {
  const src = readFileSync(INDEX, 'utf8')
  assert.match(src, /run pipeline threw:/, '缺少显式失败文案 ⇒ 台账里只剩一条无因的 failed')
  assert.match(src, /status:\s*'failed'[\s\S]{0,200}?assertError:\s*renderThrown\(error\)/, '失败结局里没有带 assertError')
})
