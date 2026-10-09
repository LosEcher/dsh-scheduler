/**
 * dsh-scheduler per-run model override — patch 正文的**唯一**生成点。
 *
 * 为什么是这个形状（2026-10-09 修）：旧实现改写 `$DSH_HOME/settings.yaml`
 * 并生成 `- id: settings / config: { path: ... }`。那两半在当前 harness 里
 * **都已不存在**：
 *
 *   1. `settings.yaml` 已被**移除**——harness 只在启动时把它导入 profile 一次，
 *      随后重命名为 `settings.yaml.imported`
 *      （见 packages/settings/settings/src/index.ts 的 importLegacyDocument）。
 *      于是升级后的机器上该文件不存在 ⇒ 旧函数第一行 `if (!existsSync(src)) return null`
 *      ⇒ **每个作业的 model 覆盖（含 fallback 链）静默失效**，但日志里
 *      "model override <p>/<m>" 只在拿到 patch 时才打印，所以失效是无声的。
 *   2. 受支持的覆盖形式是 **id-targeted config override**：base bundle 声明该条目
 *      （packages/bundle/base/cordis.patch.yml 的 agent-default-model），
 *      desktop / acp-server 两个 profile 就是用这种形式覆盖它的。
 *
 * 实测（零模型成本）：把本函数产物交给
 *   `dsh --profile headless --patch <file> --dump-config`
 * 组合树里 `agent-default-model` 的 provider/model 会变成覆盖值（exit 0）。
 */

/** 被覆盖的组合条目 id（base bundle 声明，profile patch 覆盖）。 */
export const MODEL_OVERRIDE_ENTRY_ID = 'agent-default-model'

/** 条目名（patch 里带上 name，与 desktop / acp-server profile 的写法一致）。 */
export const MODEL_OVERRIDE_ENTRY_NAME = '@deepseek-ai/dsh-agent-default-model'

/**
 * 把任意值渲染成单引号 YAML 标量（内部的 `'` 按 YAML 规则双写）。
 * 不用裸标量：provider/model 里出现 `:`、`#`、前导空白等字符时裸标量会改变语义。
 */
function yamlScalar(value, field) {
  const text = String(value ?? '').trim()
  if (text === '') throw new Error(`model override: ${field} must be a non-empty string`)
  return `'${text.replace(/'/g, "''")}'`
}

/**
 * 生成 per-run model override 的 patch 正文。
 * @param model - `{ provider, model, reasoningEffort? }`（scheduler job.model 的形态）
 * @returns patch 文件的完整文本（以换行结尾）
 * @throws provider/model 为空时抛错；调用方负责降级为"用默认模型"
 */
export function renderModelOverridePatch(model) {
  const lines = [
    '# dsh-scheduler per-run model override (generated; do not edit)',
    `- id: ${MODEL_OVERRIDE_ENTRY_ID}`,
    `  name: '${MODEL_OVERRIDE_ENTRY_NAME}'`,
    '  config:',
    `    provider: ${yamlScalar(model?.provider, 'provider')}`,
    `    model: ${yamlScalar(model?.model, 'model')}`,
  ]
  const effort = model?.reasoningEffort
  if (effort !== undefined && effort !== null && String(effort).trim() !== '') {
    lines.push(`    reasoningEffort: ${yamlScalar(effort, 'reasoningEffort')}`)
  }
  return `${lines.join('\n')}\n`
}
