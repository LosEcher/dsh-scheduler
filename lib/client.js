window.__ModuleLoader__.load({ id: "dsh-scheduler", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/client/index.ts
var index_exports = {};
__export(index_exports, {
  apply: () => apply,
  inject: () => inject
});
module.exports = __toCommonJS(index_exports);

// src/client/SchedulerTabView.tsx
var import_react = require("react");
var import_jsx_runtime = require("react/jsx-runtime");
var CARD = {
  background: "var(--dsw-alias-bg-layer-1)",
  border: "1px solid var(--dsw-alias-border-l2)",
  borderRadius: 10,
  padding: "12px 16px",
  marginBottom: 12
};
var ROW = { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" };
var BTN = {
  padding: "4px 10px",
  borderRadius: 6,
  cursor: "pointer",
  fontSize: 12,
  border: "1px solid var(--dsw-alias-border-l2)",
  background: "var(--dsw-alias-bg-layer-2)",
  color: "var(--dsw-alias-text-1)"
};
var BTN_PRIMARY = { ...BTN, background: "var(--dsw-alias-accent-1, #4a6cf7)", color: "#fff", borderColor: "transparent" };
var INPUT = {
  width: "100%",
  boxSizing: "border-box",
  padding: "6px 8px",
  borderRadius: 6,
  fontSize: 13,
  border: "1px solid var(--dsw-alias-border-l2)",
  background: "var(--dsw-alias-bg-layer-2)",
  color: "var(--dsw-alias-text-1)",
  fontFamily: "inherit"
};
var BADGE = {
  padding: "2px 8px",
  borderRadius: 999,
  fontSize: 11,
  border: "1px solid var(--dsw-alias-border-l2)",
  background: "var(--dsw-alias-bg-layer-2)"
};
var BADGE_OK = { ...BADGE, color: "#2e9e5b", borderColor: "#2e9e5b55" };
var BADGE_BAD = { ...BADGE, color: "#d64545", borderColor: "#d6454555" };
var MUTED = { color: "var(--dsw-alias-text-2)", fontSize: 12 };
var TITLE = { margin: "0 0 8px", fontSize: 14, fontWeight: 600 };
async function getJson(path, signal) {
  const res = await fetch(path, { signal });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.message ?? `HTTP ${res.status}`);
  return body;
}
async function sendJson(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body !== void 0 ? { "Content-Type": "application/json" } : void 0,
    body: body !== void 0 ? JSON.stringify(body) : void 0
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.message ?? `HTTP ${res.status}`);
  return data;
}
var fmt = (iso) => {
  if (!iso) return "\u2014";
  try {
    return new Date(iso).toLocaleString("zh-CN", { hour12: false });
  } catch {
    return iso;
  }
};
var TRIGGER_DESC = {
  cron: "cron",
  interval: "\u95F4\u9694",
  once: "\u4E00\u6B21\u6027"
};
function SchedulerTabView(_props) {
  const [status, setStatus] = (0, import_react.useState)(null);
  const [jobs, setJobs] = (0, import_react.useState)([]);
  const [runs, setRuns] = (0, import_react.useState)([]);
  const [runsFor, setRunsFor] = (0, import_react.useState)(null);
  const [error, setError] = (0, import_react.useState)(null);
  const [loading, setLoading] = (0, import_react.useState)(false);
  const [showForm, setShowForm] = (0, import_react.useState)(false);
  const [editing, setEditing] = (0, import_react.useState)(null);
  const [preview, setPreview] = (0, import_react.useState)(null);
  const [previewError, setPreviewError] = (0, import_react.useState)(null);
  const [busy, setBusy] = (0, import_react.useState)(false);
  const previewTimer = (0, import_react.useRef)(void 0);
  const [form, setForm] = (0, import_react.useState)({
    name: "",
    prompt: "",
    kind: "cron",
    expression: "0 9 * * *",
    timezone: "local",
    workspace: "",
    enabled: true,
    deliverTo: "",
    catchUpPolicy: ""
  });
  const load = (0, import_react.useCallback)(async () => {
    setLoading(true);
    setError(null);
    try {
      const [s, j] = await Promise.all([
        getJson("/scheduler/status"),
        getJson("/scheduler/jobs")
      ]);
      setStatus(s);
      setJobs(j.results ?? []);
    } catch (e) {
      setError(String(e.message ?? e));
    } finally {
      setLoading(false);
    }
  }, []);
  (0, import_react.useEffect)(() => {
    void load();
  }, [load]);
  const loadRuns = (0, import_react.useCallback)(async (jobId) => {
    try {
      const d = await getJson(`/scheduler/jobs/${jobId}/runs?limit=30`);
      setRuns(d.runs ?? []);
      setRunsFor(jobId);
    } catch {
      setRuns([]);
      setRunsFor(null);
    }
  }, []);
  (0, import_react.useEffect)(() => {
    if (!showForm) return;
    if (!form.expression.trim()) {
      setPreview(null);
      setPreviewError(null);
      return;
    }
    clearTimeout(previewTimer.current);
    previewTimer.current = setTimeout(async () => {
      const q = new URLSearchParams({ kind: form.kind, expression: form.expression, timezone: form.timezone, n: "5" });
      try {
        const d = await getJson(`/scheduler/preview?${q}`);
        setPreview(d.occurrences);
        setPreviewError(null);
      } catch (e) {
        setPreview(null);
        setPreviewError(String(e.message ?? e));
      }
    }, 400);
    return () => clearTimeout(previewTimer.current);
  }, [showForm, form.kind, form.expression, form.timezone]);
  const openCreate = () => {
    setEditing(null);
    setForm({
      name: "",
      prompt: "",
      kind: "cron",
      expression: "0 9 * * *",
      timezone: "local",
      workspace: "",
      enabled: true,
      deliverTo: "",
      catchUpPolicy: ""
    });
    setShowForm(true);
  };
  const openEdit = (job) => {
    setEditing(job);
    setForm({
      name: job.name,
      prompt: job.prompt,
      kind: job.trigger.kind,
      expression: job.trigger.expression,
      timezone: job.trigger.timezone,
      workspace: job.workspace ?? "",
      enabled: job.enabled,
      deliverTo: job.deliverTo?.sessionId ?? "",
      catchUpPolicy: job.catchUpPolicy ?? ""
    });
    setShowForm(true);
  };
  const submitForm = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const payload = {
        name: form.name,
        prompt: form.prompt,
        trigger: { kind: form.kind, expression: form.expression, timezone: form.timezone },
        workspace: form.workspace,
        enabled: form.enabled,
        deliverTo: form.deliverTo.trim() ? { sessionId: form.deliverTo.trim() } : null,
        catchUpPolicy: form.catchUpPolicy || void 0
      };
      if (editing) {
        await sendJson("PATCH", `/scheduler/jobs/${editing.id}`, payload);
      } else {
        await sendJson("POST", "/scheduler/jobs", payload);
      }
      setShowForm(false);
      setEditing(null);
      await load();
    } catch (e2) {
      setError(String(e2.message ?? e2));
    } finally {
      setBusy(false);
    }
  };
  const act = async (method, path) => {
    try {
      await sendJson(method, path);
      await load();
    } catch (e) {
      setError(String(e.message ?? e));
    }
  };
  const del = async (job) => {
    if (!confirm(`\u5220\u9664\u4EFB\u52A1\u300C${job.name}\u300D\uFF1F\u8FD0\u884C\u53F0\u8D26\u5C06\u4E00\u5E76\u5220\u9664\u3002`)) return;
    await act("DELETE", `/scheduler/jobs/${job.id}`);
    if (runsFor === job.id) {
      setRuns([]);
      setRunsFor(null);
    }
  };
  const inflightIds = (0, import_react.useMemo)(() => new Set((status?.inflight ?? []).map((i) => i.jobId)), [status]);
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { padding: "12px 16px", maxWidth: 900, margin: "0 auto" }, children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: CARD, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: ROW, children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("strong", { style: { fontSize: 14 }, children: "\u5B9A\u65F6\u4EFB\u52A1" }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { style: MUTED, children: [
          "tick: ",
          fmt(status?.lastTickAt)
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { style: MUTED, children: [
          "\u5728\u98DE: ",
          status?.inflight.length ?? 0,
          "/",
          status?.maxConcurrent ?? "?"
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { style: MUTED, children: [
          "\u4EFB\u52A1: ",
          status?.enabledCount ?? "?",
          "/",
          status?.jobCount ?? "?",
          " \u542F\u7528"
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { style: MUTED, children: [
          "\u7194\u65AD: ",
          status?.maxConsecutiveFailures ?? "?",
          " \u8FDE\u8D25"
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { style: MUTED, children: [
          "\u8FFD\u8D76: ",
          status?.catchUpPolicy ?? "?"
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { flex: 1 } }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { style: BTN, type: "button", onClick: () => void load(), disabled: loading, children: "\u5237\u65B0" }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { style: BTN_PRIMARY, type: "button", onClick: openCreate, children: "+ \u65B0\u5EFA\u4EFB\u52A1" })
      ] }),
      error ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { color: "#d64545", fontSize: 12, marginTop: 6 }, children: error }) : null
    ] }),
    showForm ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: CARD, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h3", { style: TITLE, children: editing ? `\u7F16\u8F91\u4EFB\u52A1\uFF1A${editing.name}` : "\u65B0\u5EFA\u4EFB\u52A1" }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("form", { onSubmit: (e) => void submitForm(e), style: { display: "grid", gap: 8 }, children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { style: { fontSize: 12 }, children: [
          "\u540D\u79F0",
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", { style: INPUT, value: form.name, onChange: (e) => setForm({ ...form, name: e.target.value }), placeholder: "\u5982\uFF1A\u6BCF\u65E5 CI \u5DE1\u68C0", required: true })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { style: { fontSize: 12 }, children: [
          "\u4EFB\u52A1 prompt\uFF08headless \u5168\u65B0\u4F1A\u8BDD\u6267\u884C\uFF0C\u9700\u81EA\u5305\u542B\uFF09",
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
            "textarea",
            {
              style: { ...INPUT, minHeight: 72, resize: "vertical" },
              value: form.prompt,
              onChange: (e) => setForm({ ...form, prompt: e.target.value }),
              placeholder: "\u68C0\u67E5 CI \u72B6\u6001\u5E76\u6C47\u603B\u7ED3\u679C",
              required: true
            }
          )
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { ...ROW, alignItems: "flex-end" }, children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { style: { fontSize: 12, flex: 1 }, children: [
            "\u89E6\u53D1\u7C7B\u578B",
            /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("select", { style: INPUT, value: form.kind, onChange: (e) => setForm({ ...form, kind: e.target.value }), children: [
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: "cron", children: "cron\uFF085 \u6BB5\u8868\u8FBE\u5F0F\uFF09" }),
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: "interval", children: "\u95F4\u9694\uFF08\u5982 30m / 2h\uFF09" }),
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: "once", children: "\u4E00\u6B21\u6027\uFF08ISO \u65F6\u95F4\uFF09" })
            ] })
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { style: { fontSize: 12, flex: 2 }, children: [
            "\u8868\u8FBE\u5F0F",
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
              "input",
              {
                style: INPUT,
                value: form.expression,
                onChange: (e) => setForm({ ...form, expression: e.target.value }),
                placeholder: form.kind === "cron" ? "0 9 * * 1-5" : form.kind === "interval" ? "30m" : "2026-08-16T09:00:00+08:00",
                required: true
              }
            )
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { style: { fontSize: 12, flex: 1 }, children: [
            "\u65F6\u533A",
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
              "input",
              {
                style: INPUT,
                value: form.timezone,
                onChange: (e) => setForm({ ...form, timezone: e.target.value }),
                placeholder: "local / Asia/Shanghai"
              }
            )
          ] })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { style: { fontSize: 12 }, children: [
          "\u5DE5\u4F5C\u533A\uFF08headless \u8FD0\u884C cwd\uFF0C\u7559\u7A7A\u7528\u9ED8\u8BA4\uFF09",
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
            "input",
            {
              style: INPUT,
              value: form.workspace,
              onChange: (e) => setForm({ ...form, workspace: e.target.value }),
              placeholder: "\u5982 /Users/echerlos/syncthing/project/dsfolder"
            }
          )
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { ...ROW, alignItems: "flex-end" }, children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { style: { fontSize: 12, flex: 2 }, children: [
            "\u7ED3\u679C\u6295\u9012\u4F1A\u8BDD\uFF08deliverTo\uFF0C\u7559\u7A7A\u4E0D\u6295\u9012\uFF09",
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
              "input",
              {
                style: INPUT,
                value: form.deliverTo,
                onChange: (e) => setForm({ ...form, deliverTo: e.target.value }),
                placeholder: "\u76EE\u6807\u4F1A\u8BDD ID\uFF1B\u8BE5\u4F1A\u8BDD\u5728\u7EBF\u65F6\u7ED3\u679C followup \u8FDB\u53BB"
              }
            )
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { style: { fontSize: 12, flex: 1 }, children: [
            "\u8FFD\u8D76\u7B56\u7565",
            /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
              "select",
              {
                style: INPUT,
                value: form.catchUpPolicy,
                onChange: (e) => setForm({ ...form, catchUpPolicy: e.target.value }),
                children: [
                  /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: "", children: "\u8DDF\u968F\u5168\u5C40\uFF08run_once\uFF09" }),
                  /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: "run_once", children: "run_once\uFF08\u9519\u8FC7\u8865\u8DD1\u4E00\u6B21\uFF09" }),
                  /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: "skip", children: "skip\uFF08\u8D85\u65F6\u5DEE\u5373\u8DF3\u8FC7\uFF09" })
                ]
              }
            )
          ] })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { style: { fontSize: 12, ...ROW }, children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
            "input",
            {
              type: "checkbox",
              checked: form.enabled,
              onChange: (e) => setForm({ ...form, enabled: e.target.checked })
            }
          ),
          " \u542F\u7528"
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { fontSize: 12 }, children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("strong", { children: "\u672A\u6765 5 \u6B21\u89E6\u53D1\uFF1A" }),
          preview ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { ...MUTED, wordBreak: "break-all" }, children: preview.map(fmt).join(" \uFF5C ") }) : previewError ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { color: "#d64545" }, children: previewError }) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: MUTED, children: "\u2026" })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: ROW, children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { style: BTN_PRIMARY, type: "submit", disabled: busy, children: busy ? "\u4FDD\u5B58\u4E2D\u2026" : "\u4FDD\u5B58" }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { style: BTN, type: "button", onClick: () => {
            setShowForm(false);
            setEditing(null);
          }, children: "\u53D6\u6D88" })
        ] })
      ] })
    ] }) : null,
    jobs.length === 0 && !loading ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: CARD, children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: MUTED, children: "\u6682\u65E0\u5B9A\u65F6\u4EFB\u52A1\uFF0C\u70B9\u300C+ \u65B0\u5EFA\u4EFB\u52A1\u300D\u521B\u5EFA\u7B2C\u4E00\u4E2A\u3002" }) }) : jobs.map((job) => {
      const running = inflightIds.has(job.id);
      return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: CARD, children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: ROW, children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("strong", { children: job.name }),
          job.state === "paused" ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: BADGE_BAD, children: job.pausedReason === "max_consecutive_failures" ? "\u5DF2\u7194\u65AD\u6682\u505C" : "\u5DF2\u6682\u505C" }) : job.enabled && job.state === "scheduled" ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: BADGE_OK, children: "\u542F\u7528" }) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: BADGE_BAD, children: "\u5DF2\u5B8C\u6210" }),
          running ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: BADGE, children: "\u8FD0\u884C\u4E2D\u2026" }) : null,
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { flex: 1 } }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { style: BTN, type: "button", onClick: () => void act("POST", `/scheduler/jobs/${job.id}/trigger`), disabled: running, children: "\u7ACB\u5373\u89E6\u53D1" }),
          job.state === "paused" ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { style: BTN, type: "button", onClick: () => void act("POST", `/scheduler/jobs/${job.id}/resume`), children: "\u6062\u590D" }) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { style: BTN, type: "button", onClick: () => void act("POST", `/scheduler/jobs/${job.id}/pause`), children: "\u6682\u505C" }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { style: BTN, type: "button", onClick: () => openEdit(job), children: "\u7F16\u8F91" }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { style: BTN, type: "button", onClick: () => void del(job), children: "\u5220\u9664" })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { ...MUTED, marginTop: 4 }, children: [
          TRIGGER_DESC[job.trigger.kind],
          " ",
          job.trigger.expression,
          " \xB7 ",
          job.trigger.timezone,
          job.workspace ? ` \xB7 ${job.workspace}` : "",
          job.deliverTo ? ` \xB7 \u6295\u9012\u2192${job.deliverTo.sessionId}` : "",
          job.catchUpPolicy ? ` \xB7 \u8FFD\u8D76:${job.catchUpPolicy}` : ""
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { ...ROW, marginTop: 4 }, children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { style: MUTED, children: [
            "\u4E0B\u6B21: ",
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("b", { children: fmt(job.nextRunAt) })
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { style: MUTED, children: [
            "\u4E0A\u6B21: ",
            fmt(job.lastRunAt)
          ] }),
          job.lastStatus ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: job.lastStatus === "succeeded" ? BADGE_OK : BADGE_BAD, children: job.lastStatus }) : null,
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { style: MUTED, children: [
            "\u8FD0\u884C ",
            job.runCount,
            " \u6B21"
          ] }),
          job.consecutiveFailures > 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { style: BADGE_BAD, children: [
            "\u8FDE\u7EED\u5931\u8D25 ",
            job.consecutiveFailures
          ] }) : null,
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { flex: 1 } }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
            "button",
            {
              style: { ...BTN, fontSize: 11 },
              type: "button",
              onClick: () => void (runsFor === job.id ? (setRuns([]), setRunsFor(null)) : loadRuns(job.id)),
              children: runsFor === job.id ? "\u6536\u8D77\u5386\u53F2" : "\u8FD0\u884C\u5386\u53F2"
            }
          )
        ] }),
        runsFor === job.id ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { marginTop: 8, borderTop: "1px solid var(--dsw-alias-border-l2)", paddingTop: 8 }, children: runs.length === 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: MUTED, children: "\u6682\u65E0\u8FD0\u884C\u8BB0\u5F55" }) : runs.map((r) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("details", { style: { marginBottom: 6, fontSize: 12 }, children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("summary", { style: { cursor: "pointer" }, children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { style: ROW, children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: r.status === "succeeded" ? BADGE_OK : r.status === "failed" ? BADGE_BAD : BADGE, children: r.status }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: MUTED, children: r.triggerKind === "manual" ? "\u624B\u52A8" : "\u5B9A\u65F6" }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { style: MUTED, children: [
              "\u89E6\u53D1\u4E8E ",
              fmt(r.scheduledFor)
            ] }),
            r.durationMs !== void 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { style: MUTED, children: [
              "\u8017\u65F6 ",
              (r.durationMs / 1e3).toFixed(1),
              "s"
            ] }) : null,
            r.exitCode !== void 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { style: MUTED, children: [
              "exit ",
              r.exitCode
            ] }) : null,
            r.delivery ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: r.delivery.status === "delivered" ? BADGE_OK : BADGE_BAD, children: r.delivery.status === "delivered" ? `\u5DF2\u6295\u9012\u2192${r.delivery.sessionId}` : `\u6295\u9012:${r.delivery.status}` }) : null,
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { flex: 1 } }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: MUTED, children: fmt(r.completedAt ?? r.startedAt) })
          ] }) }),
          r.error ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("pre", { style: { ...MUTED, color: "#d64545", whiteSpace: "pre-wrap", margin: "4px 0" }, children: r.error }) : null,
          r.outputHead ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("pre", { style: { ...MUTED, whiteSpace: "pre-wrap", wordBreak: "break-all", margin: "4px 0", maxHeight: 240, overflow: "auto" }, children: r.outputHead }) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: MUTED, children: "\uFF08\u65E0\u8F93\u51FA\uFF09" })
        ] }, r.id)) }) : null
      ] }, job.id);
    })
  ] });
}

// src/client/index.ts
var inject = ["slots", "conversation"];
function apply(ctx) {
  let disposeTab;
  disposeTab = ctx.slots.inject("conversation.view", () => ctx.slots.register({
    name: "conversation.view",
    id: "scheduler",
    order: 96,
    label: () => "\u5B9A\u65F6\u4EFB\u52A1"
  }, (props) => SchedulerTabView({ ...props })));
  ctx.on("dispose", () => disposeTab?.());
}
return module.exports; } });
