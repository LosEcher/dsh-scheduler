/**
 * dsh-scheduler — host 入口冒烟测试（跨版本门禁）。
 *
 * 用**运行中 profile 的真实宿主库**（@deepseek-ai/schemastery、@deepseek-ai/dsh-llm）
 * 加载插件入口 index.mjs，用桩 ctx 驱动 apply()，再以假 req/res 走**真实路由处理器**。
 * 这样锁住四类只有"装到真宿主里"才暴露的漂移：
 *   1. 模块能加载（语法/裸导入/Config schema 构建）—— 插件自带测试用的都是自己
 *      vendored 的包，抓不到宿主 API 漂移（dsh-undo 先例）；
 *   2. 注入契约（inject 声明）与路由注册（exact /plugins/<id>/status + prefix /scheduler）；
 *   3. **CLI 入口解析**（resolveCliEntry 在 apply 顶部 eager 执行）—— 真宿主里
 *      这一步失败会让插件加载直接抛错，是最高危的一环；
 *   4. 关键行为的**可观察契约**：插件状态信封字段、cron 预览、job 增删、参数校验 400。
 *
 * 设计要点（沿用 dsh-dashboards/test/host-smoke.test.mjs 先例）：
 *   - 依赖从 profile 解析（test/fixtures/resolve-host.mjs），不赌本机软链；
 *   - 解析不到宿主库 ⇒ skip 并打印原因，而不是假装通过（防空转）；
 *   - **DSH_HOME 指向临时目录**，绝不触碰用户真实 storages / jobs.json；
 *   - **绝不触发真实 headless 运行**：本门禁只建 `enabled:false` 的暂停 job（state=paused、
 *     nextRunAt=null），且不调用 /trigger；tick 间隔 60s，测试期间不会有第二次 tick。
 *
 * 运行：node --test test/host-smoke.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

/** 宿主库探测链：显式 env → ~/.dsh/profiles（link 插件的公共层）→ web profile。 */
function findHostRoot() {
  const candidates = [
    process.env.DSH_HOST_MODULES,
    process.env.DSH_PROFILE_ROOT,
    join(homedir(), '.dsh', 'profiles'),
    join(homedir(), '.dsh', 'profiles', 'web'),
  ].filter(Boolean)
  for (const root of candidates) {
    if (existsSync(join(root, 'node_modules', '@deepseek-ai', 'schemastery'))) return root
  }
  return null
}

/**
 * harness 检出根：apply() 会在顶部 eagerly 解析 dsh CLI 入口，找不到就抛。
 * 显式给 harnessDir 才能让门禁走到"路由注册之后的断言"。
 */
function findHarnessRoot() {
  const candidates = [
    process.env.DSH_HARNESS_DIR,
    join(homedir(), 'syncfolder', 'project', 'deepseek-harness'),
    join(homedir(), '.dsh', 'source', 'current'),
  ].filter(Boolean)
  for (const root of candidates) {
    if (existsSync(join(root, 'apps', 'cli', 'lib', 'bin.js'))) return root
    if (existsSync(join(root, 'lib', 'bin.js'))) return root
  }
  return null
}

const HOST_ROOT = findHostRoot()
const HARNESS_ROOT = findHarnessRoot()

const SKIP = !HOST_ROOT
  ? '未找到宿主 node_modules（profile 未安装 @deepseek-ai/schemastery），跳过而非假装通过'
  : (!HARNESS_ROOT
    ? '未找到 harness 检出（apps/cli/lib/bin.js 不存在）：apply() 需要可解析的 dsh CLI 入口，跳过而非假装通过'
    : false)

/** 桩 ctx：捕获路由 + disposer；agents 提供最小读面。 */
function makeCtx() {
  const routes = []
  const logs = []
  const disposers = []
  return {
    routes,
    logs,
    disposers,
    webServer: { register: (r) => { routes.push(r); return () => {} } },
    logger: {
      info: (m) => logs.push(`info: ${String(m)}`),
      warn: (m) => logs.push(`warn: ${String(m)}`),
      error: (m) => logs.push(`error: ${String(m)}`),
    },
    // 交付/派发路径只在真有 due job 时用到；门禁不建 due job，故只需最小读面。
    agents: { get: () => undefined, roots: () => [] },
    effect: (fn) => { disposers.push(fn?.()) },
    on: () => {},
    dispose: () => { for (const d of disposers.reverse()) { try { d?.() } catch { /* 清理失败不影响判定 */ } } },
  }
}

