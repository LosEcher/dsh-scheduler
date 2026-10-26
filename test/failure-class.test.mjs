// 失败归因的单元测试（纯函数，无 IO）。
//
// 这些用例是「判据 + 负向控制」的同体：每个正向分类都配一条「不该被误判」的控制，
// 因为归因一旦误判，台账就会长出"看起来很有解释力"的假事实 —— 比没有归因更糟。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  classifyFailure, isEnvironmentFailure, describeFailureKind,
  missingCredential, FAILURE_KINDS, ENVIRONMENT_KINDS, ROUTE_CREDENTIAL_ENV,
} from '../lib/failure-class.mjs'

test('每个归因都在 FAILURE_KINDS 里（新增类别必须登记，否则下游筛选会静默漏掉）', () => {
  const cases = [
    [{ error: 'MISSING_CREDENTIAL: no API key for provider route "los"' }, 'missing_credential'],
    [{ error: 'CONTEXT_WINDOW_EXCEEDED: 123456 > 65536' }, 'context_window_exceeded'],
    [{ error: 'TRANSPORT: DeepSeek Messages transport failed' }, 'transport'],
    [{ timedOut: true, error: 'timeout after 1800s' }, 'timeout'],
    [{ assertFailed: true, error: 'assert failed (exit 3): boom' }, 'assert_failed'],
    [{ deliveryMissing: true, error: 'delivery missing for key "k"' }, 'delivery_missing'],
    [{ deliveryDuplicate: true, error: 'delivery duplicated for key "k"' }, 'delivery_duplicate'],
    [{ deliveryStray: true, error: 'delivery stray keys during this run: x' }, 'delivery_stray'],
    [{ error: 'spawn: ENOENT' }, 'spawn_error'],
    [{ exitCode: 3 }, 'exit_nonzero'],
    [{}, 'unknown'],
  ]
  for (const [input, want] of cases) {
    const got = classifyFailure(input)
    assert.equal(got, want, `classify(${JSON.stringify(input)}) → ${got}, want ${want}`)
    assert.ok(FAILURE_KINDS.includes(got), `${got} 未登记在 FAILURE_KINDS`)
  }
})

test('行首错误码（output 里）能判归因 —— 这是真机上根因的实际位置', () => {
  // 真机形态：exit 非零 + stderr 尾部带错误码；finish 当时没写 error。
  assert.equal(
    classifyFailure({ output: 'boot ok\nMISSING_CREDENTIAL: no API key for provider route "los"\n', exitCode: 1 }),
    'missing_credential',
  )
  assert.equal(classifyFailure({ output: 'TRANSPORT: upstream closed\n', exitCode: 1 }), 'transport')
})

test('负向控制：正文里提到错误码不算这次失败的原因', () => {
  // 报告正文/引用样例：不在行首，或只是散文提及 ⇒ 必须落到兜底，不能冒充根因。
  const prose = '本次报告提到 上次报 MISSING_CREDENTIAL: no API key 的问题已经修了，结论见正文。'
  assert.equal(classifyFailure({ output: prose, exitCode: 1 }), 'exit_nonzero')
  // 行内提及（不是行首）同理
  assert.equal(classifyFailure({ error: 'see also: MISSING_CREDENTIAL was fixed', exitCode: 1 }), 'exit_nonzero')
  // 普通单词 "credential" 不足以判缺凭据
  assert.equal(classifyFailure({ error: 'credential store path is /x', exitCode: 1 }), 'exit_nonzero')
})

test('负向控制：错误码行但规则未覆盖 ⇒ unknown（不猜）', () => {
  assert.equal(classifyFailure({ output: 'AUTH: something new happened\n', exitCode: 1 }), 'unknown')
})

test('空证据：无退出码 ⇒ unknown；退出码 0 ⇒ unknown（不该有 finish，但别骗人）', () => {
  assert.equal(classifyFailure({}), 'unknown')
  assert.equal(classifyFailure({ exitCode: 0 }), 'unknown')
  assert.equal(classifyFailure(null), 'unknown')
})

test('显式布尔证据优先于文本（代码路径结论压过字符串巧合）', () => {
  assert.equal(classifyFailure({ timedOut: true, error: 'MISSING_CREDENTIAL: x' }), 'timeout')
  assert.equal(classifyFailure({ assertFailed: true, error: 'TRANSPORT: x' }), 'assert_failed')
})

test('环境类归因集合 = 缺凭据 / 超窗 / 起不来（重试无用且不计入失败链）', () => {
  assert.deepEqual([...ENVIRONMENT_KINDS].sort(), ['context_window_exceeded', 'missing_credential', 'spawn_error'])
  for (const k of FAILURE_KINDS) {
    assert.equal(
      isEnvironmentFailure(k),
      ENVIRONMENT_KINDS.has(k),
      `isEnvironmentFailure(${k}) 与 ENVIRONMENT_KINDS 不一致`,
    )
  }
  // 负向控制：网络类必须仍算"作业失败"（可重试，不能因为"不是任务的错"就放过）
  assert.equal(isEnvironmentFailure('transport'), false)
  assert.equal(isEnvironmentFailure('timeout'), false)
})

test('每个已知归因都有一行解释（不能落回 unknown 的文案）', () => {
  for (const k of FAILURE_KINDS) {
    const text = describeFailureKind(k)
    assert.ok(text && text.length > 4, `${k} 的解释为空`)
    if (k !== 'unknown') assert.ok(!text.includes('判不了'), `${k} 落回了 unknown 的文案`)
  }
})

test('missingCredential：白名单内 + env 缺失 ⇒ 判缺；env 在场 ⇒ null（fail-open）', () => {
  assert.deepEqual(missingCredential({ provider: 'los' }, {}), { provider: 'los', envVars: ROUTE_CREDENTIAL_ENV.los })
  assert.equal(missingCredential({ provider: 'los' }, { LOS_AUTH_TOKEN: 't' }), null)
  // 空串/纯空白不算"有凭据"（.env 里写了 KEY= 是常见形态）
  assert.ok(missingCredential({ provider: 'los' }, { LOS_AUTH_TOKEN: '   ' }))
  // 备选变量名任一在场即算有（opencode-zen 有两个历史名）
  assert.equal(missingCredential({ provider: 'opencode-zen' }, { OPENCODE_API_KEY: 'k' }), null)
})

test('负向控制：不认识的 provider / 没有 model ⇒ null（绝不因为"没找到 KEY"就跳过作业）', () => {
  assert.equal(missingCredential({ provider: 'my-custom-gateway' }, {}), null)
  assert.equal(missingCredential(null, {}), null)
  assert.equal(missingCredential(undefined, {}), null)
  assert.equal(missingCredential({}, { DEEPSEEK_API_KEY: '' }), null) // 无 provider 名 ⇒ 不判
})
