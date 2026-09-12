# dsh-scheduler — DSH 定时任务插件

DSH 的定时任务（cron / interval / once）插件：宿主半包负责**持久化任务定义、调度、执行与运行台账**，客户端半包在会话内提供**「定时任务」管理页**（列表 / 新建 / 触发 / 暂停 / 运行历史）。

## 一、调研结论：为什么需要这个插件

### 1.1 DSH 现状（2026-08-15 核查）

DSH 内置 `@deepseek-ai/dsh-schedule`（`packages/schedule/schedule`），它是**会话级 reminder**：

- 事件溯源：`schedule/change` 事件写进会话日志，`ScheduleRuntime` 折叠事件 + `setTimeout` 派生唤醒；
- 三种触发器：`after_seconds` / `at` / `every_seconds`（固定间隔，非 cron 表达式）；
- 到期行为：`agent.followup(createUserMessage(...))` —— 只向**当前活着的根 agent 会话**注入一条提醒消息；
- 工具面：`schedule_create` / `schedule_list` / `schedule_delete`；
- 无跨会话执行、无 cron 表达式、无任务定义持久化（定义随会话日志）、无运行台账、无管理页面。

**结论**：DSH 有「定时提醒」，没有「定时任务」——后者需要：跨会话/独立执行面、cron 语法、可管理的任务定义存储、运行记录与重试、管理 UI。这就是 dsh-scheduler 的定位。

### 1.2 参照实现对比

| 维度 | los scheduled-work | cantool device-jobs | hermes cron | codex（Automations / codex-cron-skill） | **dsh-scheduler（本插件）** |
|---|---|---|---|---|---|
| 触发 | cron / interval / once | daily 本地时间 / weekly / interval | 相对延时 / interval / cron / ISO | cron / interval / once（--at） | cron / interval / once |
| 存储 | 服务端数据库 | 文件 store（definitions/grants/runs/locks/logs，原子写） | `~/.hermes/cron/jobs.json` 原子写 | `.codex/` 状态目录 + runs jsonl | `~/.dsh/storages/dsh-scheduler/` 文件 store，原子写 |
| 调度循环 | 服务端调度器 | launchd 平台调度（reconcile 漂移修复） | 60s tick + 文件锁 | daemon + 单 runner 锁（mkdir CAS） | 60s tick + 精确唤醒 timer + mkdir 锁 |
| 执行模型 | 独立 task run（会话事件、run contract、heartbeat、去重键） | launchd 拉起 `runner` 子进程 | 每次运行开**全新 agent 会话**（自包含 prompt） | `codex exec` 全新运行 / tmux 注入 | `dsh --profile headless` **全新进程**，cwd=任务工作区 |
| 治理 | 审批策略 / 并发策略 / 追赶策略 / 熔断 / 尝试次数 | Cleanup 类 handler 需审批+隔离区 | repeat 次数 / pause-resume / [SILENT] 静默标记 | 默认拒绝沙箱降级 allowlist | 并发上限 / 运行超时 / 失败连续计数 / pause-resume / trigger-now |
| 管理 UI | schedules-page（预设表单 + 触发预览 + 台账） | CanTool 前端 device-jobs 面板 | CLI `hermes cron` + 聊天内 `cronjob` 工具 | CLI / 官方 App | **会话内「定时任务」tab**（conversation.view slot） |

设计要点借鉴：

- **hermes**：任务定义 JSON 原子持久化、每次运行开全新会话且 prompt 必须自包含、运行台账 + last_status、`run`（手动触发）动作、[SILENT] 静默约定；
- **los**：trigger 预览（下次触发时间）、运行状态机（queued/running/succeeded/failed/skipped）、trigger-now、失败连续计数、时间戳台账；
- **cantool**：文件 store 分目录（definitions/runs/locks）、原子写、任务校验、手动触发；
- **codex**：执行安全默认——定时任务跑在 headless 独立进程，天然不继承交互会话的权限上下文；runs 逐条落盘不截断。

### 1.3 DSH 插件技术底座（复用已验证机制）

