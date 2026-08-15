# los 定时任务 → DSH 迁移/监督/协作分析

> 2026-08-15 基于三份证据：los console `#schedules` 页面实测（WebBridge 借用标签）、
> `GET /scheduled-work-items` API 全量 29 条（`LOS_AUTH_TOKEN` 认证已验证可达）、
> los 源码（`packages/web/src/api/types-scheduled-work.ts`、`schedules-page.tsx`、
> `packages/agent/src/scheduler/*`）。

## 0. los 定时任务全景（实测）

**页面**：总数 8 / 启用 7 / 断路 0；状态筛选（活跃/全部/启用/暂停/退役）；每任务卡片显示
状态·触发(kind·expression·时区)·下次运行；详情面板：审批策略 / 审批超时 / 并发 / 补跑 /
断路器(closed·失败数) / 运行历史 100 条（状态徽标 + scheduled·尝试 N/M + run id）。

**API 全量 29 条**（7 enabled / 1 paused / 21 retired）：

| 维度 | 分布 | 说明 |
|---|---|---|
| 触发 | interval 13 / cron 7 / once 9 | 与 dsh-scheduler 三种触发同构 |
| 模板 | scheduled_execution 21 / runtime_readiness 3 / morning_inbox_digest 2 / daily_execution_digest 1 / scheduled_feed_analysis 1 / fleet_host_check 1 | 任务=模板+goalTemplate+只读工具面 |
| 审批 | preapproved_scope 22 / read_only_auto 7 | 全部只读类 |
| 并发 | 全部 skip | queue_one/parallel 未实际使用 |
| 追赶 | 全部 skip | 错过即跳过 |
| 重试 | 全部 maxAttempts=2 | 尝试 1/2 |

**7 个活跃任务三类**：①平台健康巡检（runtime readiness 15m、log freshness 30m、fleet host
6h、NAS34 drift 6h）；②数据分析（surge log error 6h、network-observe daily 09:00）；
③投递（daily execution digest WeChat 08:30）。

## 1. 可合理迁移到 dsh（dsh-scheduler 补齐，按价值排序）

| # | 能力 | los 依据 | dsh 现状 | 迁移建议 |
|---|---|---|---|---|
| 1 | **失败重试 maxAttempts** | 全部任务尝试 1/2 | 无重试，失败即记台账 | ✅ 高价值：加 `maxAttempts`（默认 2），失败自动重试（指数退避），重试 run 记 `triggerKind: retry` |
| 2 | **no_op 静默态** | 台账 100 条里大量 no op | succeeded/failed/skipped | ✅ 中价值：输出匹配 `[SILENT]`/空 → 记 `no_op`（hermes [SILENT] 同款），减少噪音 |
| 3 | **run↔业务对象关联** | run 关联 todo-xxx / workItemId | 台账无会话关联 | ✅ 中价值：run 记 headless 会话目录 `sessionDir`（README 预留字段补上），可跳转 |
| 4 | **只读模式映射** | 7 个活跃任务全部只读（read_only_auto/preapproved_scope） | 无访问模式字段 | 🟡 中价值：job 加 `toolMode: read-only/project-write/full`，执行时映射 headless 访问模式（需确认 headless CLI 支持或经 prompt/权限注入实现） |
| 5 | **断路器 half-open 试探** | circuitState closed/open/half_open | 连续失败 N 次自动暂停，手动恢复 | 🟡 中价值：恢复视为试探运行，成功即复位失败计数（低成本） |
| 6 | **任务模板预设** | 任务绑 runTemplate+goalTemplate | prompt 自包含 | 🟢 低价值：UI 表单加「常用模板」下拉（静态预设），不引入 runSpec 体系 |
| 7 | **并发 queue_one/parallel** | 定义存在但全部 skip | 全局 maxConcurrent + per-job skip | ⛔ 不迁移（YAGNI，los 自己都没用） |

**任务类型复刻**（把 los 活跃任务按类型评估）：
- ✅ **DSH 健康巡检**（对应 runtime readiness / log freshness）：dsh-health-panel 已有数据
  （插件树/排空日志/web 错误），dsh-scheduler 建「DSH 自检」任务（headless 调 /health-panel/report）
- ✅ **每日执行摘要**（对应 daily execution digest）：DSH 各会话/任务运行统计 → deliverTo 会话或 channel-wechat
- ❌ **surge log / network-observe / fleet / NAS**：数据源/资产在 los 侧（surge 代理日志、节点网格），DSH 无对应物

## 2. dsh 可以监督或者查看的（DSH 侧监督视图）

**技术路径已验证**：`LOS_AUTH_TOKEN` 在 los 仓库 `.env`（launchd 经 wrapper 读取），
`GET http://localhost:8080/scheduled-work-items` + 头 `x-los-auth-token` 返回全量 JSON。
DSH host 半包可读同一文件（同机同用户），client 半包经 `/scheduler/los/*` 同源代理展示。

- **los 调度监督看板**（高价值，立即做）：dsh-scheduler tab 加「los 监督」区块——
  任务列表（状态/触发/熔断/下次运行）+ 最近 runs + 熔断/连续失败告警徽标。
  统一工作台价值：DSH 管理页同时看到本机任务与平台任务。
- **los 网关健康探测**（低价值，顺手做）：host 内定时探测 8080（401 也算在线），
  可并入上面的看板状态条。
- **互相监督闭环**：los 的 observability 任务目前只看 los 自身；DSH 健康（3080 端点）
  可作为 los 任务新增检查项（los 监督 DSH），DSH 侧看板监督 los——双向健康。
  ⚠️ 注意：los 侧改动需要 los 仓库配合，先做 DSH→los 单向。

## 3. dsh 和 los 都需要的（分工与协作）

| 层面 | los 负责（平台级） | dsh 负责（本地级） | 协作点 |
|---|---|---|---|
| **触发** | 服务端常驻（gateway 20h+），平台/长周期任务 | web 宿主常驻（launchd），本地工作区任务 | 同一套触发语义（cron/interval/once+时区），各自实现，无共享需求 |
| **执行** | executor 网格（node34 等远端） | headless 本机进程 | **任务路由**：DSH 任务要跑远端 → 经 los API 提交 runSpec/scheduled_execution，DSH 只做触发+展示（桥接候选，API 已通） |
| **投递** | los 通讯体系（WeChat digest 等） | DSH channel 插件（channel-wechat）+ deliverTo 会话 | 各自渠道各自实现；dsh-scheduler deliverTo 扩展 IM = 对接 DSH 侧渠道，不依赖 los |
| **模型/网关** | los-gateway 统一模型网关 | DSH 模型路由已接 los-gateway | **共享健康信号**：网关挂了双方定时任务都受影响 → los readiness 应含 DSH 视角，DSH 任务可前置网关探测 |
| **监督** | los 自监督（runtime/log freshness/fleet/NAS） | DSH 自监督（health-panel）+ los 看板 | 双向健康检查（见 §2） |

## 4. 落地路线（dsh-scheduler v0.3 候选）

1. **v0.3a 调度语义补齐**（纯 DSH 侧）：maxAttempts 重试 + no_op 识别 + sessionDir 关联 + half-open 试探恢复
2. **v0.3b los 监督看板**：host 代理（读 los .env token）+ client tab「los 监督」区块
3. **v0.4 桥接候选**：executorKind='los'（DSH 触发 → los 执行远端任务），需先与 los API
   契约对齐（runSpec 提交接口），并评估审批/权限语义
