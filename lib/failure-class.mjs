// 失败归因：把「这次 run 为什么失败」变成台账里的一个字段。
//
// 为什么需要它（2026-10-26 台账实测，非推测）：
//   5000 行 runs.jsonl / 518 条 finish 里，96 条失败中有 **39 条**（27 条
//   「[attempt N/N] retrying in Ns」+ 12 条「[attempt N/N] gave up」）的 error
//   字段**只有重试簿记、没有根因** —— 因为非零退出分支调用 finish 时没带 error
//   （`finish({ status:'failed', exitCode: code })`），根因只在被 `tail()` 截断的
//   output 里，而 output 不进台账的错误字段。于是「失败原因」只能靠人工考古。
//
// 设计约束（都是为了不制造第二类假象）：
//   ① **纯函数**：不读 env、不读文件、不发网络 —— 可单测、可在离线回放台账时复用
//      （本项目正是用它把历史失败重新归因）。
//   ② **只在「错误码位置」匹配**，不扫自由文本：harness/网关的失败是以
//      `MISSING_CREDENTIAL: …` 这样的 **行首大写码** 出现的；正文里讨论这些词
//      （报告的标题、被引用的报错样例）不该被当成"这次失败的原因"。
//      这条是负向控制的直接产物（test/failure-class.test.mjs）。
//   ③ **不认识就 unknown，不猜**：未知形状宁可 unknown（可被筛出来人工看），
//      也不要塞进一个看起来像分类的桶里。
//   ④ 分类**不改变成败**：status 仍由退出码/断言决定；kind 只解释它。

/** 归因类别（新增类别必须同时补 test/failure-class.test.mjs 的用例）。 */
export const FAILURE_KINDS = [
  'missing_credential',      // 环境：缺凭据（可修复，重试无用）
  'context_window_exceeded', // 配置：上下文窗不够（可修复，重试无用）
  'transport',               // 上游/网络：传输失败（可重试）
  'timeout',                 // 预算：本 run 超时被杀（见 budget 契约）
  'assert_failed',           // 任务：机械验收（job.assertCmd）不过
  'delivery_missing',        // 交付：该发而没发
  'delivery_duplicate',      // 交付：同一键发了多条
  'delivery_stray',          // 交付：写了别的键
  'spawn_error',             // 环境：起不来子进程
  'exit_nonzero',            // 兜底：非零退出，无更具体证据
  'unknown',                 // 判不了
]

/**
 * 「环境/配置类」归因：**重试无意义**（重试只是再烧一次 run 预算与失败链），
 * 而且不该计入作业自身的连续失败（它不是任务写错了，是机器没准备好）。
 * 但**必须仍然告警**——静默容忍配置故障比误报失败更危险。
 */
export const ENVIRONMENT_KINDS = new Set(['missing_credential', 'context_window_exceeded', 'spawn_error'])

/** 行首「错误码」形态：`MISSING_CREDENTIAL: …` / `TRANSPORT: …` 等。 */
const CODE_LINE = /^[ \t]*(MISSING_CREDENTIAL|CONTEXT_WINDOW_EXCEEDED|TRANSPORT|AUTH|MODEL_UNAVAILABLE)\b.*$/im

const RULES = [
  // 环境/配置（优先级最高：它们是"根本没跑起来"，不是任务结论）
  [/^[ \t]*MISSING_CREDENTIAL\b/im, 'missing_credential'],
  [/\bno\s+api\s+key\s+for\s+provider\s+route\b/i, 'missing_credential'],
  [/\bno\s+credential\s+for\s+provider\s+route\b/i, 'missing_credential'],
  [/^[ \t]*CONTEXT_WINDOW_EXCEEDED\b/im, 'context_window_exceeded'],
  [/\bcontext\s+window\s+(?:exceeded|overflow)\b/i, 'context_window_exceeded'],
  [/\bmaximum\s+context\s+length\b/i, 'context_window_exceeded'],
  [/^[ \t]*TRANSPORT\b/im, 'transport'],
  [/\btransport\s+failed\b/i, 'transport'],
  [/\b(?:ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN)\b/, 'transport'],
  [/\bsocket\s+hang\s+up\b/i, 'transport'],
  [/\bfetch\s+failed\b/i, 'transport'],
  // 预算
  [/\btimed?\s*out\s+after\s+\d+\s*(?:s|ms)\b/i, 'timeout'],
  [/^[ \t]*spawn:/im, 'spawn_error'],
  [/^[ \t]*assert\s+failed\b/im, 'assert_failed'],
]