- **宿主半包**：cordis 函数插件，`inject: ['webServer']`，`ctx.webServer.register({ kind: 'prefix', path: '/scheduler', handler })` 挂同源 API（同 dsh-health-panel 已验证模式）；
- **客户端半包**：`dsh.client.inject: ['@deepseek-ai/dsh-client-runtime']`，`ctx.slots.inject('conversation.view', ...)` 注册会话 tab（同 dsh-health-panel）；
- **执行面**：`dsh --profile headless "<prompt>"`（`node --import tsx/esm apps/cli/src/bin.ts`）——独立进程、无端口、免疫 web 重启、会话落盘共享 `~/.dsh/sessions`（按 cwd 隔离工作区）。每次运行 = hermes 的「全新会话」模式。

## 二、架构

```
┌─ web 宿主进程（dsh web）───────────────────────────────┐
│  dsh-scheduler (host 半包, index.mjs)                    │
│  ├─ store:  ~/.dsh/storages/dsh-scheduler/               │
│  │    jobs.json   （任务定义，原子写 tmp+rename）          │
│  │    runs.jsonl  （运行台账，append，上限裁剪）           │
│  │    .tick.lock  （mkdir 单实例锁，防重复触发）           │
│  ├─ ticker: 60s 周期 + 最近 nextRunAt 精确唤醒            │
│  ├─ executor: spawn headless 子进程（cwd=任务工作区）      │
│  │    stdout/stderr 尾部捕获 → runs.jsonl                 │
│  └─ REST API: GET/POST/PATCH/DELETE /scheduler/...       │
└──────────────────────────────────────────────────────────┘
        │ spawn (每次运行一个独立进程)
        ▼
┌─ dsh --profile headless（cwd = 任务 workspace）──────────┐
│  全新 agent 会话：执行任务 prompt，结果打印 stdout 后退出  │
│  会话落盘 ~/.dsh/sessions/<workspace>/                    │
└──────────────────────────────────────────────────────────┘
        ▲
┌─ 浏览器（管理页，client 半包）───────────────────────────┐
│  会话「定时任务」tab → fetch /scheduler/*                │
│  列表 / 新建（触发预览）/ 触发 / 暂停 / 历史              │
└──────────────────────────────────────────────────────────┘
```

### 2.1 任务模型（jobs.json）

```jsonc
{
  "id": "job-3f9a...",              // 稳定 id
  "name": "每日 CI 巡检",
  "prompt": "检查 CI 状态并汇总",     // 自包含 prompt（headless 全新会话，无上下文）
  "trigger": { "kind": "cron", "expression": "0 9 * * 1-5", "timezone": "Asia/Shanghai" },
  // kind: cron | interval | once
  // cron:   5 段 cron（支持 */n、a-b、a,b、月份/星期名）
  // interval: expression = "30m" / "2h" / "90s"（最小 60s）
  // once:   expression = ISO 8601 时间戳
  "workspace": "/path/to/job/workspace",  // headless 运行 cwd
  "enabled": true,
  "state": "scheduled",             // scheduled | paused | completed(once 已触发)
  "deliverTo": { "sessionId": "session-..." },  // 可选：运行结果 followup 进该会话（须在线）
  "catchUpPolicy": "run_once",      // 可选：'run_once'(错过补跑) | 'skip'(超时差跳过)；缺省跟随全局
  "pausedReason": null,             // 熔断自动暂停时 = 'max_consecutive_failures'
  "nextRunAt": "2026-08-16T01:00:00.000Z",
  "lastRunAt": null,
  "lastStatus": null,               // succeeded | failed | skipped
  "runCount": 0,
  "consecutiveFailures": 0,
  "createdAt": "...", "updatedAt": "..."
}
```

### 2.2 运行台账（runs.jsonl，每行一个 Run）

```jsonc
{ "id": "run-...", "jobId": "job-...", "triggerKind": "scheduled" | "manual",
  "scheduledFor": "...", "status": "queued"|"running"|"succeeded"|"failed"|"skipped"|"cancelled",
  "exitCode": 0, "durationMs": 1234, "outputHead": "...(尾部 8KB)",
  "dispatchLatencyMs": 41234,
  "assertExitCode": 0,
  "delivery": { "status": "delivered"|"skipped"|"error", "sessionId": "...", "reason": "..." },
  "sessionDir": "...", "startedAt": "...", "completedAt": "..." }
```

