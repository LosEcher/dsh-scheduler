// dsh-scheduler per-run model override — patch 正文的回归测试。
//
// 为什么需要它（2026-10-09）：旧实现把覆盖写成 `- id: settings / config: { path }`
// 并依赖 `$DSH_HOME/settings.yaml`；而该文件已被 harness 移除（导入后重命名为
// `settings.yaml.imported`）⇒ 每个作业的 model 覆盖（含 fallback 链）**静默失效**，
// 且失效时不打印任何东西（"model override …" 日志只在拿到 patch 时才出现）。
// 这类"静默失效"必须有机械判据，所以这里既钉**正确形状**，也钉**旧形状不得复现**。
//
// Run: node --test test/model-override.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderModelOverridePatch } from '../lib/model-override.mjs'

test('renders an id-targeted agent-default-model override', () => {
  const text = renderModelOverridePatch({ provider: 'deepseek-official', model: 'deepseek-flash' })
  assert.equal(
    text,
    [
      '# dsh-scheduler per-run model override (generated; do not edit)',
      '- id: agent-default-model',
      "  name: '@deepseek-ai/dsh-agent-default-model'",
      '  config:',
      "    provider: 'deepseek-official'",
      "    model: 'deepseek-flash'",
      '',
    ].join('\n'),
  )
})

test('includes reasoningEffort only when it is a non-empty value', () => {
  const withEffort = renderModelOverridePatch({
    provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high',
  })
  assert.match(withEffort, /^ {4}reasoningEffort: 'high'$/m)

  for (const effort of [undefined, null, '', '   ']) {
    const text = renderModelOverridePatch({ provider: 'p', model: 'm', reasoningEffort: effort })
    assert.doesNotMatch(text, /reasoningEffort/, `effort=${JSON.stringify(effort)} 不应产出该行`)
  }
})

test('quotes scalars so YAML-significant characters stay literal', () => {
  const text = renderModelOverridePatch({ provider: "we'ird: #p", model: 'm: #x' })
  assert.match(text, /^ {4}provider: 'we''ird: #p'$/m)
  assert.match(text, /^ {4}model: 'm: #x'$/m)
})

test('rejects an empty provider or model instead of writing a broken patch', () => {
  for (const bad of [{ provider: '', model: 'm' }, { provider: 'p', model: '  ' }, {}, null]) {
    assert.throws(() => renderModelOverridePatch(bad), /must be a non-empty string/)
  }
})

test('REGRESSION: the removed settings.yaml form must never come back', () => {
  const text = renderModelOverridePatch({ provider: 'deepseek-official', model: 'deepseek-flash' })
  // 旧形状：patch 指向一个 settings.yaml 副本。harness 已移除该文件 ⇒ 该形状必然失效。
  assert.doesNotMatch(text, /id:\s*settings\b/, '不得再生成 `- id: settings`')
  assert.doesNotMatch(text, /path:/, '不得再生成 settings path 重定向')
  assert.doesNotMatch(text, /settings\.yaml/, '不得再依赖已移除的 settings.yaml')
  // 正确形状的必要锚点
  assert.match(text, /^- id: agent-default-model$/m)
  assert.match(text, /^ {4}provider: /m)
  assert.match(text, /^ {4}model: /m)
})