function fakeRes() {
  const res = {
    statusCode: 0,
    body: '',
    writeHead(code) { res.statusCode = code },
    end(chunk) { res.body = chunk ?? '' },
  }
  return res
}

/**
 * 假 req：readBody() 用 `for await (const chunk of req)` 消费（async iterable），
 * 不是 'data'/'end' 事件。两种消费方式都支持，避免门禁因"桩不合契约"而假红。
 */
function fakeReq(url, method = 'GET', body) {
  const req = new EventEmitter()
  req.url = url
  req.method = method
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  req[Symbol.asyncIterator] = async function* () { for (const chunk of chunks) yield chunk }
  setImmediate(() => {
    for (const chunk of chunks) req.emit('data', chunk)
    req.emit('end')
  })
  return req
}

/** 加载插件入口：DSH_HOME 必须先指向临时目录（index.mjs/apply 顶层就把它算进路径）。 */
async function loadPlugin(dshHome) {
  process.env.DSH_HOME = dshHome
  process.env.DSH_HOST_MODULES = HOST_ROOT
  register(new URL('./fixtures/resolve-host.mjs', import.meta.url).href)
  return await import(`../index.mjs?smoke=${Date.now()}`)
}

const callRoute = async (route, url, method = 'GET', body) => {
  const res = fakeRes()
  await route.handler(fakeReq(url, method, body), res)
  return { status: res.statusCode, json: res.body ? JSON.parse(res.body) : null }
}

const findRoute = (routes, path) => routes.find((r) => r.path === path)