- `dispatchLatencyMs`（2026-09-12 审计新增）：实际派发时刻 − 计划时刻。宿主睡眠/阻塞会让 cron 任务迟到几十
  分钟（macOS Clamshell Sleep 把 Node 定时器顺延到下一个 dark wake，实测 08:30 的任务有 9 次落在
  08:48–09:00）。迟到 >5min 会打 `[dsh-scheduler] ... dispatched Nmin late` 警告日志；`/scheduler/status`
  暴露每任务 `lastDispatchLatencyMs`。
- `assertExitCode` / `assertFailed`（2026-09-12 审计新增）：见 §2.4 的机械验收断言。
- **台账轮转**：`maxRuns`（默认 5000）行以内原地保留；超过 `rotateBytes`（2MB）时把最旧的若干行**归档**到
  `archive/runs-<YYYY-MM>.jsonl`（按月分片，按行内 `startedAt`/`scheduledFor` 归月），**不再直接丢弃**。
  旧版硬编码 `maxRuns=500` 会在轮转时丢掉约 90% 历史，使审计无法回溯。

### 2.3 调度循环

- `tick()`（60s 周期 + 每次任务变更后立即重算）：对每个 `enabled && nextRunAt <= now` 的任务：
  - 先过**追赶策略**（`decideCatchUp`，纯函数）：`run_once`（默认）→ 无论迟到多久补跑一次；`skip` → 迟到超过 `maxLatenessMs`（默认 15min，0=不限）则跳过本次并重算 nextRunAt，台账记 `skipped`；
  - 并发已达上限 → 记一条 `skipped` 台账，`nextRunAt` 顺延到下一次（不追赶）；
  - 否则 spawn 执行，`nextRunAt` 重算（cron → 下一次匹配；interval → now + every；once → null + state=completed）；
- 精确唤醒：arm `setTimeout` 到最早 `nextRunAt`（max 2^31-1 ms 分段），唤醒后重新 tick；
- `.tick.lock`：mkdir 原子获取，web 重启交叠期间防双触发；异常退出遗留锁由 mtime 超时回收。

### 2.4 执行（executor）

```
spawn(process.execPath,
  ['--import', <harness>/node_modules/tsx/esm, <harness>/apps/cli/src/bin.ts,
   '--profile', 'headless', prompt],
  { cwd: job.workspace, env: process.env })
```

- 优先用 `apps/cli/lib/bin.js`（若已构建，免 tsx），否则走 tsx 源码入口；
- **超时升级**：`timeoutMs`（默认 30min）到点发 SIGTERM，再等 `killGraceMs`（默认 10s）仍不退则 SIGKILL；台账记 `failed` + `error: timeout after Ns`；
- 输出捕获：stdout/stderr 合并尾部 8KB 入台账 `outputHead`；
- 退出码 0 → `succeeded`，非 0 → `failed`；
- **机械验收断言（job.assertCmd，2026-09-12 审计新增）**：`exitCode=0` 只说明 headless 进程干净退出，
  **不等于任务达成**（实证：feed 任务连续 15 次"成功"运行产出为零）。可选字段 `assertCmd`（shell 片段）
  在进程干净退出后由 `/bin/bash -lc` 在任务 workspace 内执行（超时 `assertTimeoutMs`，默认 60s）：
  非零 ⇒ 该次 run 记 `failed` + `assertFailed: true` + `assertExitCode`，`error` 前缀 `assert failed (exit N):`。
  断言失败是**确定性失败，不重试**（重试只会重复副作用，例如已发出的通知），但计入连续失败计数并触发告警/熔断。
  `null` 清除该字段（清除必须先于 `{...existing}` 展开，否则会被复活）。示例（要求当日产物存在、非空、新鲜）：

  ```jsonc
  "assertCmd": "f=\"$HOME/.dsh/scheduler-reports/los-governance-daily-$(date +%Y%m%d).md\"\n[ -s \"$f\" ] || { echo \"missing: $f\"; exit 1; }\n[ -n \"$(find \"$f\" -mmin -90)\" ] || { echo \"stale: $f\"; exit 1; }\necho ok: $f"
  ```