/**
 * 从一次失败 run 的证据里判归因。
 *
 * @param {object} input
 * @param {string} [input.error]    finish 记下的错误字符串（最高优先级证据）
 * @param {string} [input.output]   子进程输出尾部（可能已被 tail 截断）
 * @param {boolean} [input.timedOut] 是否由超时逻辑杀掉的
 * @param {boolean} [input.assertFailed] 是否断言失败
 * @param {boolean} [input.deliveryMissing]
 * @param {boolean} [input.deliveryDuplicate]
 * @param {boolean} [input.deliveryStray]
 * @param {number} [input.exitCode]
 * @returns {string} FAILURE_KINDS 之一
 */
export function classifyFailure(input = {}) {
  const {
    error = '', output = '', timedOut = false, assertFailed = false,
    deliveryMissing = false, deliveryDuplicate = false, deliveryStray = false, exitCode,
  } = input || {}

  // 显式布尔证据优先（它们由代码路径决定，不是从文本猜的）
  if (timedOut) return 'timeout'
  if (assertFailed) return 'assert_failed'
  if (deliveryDuplicate) return 'delivery_duplicate'
  if (deliveryStray) return 'delivery_stray'
  if (deliveryMissing) return 'delivery_missing'

  // 文本证据：先看 error（scheduler 自己写的），再看 output 的**行首错误码**。
  // 正文里出现的词不算（例如报告正文写着「上次报 MISSING_CREDENTIAL」）。
  for (const [re, kind] of RULES) {
    if (re.test(error)) return kind
  }
  if (output) {
    for (const [re, kind] of RULES) {
      // 只对「行首码」类规则扫 output；其余宽匹配留在 error 上，避免正文误伤。
      if (re.source.startsWith('^') && re.test(output)) return kind
    }
    // output 里有错误码行但 RULES 没覆盖 ⇒ 仍是 unknown，不猜
    if (CODE_LINE.test(output)) return 'unknown'
  }

  if (typeof exitCode === 'number' && exitCode !== 0) return 'exit_nonzero'
  return 'unknown'
}

/** 归因是否属于「环境/配置类」（重试无意义、不计入作业失败链）。 */
export function isEnvironmentFailure(kind) {
  return ENVIRONMENT_KINDS.has(kind)
}

/** 一行人类可读的解释（告警/日报用；不含具体路径与凭据）。 */
export function describeFailureKind(kind) {
  switch (kind) {
    case 'missing_credential': return '缺凭据（环境问题：重试无用，需要补 key）'
    case 'context_window_exceeded': return '上下文超窗（配置问题：需要调窗口或压缩）'
    case 'transport': return '传输失败（上游/网络，可重试）'
    case 'timeout': return '超出本 run 预算被杀'
    case 'assert_failed': return '机械验收不过（assertCmd）'
    case 'delivery_missing': return '该投递而未投递'
    case 'delivery_duplicate': return '同一交付键发出多条'
    case 'delivery_stray': return '写入了别的交付键'
    case 'spawn_error': return '子进程起不来（环境问题）'
    case 'exit_nonzero': return '非零退出（没有更具体的证据）'
    default: return '判不了（unknown）'
  }
}

/**
 * 已知 route → 凭据环境变量（**显式白名单**，不按名字猜）。
 *
 * 为什么必须白名单：headless profile 按设计禁用 credentials 存储，只认启动时的
 * `process.env`，所以「env 里没有」确实能推出「这条 route 起不来」。但对**不认识**
 * 的 provider 我们不知道它读哪个变量 ⇒ 返回 null（fail-open：照常跑，失败了由
 * classifyFailure 记 missing_credential），绝不因为"名字里没找到 KEY"就跳过作业。
 */
export const ROUTE_CREDENTIAL_ENV = {
  'deepseek-official': ['DEEPSEEK_API_KEY'],
  los: ['LOS_AUTH_TOKEN'],
  'opencode-zen': ['OPENCODE_ZEN_API_KEY', 'OPENCODE_API_KEY'],
  openrouter: ['OPENROUTER_API_KEY'],
  zenmux: ['ZENMUX_OAUTH_ACCESS_TOKEN'],
  packycode: ['PACKYCODE_API_KEY', 'PACKYCODE_TOKEN'],
}

/**
 * 若 route 属于已知白名单且其凭据环境变量全部缺失，返回 {provider, envVars}；
 * 否则 null（含 unknown provider、无 model 声明、凭据在场三种情况）。
 *
 * @param {{provider?: string}|null|undefined} model  本次 attempt 实际使用的 route
 * @param {Record<string,string|undefined>} env       进程环境（显式传入以便单测）
 */
export function missingCredential(model, env = {}) {
  const provider = model?.provider
  if (!provider || typeof provider !== 'string') return null
  const envVars = ROUTE_CREDENTIAL_ENV[provider]
  if (!envVars) return null
  const present = envVars.some((k) => typeof env[k] === 'string' && env[k].trim() !== '')
  return present ? null : { provider, envVars }
}