test('host 冒烟：真实宿主库加载入口 + 注入/路由契约 + CLI 解析 + 关键行为', { skip: SKIP }, async () => {
  const dshHome = mkdtempSync(join(tmpdir(), 'dsh-sched-smoke-'))
  const ctx = makeCtx()
  try {
    const mod = await loadPlugin(dshHome)

    // ── 模块与注入契约 ──
    assert.equal(mod.name, 'dsh-scheduler')
    assert.deepEqual(mod.inject, ['webServer', 'agents'], 'inject 是宿主服务门控，漂移会导致 ctx.* 不可用')
    assert.ok(mod.Config, 'Config schema 应导出')

    // ── apply：Config 校验 + CLI 解析 + 路由注册 + 定时器建立，都不应抛 ──
    mod.apply(ctx, { harnessDir: HARNESS_ROOT })

    const pluginStatus = findRoute(ctx.routes, '/plugins/dsh-scheduler/status')
    const scheduler = findRoute(ctx.routes, '/scheduler')
    assert.ok(pluginStatus, '/plugins/dsh-scheduler/status 路由应注册')
    assert.ok(scheduler, '/scheduler 前缀路由应注册')
    assert.equal(pluginStatus.kind, 'exact')
    assert.equal(scheduler.kind, 'prefix')

    // ── /plugins/<id>/status 统一约定（2026-08-23）信封 ──
    const st = await callRoute(pluginStatus, '/plugins/dsh-scheduler/status')
    assert.equal(st.status, 200)
    assert.equal(st.json.ok, true)
    assert.equal(st.json.plugin, 'dsh-scheduler')
    assert.equal(typeof st.json.version, 'string')
    assert.equal(st.json.lastError, null)
    assert.equal(st.json.counts.jobs, 0, '临时数据目录里应无 job')
    assert.equal(st.json.counts.inflight, 0)
    assert.equal(typeof st.json.detail.lockHeld, 'boolean')

    // ── /scheduler/status：CLI 解析结果必须可观察（真宿主里这一步失败=插件加载即崩）──
    const sched = await callRoute(scheduler, '/scheduler/status')
    assert.equal(sched.status, 200)
    assert.equal(sched.json.ok, true)
    assert.equal(sched.json.jobCount, 0)
    assert.ok(typeof sched.json.cliEntry === 'string' && sched.json.cliEntry.length > 0, 'cliEntry 应已解析出具体来源')
    // resolveConfig 默认值：改这些默认等于改调度语义，漂移必须显式可见
    assert.equal(sched.json.maxConcurrent, 2)
    assert.equal(sched.json.tickMs, 60_000)
    assert.equal(sched.json.timeoutMs, 30 * 60_000)
    assert.equal(sched.json.catchUpPolicy, 'run_once')

    // ── cron 预览：真实解析器经真实路由 ──
    const preview = await callRoute(scheduler, '/scheduler/preview?kind=cron&expression=0%209%20*%20*%201-5&timezone=local&n=3')
    assert.equal(preview.status, 200)
    assert.equal(preview.json.occurrences.length, 3)

    // ── 参数校验：坏 cron / 缺字段必须 400（不是 500，也不能静默接受）──
    const badTrigger = await callRoute(scheduler, '/scheduler/jobs', 'POST', {
      name: 'gate-bad', prompt: 'noop', trigger: { kind: 'cron', expression: 'definitely not a cron' },
    })
    assert.equal(badTrigger.status, 400)
    const missingName = await callRoute(scheduler, '/scheduler/jobs', 'POST', { prompt: 'noop', trigger: { kind: 'interval', expression: '1h' } })
    assert.equal(missingName.status, 400)

    // ── 建/查/删：只建**暂停** job（enabled:false ⇒ state=paused、nextRunAt=null），绝不触发真实 run ──
    const created = await callRoute(scheduler, '/scheduler/jobs', 'POST', {
      name: 'gate-job', prompt: 'noop', enabled: false, trigger: { kind: 'interval', expression: '1h' },
    })
    assert.equal(created.status, 201)
    const jobId = created.json.job.id
    assert.ok(jobId, '返回体应含 job.id')
    assert.equal(created.json.job.state, 'paused')
    assert.equal(created.json.job.nextRunAt, null)
    assert.equal(created.json.occurrences.length, 5)

    const listed = await callRoute(scheduler, '/scheduler/jobs')
    assert.equal(listed.status, 200)
    assert.equal(listed.json.count, 1)
    assert.deepEqual(listed.json.results.map((j) => j.id), [jobId])

    const single = await callRoute(scheduler, `/scheduler/jobs/${jobId}`)
    assert.equal(single.status, 200)

    const removed = await callRoute(scheduler, `/scheduler/jobs/${jobId}`, 'DELETE')
    assert.equal(removed.status, 200)
    assert.equal(removed.json.deleted, true)
    const after = await callRoute(scheduler, '/scheduler/jobs')
    assert.equal(after.json.count, 0, '删除后列表应回空')
    assert.deepEqual(after.json.results, [])

    // 重复删除必须 404（寻址契约，不是静默成功）
    const removedAgain = await callRoute(scheduler, `/scheduler/jobs/${jobId}`, 'DELETE')
    assert.equal(removedAgain.status, 404)

    // ── 未注册动作必须 404（路由收口）──
    const unknown = await callRoute(scheduler, '/scheduler/nope')
    assert.equal(unknown.status, 404)
  } finally {
    ctx.dispose()
    rmSync(dshHome, { recursive: true, force: true })
  }
})

test('host 冒烟：CLI 入口不可解析时必须抛带补救指引的错误（fail-closed，不静默降级）', { skip: SKIP }, async () => {
  const dshHome = mkdtempSync(join(tmpdir(), 'dsh-sched-nocli-'))
  const ctx = makeCtx()
  const savedHarnessDir = process.env.DSH_HARNESS_DIR
  try {
    const mod = await loadPlugin(dshHome)
    delete process.env.DSH_HARNESS_DIR
    // 临时 DSH_HOME 下既无 source/current 也无 profiles 安装 ⇒ resolveCliEntry 必须抛
    assert.throws(() => mod.apply(ctx, {}), /DSH_HARNESS_DIR/, '错误信息必须指出补救手段，否则线上排障无从下手')
    assert.equal(ctx.routes.length, 0, '解析失败时不应留下半注册的路由')
  } finally {
    if (savedHarnessDir !== undefined) process.env.DSH_HARNESS_DIR = savedHarnessDir
    ctx.dispose()
    rmSync(dshHome, { recursive: true, force: true })
  }
})