- **熔断**：连续失败达到 `maxConsecutiveFailures`（默认 5）→ 自动暂停（`enabled=false, state=paused, pausedReason=max_consecutive_failures`），UI 显示「已熔断暂停」，手动恢复后重新计数；
- **自动重试（带上限）**：`maxAttempts`（默认 3，job 可覆盖 1-10）= 单次逻辑触发的总尝试次数，`retryDelayMs`（默认 60s，job 可覆盖 5s-30min）= 重试间隔。瞬时失败（网络 TRANSPORT/5xx/超时/任意非零退出）自动重试；**持续性失败不重试**（`isRetryableFailure` 识别 402/insufficient balance/quota/credit/401/403/billing/account suspended 等额度与认证类错误，重试只会浪费配额）。重试状态持久化在 job 的 `retryState`（由 tick 驱动，web 重启不丢、等待期不会重复触发）；每次尝试记一条 run（带 `attempt` 序号），重试中失败不递增熔断计数、不投递，最终结果才走 `applyRunResult` 与投递；耗尽上限仍失败则 run 标注 `gave up`；
- **调度抖动（dispatch jitter，0.3.0）**：全局 `dispatchJitterMaxMs`（默认 180s，0 禁用）让每个定时任务在 cron 时刻后随机延迟 0-max 毫秒再执行——任务不再精确整点触发、彼此错开、避免与外部整点调度（如采集后端的 :00/:30 定时 run）撞车；单任务可用 `trigger.jitterMaxMs` 覆盖（0 即该任务不抖动）。手动触发与失败重试不走抖动（保持响应性）。
- **每任务模型链（job.model，0.3.0）**：`model: {provider, model, reasoningEffort?, fallback?: [{provider, model, ...}]}` 让任务用指定模型执行（headless 经临时 settings 副本 + settings-file patch 注入，run 结束即清理）。`fallback` 为有序模型链：attempt 1 用主模型，后续 attempt 用 fallback 最后一项（切过去不再回来）——免费渠道（如 opencode-zen/hy3-free）做主渠道、付费渠道（deepseek-official）做兜底，免费渠道瞬态失败自动落到付费重试。未声明 model 的任务沿用 headless 默认模型。
- **结果投递**：任务配置 `deliverTo.sessionId` 时，运行结束后把结果摘要（renderDelivery）以 `createUserMessage` + `agent.followup` 注入该会话（须是本 web 实例的 live root agent）；目标不在线则台账记 `delivery.skipped`；
- `harnessDir` 配置：可选；缺省自动发现 dsh CLI（env `DSH_HARNESS_DIR` → `~/.dsh/source/current` → profile 安装 `~/.dsh/profiles/node_modules/@deepseek-ai/dsh` → 报错提示）；`defaultWorkspace` 兜底为 `homedir()`（env `DSH_SCHEDULER_WORKSPACE` 优先）。

### 2.5 REST API（同源 /scheduler）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/scheduler/status` | 运行时状态（tick、锁、在飞任务、熔断/追赶配置） |
| GET | `/scheduler/jobs` | 任务列表 |
| POST | `/scheduler/jobs` | 创建任务（校验 + 重算 nextRunAt） |
| GET | `/scheduler/jobs/:id` | 单个任务 |
| PATCH | `/scheduler/jobs/:id` | 更新（name/prompt/trigger/workspace/enabled/deliverTo/catchUpPolicy/maxAttempts/retryDelayMs/model） |
| DELETE | `/scheduler/jobs/:id` | 删除（含台账） |
| POST | `/scheduler/jobs/:id/trigger` | 手动触发一次（triggerKind=manual） |
| POST | `/scheduler/jobs/:id/pause` / `/resume` | 暂停 / 恢复 |
| GET | `/scheduler/jobs/:id/runs?limit=` | 运行台账 |
| GET | `/scheduler/preview?kind=&expression=&timezone=&n=` | 触发预览（未来 n 次） |

### 2.6 管理页面（client 半包）

