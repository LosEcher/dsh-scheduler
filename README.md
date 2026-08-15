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
  "workspace": "/Users/echerlos/syncthing/project/dsfolder",  // headless 运行 cwd
  "enabled": true,
  "state": "scheduled",             // scheduled | paused | completed(once 已触发)
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
  "sessionDir": "...", "startedAt": "...", "completedAt": "..." }
```

### 2.3 调度循环

- `tick()`（60s 周期 + 每次任务变更后立即重算）：对每个 `enabled && nextRunAt <= now` 的任务：
  - 并发已达上限 → 记一条 `skipped` 台账，`nextRunAt` 顺延到下一次（不追赶）；
  - 否则 spawn 执行，`nextRunAt` 重算（cron → 下一次匹配；interval → now + every；once → null + state=completed）；
- 精确唤醒：arm `setTimeout` 到最早 `nextRunAt`（max 2^31-1 ms 分段），唤醒后重新 tick；
- `.tick.lock`：mkdir 原子获取，web 重启交叠期间防双触发；异常退出遗留锁由 mtime 超时回收；
- 过期任务（web 停机期间错过触发）策略：**run_once 追赶**（hermes/los 默认同款），tick 时 `nextRunAt <= now` 即视为到期执行一次。

### 2.4 执行（executor）

```
spawn(process.execPath,
  ['--import', <harness>/node_modules/tsx/esm, <harness>/apps/cli/src/bin.ts,
   '--profile', 'headless', prompt],
  { cwd: job.workspace, env: {...process.env, DSH_HOME}, timeout: jobTimeoutMs })
```

- 优先用 `apps/cli/lib/bin.js`（若已构建，免 tsx），否则走 tsx 源码入口；
- 超时（默认 30min，可配）→ kill → 台账记 `failed` + `error: timeout`；
- 输出捕获：stdout/stderr 合并尾部 8KB 入台账 `outputHead`；
- 退出码 0 → `succeeded`，非 0 → `failed`（连续失败计数供 UI 提示）；
- `harnessDir` 配置：env `DSH_HARNESS_DIR` → 默认 `/Users/echerlos/Downloads/projects/deepseek-harness`。

### 2.5 REST API（同源 /scheduler）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/scheduler/status` | 运行时状态（tick、锁、在飞任务、任务数） |
| GET | `/scheduler/jobs` | 任务列表 |
| POST | `/scheduler/jobs` | 创建任务（校验 + 重算 nextRunAt） |
| GET | `/scheduler/jobs/:id` | 单个任务 |
| PATCH | `/scheduler/jobs/:id` | 更新（name/prompt/trigger/workspace/enabled） |
| DELETE | `/scheduler/jobs/:id` | 删除（含台账） |
| POST | `/scheduler/jobs/:id/trigger` | 手动触发一次（triggerKind=manual） |
| POST | `/scheduler/jobs/:id/pause` / `/resume` | 暂停 / 恢复 |
| GET | `/scheduler/jobs/:id/runs?limit=` | 运行台账 |
| GET | `/scheduler/preview?kind=&expression=&timezone=&n=` | 触发预览（未来 n 次） |

### 2.6 管理页面（client 半包）

- 注册 `conversation.view` slot（id=`scheduler`，label=`定时任务`，order 96）；
- 功能：运行时状态条 / 任务列表（下次触发、上次状态、运行次数、操作）/ 新建+编辑表单（触发预设：cron 表达式 / 间隔 / 一次性 + 时区 + 工作区 + 实时「未来 5 次触发」预览）/ 手动触发 / 暂停恢复 / 删除 / 运行台账（状态、耗时、退出码、输出尾部可展开）。

## 三、安装

```bash
# 1. 注册 bundle（link: 指向本仓库）
dsh plugin --profile web add link:/Users/echerlos/syncthing/project/dsplugins/dsh-scheduler
# 2. 重启 dsh web（宿主插件代码 HMR 不覆盖，必须重启）
dsh-web-restart.sh
# 3. 验证
curl -s http://127.0.0.1:3080/scheduler/status
```

> 客户端半包改动（src/client/*）需要 `pnpm run dev:web` 的 client-hmr 或重启后重新构建 `node scripts/build.mjs`。

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

## 四、边界与后续

- v1 执行面为 headless 进程：每次运行约 5s 启动成本、无 web 会话内的可见性（台账承载结果）；
- 后续可选：`deliverTo`（结果投递到指定会话/IM）、cron 表达式描述、每任务模型/提供方覆盖、审批策略（los 同款）、systemd/launchd 平台调度器（cantool 同款）。