- 注册 `conversation.view` slot（id=`scheduler`，label=`定时任务`，order 96）；
- 功能：运行时状态条（tick/在飞/任务数/**熔断阈值/追赶策略**）/ 任务列表（下次触发、上次状态、投递目标、运行次数、**熔断暂停标记**、操作）/ 新建+编辑表单（触发预设：cron / 间隔 / 一次性 + 时区 + 工作区 + **deliverTo 会话** + **追赶策略** + 实时「未来 5 次触发」预览）/ 手动触发 / 暂停恢复 / 删除 / 运行台账（状态、耗时、退出码、**投递状态徽标**、输出尾部可展开）。

### 2.7 运行日志

宿主 `ctx.logger` 打点（web 日志 `~/.dsh/logs/dsh-web.log`，前缀 `[dsh-scheduler]`）：
启动配置摘要（info）/ 每次 fire（info，含 run id）/ 每次 finish（info，状态+耗时+投递结果）/ 超时与 SIGKILL 升级（warn）/ 熔断自动暂停（warn）/ 投递跳过或失败（warn）。

## 三、安装

```bash
# 1. 注册 bundle
dsh plugin --profile web add github:LosEcher/dsh-scheduler#main
# 2. 重启 dsh web（宿主插件代码 HMR 不覆盖，必须重启）
~/.dsh/scripts/dsh-web-restart.sh
# 3. 验证
curl -s http://127.0.0.1:3080/scheduler/status
```

本地开发（改源码时）：

```bash
dsh plugin --profile web add link:/path/to/dsh-scheduler
```

> 客户端半包改动（src/client/*）需要 `node scripts/build.mjs` 重建 `lib/client.js` 后刷新页面；宿主改动必须重启 dsh web。

## 三·五、配置与常见坑（2026-08-15 事故复盘）

**事故**：v0.1 的 `Config` 把 env 派生默认值写成了
`schemastery .default(() => ...)` 工厂函数。schemastery 的 `.default(value)` **原样存储参数**
（只吃字面量，不调用函数），bundle patch 里 `config: {}` 一走默认值，Cordis 按 string 校验直接抛：

```
failed to apply loader entry dsh-scheduler:
  $.dataDir expected string but got () => `${process.env.DSH_HOME ?? ...}`
```

配置树组合失败 → 整棵 web 插件树起不来（热重载直接命中；daemon 重启有 `--dump-config` preflight 兜底）。

**规避规则（DSH 插件开发通用）**：

1. **`.default()` 只放字面量**（数字如 `Schema.number().default(60_000)` 是安全的，见 harness
   `retry-policy.ts`）；**env/运行时派生值一律不在 Schema 里默认**。
2. 采用 harness 第一方约定（`settings-file`：*"defaulting happens here, never inline"*）：
   Schema 字符串字段留空（可选），在 `apply(ctx, config)` 里用 `resolveConfig(config)` 做
   `config.x ?? process.env.Y ?? 字面量` 的运行时解析（本插件 `index.mjs` 的 `resolveConfig()` 即此模式）。
3. **改插件后先跑 daemon 同款 preflight**：`pnpm dsh --profile web --dump-config`，任何 schema
   错误在这里就会暴露，而不是等热重载把整棵树拉起来。
4. 新增 bundle 行的 `config: {}` 意味着**所有字段默认值都会被实际使用**——默认值必须是合法字面量。

**插件内 import `@deepseek-ai/*` 的解析坑**：宿主 loader 以 profile 目录为解析基座，profile
node_modules 里只有 `@deepseek-ai/cordis` / `schemastery` 等少量包；dsplugins 里的插件若要
import 其他 `@deepseek-ai/*`（如本插件的 `@deepseek-ai/dsh-llm` 取 `createUserMessage`），
需在插件目录建 `node_modules/@deepseek-ai/<pkg>` 符号链接指向 harness 对应包
（`packages/llm/llm` 等，dsh-channel-wechat 同款做法；链接已入 .gitignore 不进仓库）。
判断依赖是否可解析：`node -e "import('@deepseek-ai/<pkg>')"` 在插件目录直接验证。

## 四、边界与后续

- v1 执行面为 headless 进程：每次运行约 5s 启动成本、无 web 会话内的可见性（台账 + deliverTo 承载结果）；
- 后续可选：deliverTo 扩展 IM 渠道投递（对接 channel 插件）、cron 表达式描述、每任务模型/提供方覆盖、审批策略（los 同款）、systemd/launchd 平台调度器（cantool 同款）。
