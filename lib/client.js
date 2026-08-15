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
var import_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");

// src/client/SchedulerTab.module.css
var css = "/* dsh-scheduler \u2014 \u5B9A\u65F6\u4EFB\u52A1\u7BA1\u7406 tab \u6837\u5F0F\u3002\u53EA\u4F7F\u7528 --dsw-alias-* \u767D\u540D\u5355\u4EE4\u724C\u3002 */\n\n._487c378e_scRoot {\n  padding: 12px 16px;\n  max-width: 900px;\n  margin: 0 auto;\n  font-size: 13px;\n  line-height: 1.6;\n  color: var(--dsw-alias-label-primary);\n}\n\n/* \u2500\u2500 \u901A\u7528\u5361\u7247 \u2500\u2500 */\n._5d43b0c9_scCard {\n  background: var(--dsw-alias-bg-layer-1);\n  border: 1px solid var(--dsw-alias-border-l2);\n  border-radius: 10px;\n  padding: 12px 16px;\n  margin-bottom: 12px;\n}\n\n._28233adb_scRow {\n  display: flex;\n  align-items: center;\n  gap: 8px;\n  flex-wrap: wrap;\n}\n\n._e1c496ea_scRowEnd { align-items: flex-end; }\n\n._3ba2dc27_scSpacer { flex: 1; }\n\n._e6abb38b_scStatusTitle { font-size: 14px; font-weight: 700; color: var(--dsw-alias-label-primary); }\n\n._62f14895_scMuted { color: var(--dsw-alias-label-tertiary); font-size: 12px; }\n\n._eb44c5ac_scError { color: var(--dsw-alias-state-error-primary); font-size: 12px; margin-top: 6px; }\n\n._ddc9b108_scTitle {\n  margin: 0 0 8px;\n  font-size: 14px;\n  font-weight: 600;\n  color: var(--dsw-alias-label-primary);\n}\n\n/* \u2500\u2500 \u8868\u5355 \u2500\u2500 */\n._202e4e0f_scForm { display: grid; gap: 8px; }\n\n._a33ac2fe_scFieldLabel { font-size: 12px; }\n._fc1d373e_scFieldFlex1 { flex: 1; }\n._bcfbcb11_scFieldFlex2 { flex: 2; }\n\n._679ed996_scInput, ._345516a9_scSelect, ._5514676b_scTextarea {\n  width: 100%;\n  box-sizing: border-box;\n  padding: 6px 8px;\n  border-radius: 6px;\n  font-size: 13px;\n  border: 1px solid var(--dsw-alias-border-l2);\n  background: var(--dsw-alias-bg-layer-2);\n  color: var(--dsw-alias-label-primary);\n  font-family: inherit;\n}\n._679ed996_scInput:focus, ._345516a9_scSelect:focus, ._5514676b_scTextarea:focus {\n  outline: none;\n  border-color: var(--dsw-alias-brand-primary);\n}\n._5514676b_scTextarea { min-height: 72px; resize: vertical; }\n\n._66f8a1c3_scCheckRow { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 12px; }\n\n/* \u2500\u2500 \u89E6\u53D1\u9884\u89C8 \u2500\u2500 */\n._47add15c_scPreview { font-size: 12px; }\n._db05de60_scPreviewLabel { font-weight: 600; }\n._a7f561ab_scPreviewValue { color: var(--dsw-alias-label-tertiary); font-size: 12px; word-break: break-all; }\n._2e5f0482_scPreviewError { color: var(--dsw-alias-state-error-primary); }\n\n/* \u2500\u2500 \u5FBD\u7AE0 \u2500\u2500 */\n._26ecbd5d_scBadge {\n  display: inline-block;\n  padding: 1px 8px;\n  border-radius: 99px;\n  font-size: 11px;\n  font-weight: 500;\n  background: var(--dsw-alias-interactive-bg-hover);\n  color: var(--dsw-alias-label-secondary);\n  border: 1px solid transparent;\n}\n/* \u72B6\u6001\u5FBD\u7AE0\u5BF9\u6BD4\u5EA6\u4FEE\u590D\uFF082026-08-15\uFF09\uFF1Asecondary \u5E95+primary \u5B57 \u22481.17:1 \u4E0D\u8FBE\u6807\uFF0C\n   \u5BF9\u9F50 harness \u5185\u7F6E\u8303\u5F0F\u2014\u2014tertiary \u5E95 + primary \u5B57\uFF0Csecondary \u5F52\u4F4D\u4E3A\u8FB9\u6846\u3002 */\n._ba2089a0_scBadgeOk { background: var(--dsw-alias-state-success-tertiary); color: var(--dsw-alias-state-success-primary); border-color: var(--dsw-alias-state-success-secondary); }\n._371f6a8c_scBadgeBad { background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, var(--dsw-alias-bg-layer-1)); color: var(--dsw-alias-state-error-primary); }\n\n/* \u2500\u2500 \u4EFB\u52A1\u6761 \u2500\u2500 */\n._a0c1c98e_scJobMeta { color: var(--dsw-alias-label-tertiary); font-size: 12px; margin-top: 4px; }\n._50348c9f_scJobActions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 4px; }\n\n._d0de20ba_scDangerText { color: var(--dsw-alias-state-error-primary); }\n\n/* \u2500\u2500 \u8FD0\u884C\u53F0\u8D26 \u2500\u2500 */\n._47ff62f8_scLedger {\n  margin-top: 8px;\n  border-top: 1px solid var(--dsw-alias-border-l2);\n  padding-top: 8px;\n}\n._36cdc13a_scRunItem { margin-bottom: 6px; font-size: 12px; }\n._4ebbe9b5_scRunSummary { cursor: pointer; }\n._3c29d7ed_scRunError {\n  color: var(--dsw-alias-state-error-primary);\n  white-space: pre-wrap;\n  margin: 4px 0;\n  font-size: 12px;\n}\n._5344eabd_scRunOutput {\n  color: var(--dsw-alias-label-tertiary);\n  font-size: 12px;\n  white-space: pre-wrap;\n  word-break: break-all;\n  margin: 4px 0;\n  max-height: 240px;\n  overflow: auto;\n}\n";
var tagId = "dsh-scheduler/SchedulerTab.module.css";
if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
  const tag = document.createElement("style");
  tag.dataset.plugin = "dsh-scheduler";
  tag.dataset.pluginCss = tagId;
  tag.textContent = css;
  document.head.appendChild(tag);
}
var SchedulerTab_default = { "scPreviewLabel": "_db05de60_scPreviewLabel", "scPreviewValue": "_a7f561ab_scPreviewValue", "scPreviewError": "_2e5f0482_scPreviewError", "scStatusTitle": "_e6abb38b_scStatusTitle", "scFieldLabel": "_a33ac2fe_scFieldLabel", "scFieldFlex1": "_fc1d373e_scFieldFlex1", "scFieldFlex2": "_bcfbcb11_scFieldFlex2", "scJobActions": "_50348c9f_scJobActions", "scDangerText": "_d0de20ba_scDangerText", "scRunSummary": "_4ebbe9b5_scRunSummary", "scRunOutput": "_5344eabd_scRunOutput", "scTextarea": "_5514676b_scTextarea", "scCheckRow": "_66f8a1c3_scCheckRow", "scBadgeBad": "_371f6a8c_scBadgeBad", "scRunError": "_3c29d7ed_scRunError", "scPreview": "_47add15c_scPreview", "scBadgeOk": "_ba2089a0_scBadgeOk", "scJobMeta": "_a0c1c98e_scJobMeta", "scRunItem": "_36cdc13a_scRunItem", "scRowEnd": "_e1c496ea_scRowEnd", "scSpacer": "_3ba2dc27_scSpacer", "scSelect": "_345516a9_scSelect", "scLedger": "_47ff62f8_scLedger", "scMuted": "_62f14895_scMuted", "scError": "_eb44c5ac_scError", "scTitle": "_ddc9b108_scTitle", "scInput": "_679ed996_scInput", "scBadge": "_26ecbd5d_scBadge", "scRoot": "_487c378e_scRoot", "scCard": "_5d43b0c9_scCard", "scForm": "_202e4e0f_scForm", "scRow": "_28233adb_scRow" };

// src/client/SchedulerTabView.tsx
var import_jsx_runtime = require("react/jsx-runtime");
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
function SchedulerTabView({ t }) {
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
  const [confirming, setConfirming] = (0, import_react.useState)(null);
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
  const fmt = (0, import_react.useCallback)((iso) => {
    if (!iso) return t("emptyDate");
    try {
      return new Date(iso).toLocaleString("zh-CN", { hour12: false });
    } catch {
      return iso;
    }
  }, [t]);
  const triggerKindLabel = (0, import_react.useCallback)((kind) => {
    if (kind === "cron") return t("triggerKindCron");
    if (kind === "interval") return t("triggerKindInterval");
    return t("triggerKindOnce");
  }, [t]);
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
  const runConfirmed = async () => {
    if (!confirming) return;
    const { kind, job } = confirming;
    setConfirming(null);
    if (kind === "delete") {
      await act("DELETE", `/scheduler/jobs/${job.id}`);
      if (runsFor === job.id) {
        setRuns([]);
        setRunsFor(null);
      }
      return;
    }
    if (kind === "pause") {
      await act("POST", `/scheduler/jobs/${job.id}/pause`);
      return;
    }
    if (kind === "resume") {
      await act("POST", `/scheduler/jobs/${job.id}/resume`);
      return;
    }
    await act("POST", `/scheduler/jobs/${job.id}/trigger`);
  };
  const confirmMeta = (kind) => {
    switch (kind) {
      case "delete":
        return { title: t("deleteConfirmTitle"), body: t("deleteConfirmBody", { name: confirming?.job.name ?? "" }), label: t("confirmDelete") };
      case "pause":
        return { title: t("pauseConfirmTitle"), body: t("pauseConfirmBody", { name: confirming?.job.name ?? "" }), label: t("confirmPause") };
      case "resume":
        return { title: t("resumeConfirmTitle"), body: t("resumeConfirmBody", { name: confirming?.job.name ?? "" }), label: t("confirmResume") };
      case "trigger":
        return { title: t("triggerConfirmTitle"), body: t("triggerConfirmBody", { name: confirming?.job.name ?? "" }), label: t("confirmTrigger") };
    }
  };
  const inflightIds = (0, import_react.useMemo)(() => new Set((status?.inflight ?? []).map((i) => i.jobId)), [status]);
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: SchedulerTab_default.scRoot, children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: SchedulerTab_default.scCard, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: SchedulerTab_default.scRow, children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("strong", { className: SchedulerTab_default.scStatusTitle, children: t("tabTitle") }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: SchedulerTab_default.scMuted, children: t("statusTick", { time: fmt(status?.lastTickAt) }) }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: SchedulerTab_default.scMuted, children: t("statusInflight", { inflight: status?.inflight.length ?? 0, max: status?.maxConcurrent ?? "?" }) }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: SchedulerTab_default.scMuted, children: t("statusJobs", { enabled: status?.enabledCount ?? "?", total: status?.jobCount ?? "?" }) }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: SchedulerTab_default.scMuted, children: t("statusBreaker", { n: status?.maxConsecutiveFailures ?? "?" }) }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: SchedulerTab_default.scMuted, children: t("statusCatchUp", { policy: status?.catchUpPolicy ?? "?" }) }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: SchedulerTab_default.scSpacer }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Button, { variant: "outline", size: "sm", onClick: () => void load(), disabled: loading, children: t("refresh") }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Button, { variant: "primary", size: "sm", onClick: openCreate, children: t("newJob") })
      ] }),
      error !== null && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: SchedulerTab_default.scError, children: error })
    ] }),
    showForm ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: SchedulerTab_default.scCard, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h3", { className: SchedulerTab_default.scTitle, children: editing ? t("editJobTitle", { name: editing.name }) : t("newJobTitle") }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("form", { className: SchedulerTab_default.scForm, onSubmit: (e) => void submitForm(e), children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { className: SchedulerTab_default.scFieldLabel, children: [
          t("formName"),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", { className: SchedulerTab_default.scInput, value: form.name, onChange: (e) => setForm({ ...form, name: e.target.value }), placeholder: t("formNamePlaceholder"), required: true })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { className: SchedulerTab_default.scFieldLabel, children: [
          t("formPrompt"),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
            "textarea",
            {
              className: `${SchedulerTab_default.scInput} ${SchedulerTab_default.scTextarea}`,
              value: form.prompt,
              onChange: (e) => setForm({ ...form, prompt: e.target.value }),
              placeholder: t("formPromptPlaceholder"),
              required: true
            }
          )
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: `${SchedulerTab_default.scRow} ${SchedulerTab_default.scRowEnd}`, children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { className: `${SchedulerTab_default.scFieldLabel} ${SchedulerTab_default.scFieldFlex1}`, children: [
            t("formTriggerKind"),
            /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("select", { className: SchedulerTab_default.scSelect, value: form.kind, onChange: (e) => setForm({ ...form, kind: e.target.value }), children: [
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: "cron", children: t("triggerCron") }),
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: "interval", children: t("triggerInterval") }),
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: "once", children: t("triggerOnce") })
            ] })
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { className: `${SchedulerTab_default.scFieldLabel} ${SchedulerTab_default.scFieldFlex2}`, children: [
            t("formExpression"),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
              "input",
              {
                className: SchedulerTab_default.scInput,
                value: form.expression,
                onChange: (e) => setForm({ ...form, expression: e.target.value }),
                placeholder: t(form.kind === "cron" ? "exprPlaceholderCron" : form.kind === "interval" ? "exprPlaceholderInterval" : "exprPlaceholderOnce"),
                required: true
              }
            )
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { className: `${SchedulerTab_default.scFieldLabel} ${SchedulerTab_default.scFieldFlex1}`, children: [
            t("formTimezone"),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
              "input",
              {
                className: SchedulerTab_default.scInput,
                value: form.timezone,
                onChange: (e) => setForm({ ...form, timezone: e.target.value }),
                placeholder: t("timezonePlaceholder")
              }
            )
          ] })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { className: SchedulerTab_default.scFieldLabel, children: [
          t("formWorkspace"),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
            "input",
            {
              className: SchedulerTab_default.scInput,
              value: form.workspace,
              onChange: (e) => setForm({ ...form, workspace: e.target.value }),
              placeholder: t("workspacePlaceholder")
            }
          )
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: `${SchedulerTab_default.scRow} ${SchedulerTab_default.scRowEnd}`, children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { className: `${SchedulerTab_default.scFieldLabel} ${SchedulerTab_default.scFieldFlex2}`, children: [
            t("formDeliverTo"),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
              "input",
              {
                className: SchedulerTab_default.scInput,
                value: form.deliverTo,
                onChange: (e) => setForm({ ...form, deliverTo: e.target.value }),
                placeholder: t("deliverToPlaceholder")
              }
            )
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { className: `${SchedulerTab_default.scFieldLabel} ${SchedulerTab_default.scFieldFlex1}`, children: [
            t("formCatchUp"),
            /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
              "select",
              {
                className: SchedulerTab_default.scSelect,
                value: form.catchUpPolicy,
                onChange: (e) => setForm({ ...form, catchUpPolicy: e.target.value }),
                children: [
                  /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: "", children: t("catchUpGlobal") }),
                  /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: "run_once", children: t("catchUpRunOnce") }),
                  /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: "skip", children: t("catchUpSkip") })
                ]
              }
            )
          ] })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { className: SchedulerTab_default.scCheckRow, children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
            "input",
            {
              type: "checkbox",
              checked: form.enabled,
              onChange: (e) => setForm({ ...form, enabled: e.target.checked })
            }
          ),
          " ",
          t("formEnabled")
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: SchedulerTab_default.scPreview, children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("strong", { className: SchedulerTab_default.scPreviewLabel, children: t("previewLabel") }),
          preview ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: SchedulerTab_default.scPreviewValue, children: preview.map((iso) => fmt(iso)).join(t("previewSeparator")) }) : previewError ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: SchedulerTab_default.scPreviewError, children: previewError }) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: SchedulerTab_default.scMuted, children: t("previewPending") })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: SchedulerTab_default.scRow, children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Button, { variant: "primary", size: "sm", type: "submit", disabled: busy, children: busy ? t("saving") : t("save") }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Button, { variant: "ghost", size: "sm", onClick: () => {
            setShowForm(false);
            setEditing(null);
          }, children: t("cancel") })
        ] })
      ] })
    ] }) : null,
    jobs.length === 0 && !loading ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: SchedulerTab_default.scCard, children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: SchedulerTab_default.scMuted, children: t("noJobs") }) }) : jobs.map((job) => {
      const running = inflightIds.has(job.id);
      return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: SchedulerTab_default.scCard, children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: SchedulerTab_default.scRow, children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("strong", { children: job.name }),
          job.state === "paused" ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: SchedulerTab_default.scBadgeBad, children: job.pausedReason === "max_consecutive_failures" ? t("pausedBreaker") : t("paused") }) : job.enabled && job.state === "scheduled" ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: SchedulerTab_default.scBadgeOk, children: t("enabledBadge") }) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: SchedulerTab_default.scBadgeBad, children: t("completedBadge") }),
          running ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: SchedulerTab_default.scBadge, children: t("running") }) : null,
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: SchedulerTab_default.scSpacer }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Button, { variant: "outline", size: "sm", disabled: running, onClick: () => setConfirming({ kind: "trigger", job }), children: t("triggerNow") }),
          job.state === "paused" ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Button, { variant: "outline", size: "sm", onClick: () => setConfirming({ kind: "resume", job }), children: t("resume") }) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Button, { variant: "outline", size: "sm", onClick: () => setConfirming({ kind: "pause", job }), children: t("pause") }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Button, { variant: "ghost", size: "sm", onClick: () => openEdit(job), children: t("edit") }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Button, { variant: "ghost", size: "sm", icon: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.IconTrashOutline16, {}), className: SchedulerTab_default.scDangerText, onClick: () => setConfirming({ kind: "delete", job }), children: t("delete") })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: SchedulerTab_default.scJobMeta, children: [
          `${triggerKindLabel(job.trigger.kind)} ${job.trigger.expression} ${job.trigger.timezone}`,
          job.workspace ? job.workspace : null,
          job.deliverTo ? t("deliveryTo", { id: job.deliverTo.sessionId }) : null,
          job.catchUpPolicy ? t("catchUpTag", { policy: job.catchUpPolicy }) : null
        ].filter(Boolean).join(t("separator")) }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: SchedulerTab_default.scJobActions, children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: SchedulerTab_default.scMuted, children: t("nextRun", { time: fmt(job.nextRunAt) }) }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: SchedulerTab_default.scMuted, children: t("lastRun", { time: fmt(job.lastRunAt) }) }),
          job.lastStatus ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: job.lastStatus === "succeeded" ? SchedulerTab_default.scBadgeOk : SchedulerTab_default.scBadgeBad, children: job.lastStatus }) : null,
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: SchedulerTab_default.scMuted, children: t("runCount", { count: job.runCount }) }),
          job.consecutiveFailures > 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: SchedulerTab_default.scBadgeBad, children: t("consecutiveFailures", { count: job.consecutiveFailures }) }) : null,
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: SchedulerTab_default.scSpacer }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
            import_dsh_client_ui_primitives.Button,
            {
              variant: "ghost",
              size: "sm",
              onClick: () => void (runsFor === job.id ? (setRuns([]), setRunsFor(null)) : loadRuns(job.id)),
              children: runsFor === job.id ? t("collapseHistory") : t("runHistory")
            }
          )
        ] }),
        runsFor === job.id ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: SchedulerTab_default.scLedger, children: runs.length === 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: SchedulerTab_default.scMuted, children: t("noRuns") }) : runs.map((r) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("details", { className: SchedulerTab_default.scRunItem, children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("summary", { className: SchedulerTab_default.scRunSummary, children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: SchedulerTab_default.scRow, children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: r.status === "succeeded" ? SchedulerTab_default.scBadgeOk : r.status === "failed" ? SchedulerTab_default.scBadgeBad : SchedulerTab_default.scBadge, children: r.status }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: SchedulerTab_default.scMuted, children: r.triggerKind === "manual" ? t("runManual") : t("runScheduled") }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: SchedulerTab_default.scMuted, children: t("triggeredAt", { time: fmt(r.scheduledFor) }) }),
            r.durationMs !== void 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: SchedulerTab_default.scMuted, children: t("duration", { s: (r.durationMs / 1e3).toFixed(1) }) }) : null,
            r.exitCode !== void 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: SchedulerTab_default.scMuted, children: t("exitCode", { code: r.exitCode }) }) : null,
            r.delivery ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: r.delivery.status === "delivered" ? SchedulerTab_default.scBadgeOk : r.delivery.status === "error" ? SchedulerTab_default.scBadgeBad : SchedulerTab_default.scBadge, children: r.delivery.status === "delivered" ? t("deliveredTo", { id: r.delivery.sessionId ?? "" }) : t("deliveryStatus", { status: r.delivery.status }) }) : null,
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: SchedulerTab_default.scSpacer }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: SchedulerTab_default.scMuted, children: fmt(r.completedAt ?? r.startedAt) })
          ] }) }),
          r.error ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("pre", { className: SchedulerTab_default.scRunError, children: r.error }) : null,
          r.outputHead ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("pre", { className: SchedulerTab_default.scRunOutput, children: r.outputHead }) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: SchedulerTab_default.scMuted, children: t("noOutput") })
        ] }, r.id)) }) : null
      ] }, job.id);
    }),
    confirming !== null && /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
      import_dsh_client_ui_primitives.Modal,
      {
        open: true,
        onClose: () => setConfirming(null),
        title: confirmMeta(confirming.kind).title,
        closeLabel: t("cancel"),
        description: confirmMeta(confirming.kind).body,
        footer: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Button, { variant: "ghost", size: "sm", onClick: () => setConfirming(null), children: t("cancel") }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Button, { variant: "primary", size: "sm", onClick: () => void runConfirmed(), children: confirmMeta(confirming.kind).label })
        ] })
      }
    )
  ] });
}

// src/client/locales.ts
var en = {
  tabTitle: "Scheduled jobs",
  statusTick: "tick: {time}",
  statusInflight: "inflight: {inflight}/{max}",
  statusJobs: "jobs: {enabled}/{total} enabled",
  statusBreaker: "breaker: {n} consecutive failures",
  statusCatchUp: "catch-up: {policy}",
  refresh: "Refresh",
  newJob: "+ New job",
  newJobTitle: "New job",
  editJobTitle: "Edit job: {name}",
  formName: "Name",
  formNamePlaceholder: "e.g. Daily CI patrol",
  formPrompt: "Prompt (runs in a fresh headless session; must be self-contained)",
  formPromptPlaceholder: "Check CI status and summarize the results",
  formTriggerKind: "Trigger type",
  triggerCron: "cron (5-field expression)",
  triggerInterval: "interval (e.g. 30m / 2h)",
  triggerOnce: "once (ISO time)",
  formExpression: "Expression",
  exprPlaceholderCron: "0 9 * * 1-5",
  exprPlaceholderInterval: "30m",
  exprPlaceholderOnce: "2026-08-16T09:00:00+08:00",
  formTimezone: "Timezone",
  timezonePlaceholder: "local / Asia/Shanghai",
  formWorkspace: "Workspace (headless run cwd; empty uses the default)",
  workspacePlaceholder: "e.g. /path/to/job/workspace",
  formDeliverTo: "Result delivery session (deliverTo; empty = no delivery)",
  deliverToPlaceholder: "Target session ID; results follow up there while that session is online",
  formCatchUp: "Catch-up policy",
  catchUpGlobal: "Follow global (run_once)",
  catchUpRunOnce: "run_once (run once after a miss)",
  catchUpSkip: "skip (skip when too late)",
  formEnabled: "Enabled",
  previewLabel: "Next 5 occurrences:",
  previewSeparator: " | ",
  previewPending: "\u2026",
  saving: "Saving\u2026",
  save: "Save",
  cancel: "Cancel",
  noJobs: 'No scheduled jobs yet \u2014 click "+ New job" to create the first one.',
  pausedBreaker: "Paused (circuit breaker)",
  paused: "Paused",
  enabledBadge: "Enabled",
  completedBadge: "Completed",
  running: "Running\u2026",
  triggerNow: "Trigger now",
  resume: "Resume",
  pause: "Pause",
  edit: "Edit",
  delete: "Delete",
  triggerKindCron: "cron",
  triggerKindInterval: "interval",
  triggerKindOnce: "once",
  separator: " \xB7 ",
  deliveryTo: "deliver \u2192 {id}",
  catchUpTag: "catch-up: {policy}",
  nextRun: "next: {time}",
  lastRun: "last: {time}",
  runCount: "{count} run(s)",
  consecutiveFailures: "{count} consecutive failure(s)",
  collapseHistory: "Hide history",
  runHistory: "Run history",
  noRuns: "No run records",
  runManual: "manual",
  runScheduled: "scheduled",
  triggeredAt: "triggered at {time}",
  duration: "{s}s",
  exitCode: "exit {code}",
  deliveredTo: "delivered \u2192 {id}",
  deliveryStatus: "delivery: {status}",
  noOutput: "(no output)",
  emptyDate: "\u2014",
  deleteConfirmTitle: "Delete job",
  deleteConfirmBody: 'Delete job "{name}"? Its run ledger will be deleted too.',
  pauseConfirmTitle: "Pause job",
  pauseConfirmBody: 'Pause job "{name}"? It will stop triggering and can be resumed anytime.',
  resumeConfirmTitle: "Resume job",
  resumeConfirmBody: 'Resume job "{name}"? It will resume triggering per its schedule.',
  triggerConfirmTitle: "Trigger now",
  triggerConfirmBody: 'Manually trigger job "{name}"? This creates one manual run.',
  confirmDelete: "Delete",
  confirmPause: "Pause",
  confirmResume: "Resume",
  confirmTrigger: "Trigger"
};
var zh = {
  tabTitle: "\u5B9A\u65F6\u4EFB\u52A1",
  statusTick: "tick: {time}",
  statusInflight: "\u5728\u98DE: {inflight}/{max}",
  statusJobs: "\u4EFB\u52A1: {enabled}/{total} \u542F\u7528",
  statusBreaker: "\u7194\u65AD: {n} \u8FDE\u8D25",
  statusCatchUp: "\u8FFD\u8D76: {policy}",
  refresh: "\u5237\u65B0",
  newJob: "+ \u65B0\u5EFA\u4EFB\u52A1",
  newJobTitle: "\u65B0\u5EFA\u4EFB\u52A1",
  editJobTitle: "\u7F16\u8F91\u4EFB\u52A1\uFF1A{name}",
  formName: "\u540D\u79F0",
  formNamePlaceholder: "\u5982\uFF1A\u6BCF\u65E5 CI \u5DE1\u68C0",
  formPrompt: "\u4EFB\u52A1 prompt\uFF08headless \u5168\u65B0\u4F1A\u8BDD\u6267\u884C\uFF0C\u9700\u81EA\u5305\u542B\uFF09",
  formPromptPlaceholder: "\u68C0\u67E5 CI \u72B6\u6001\u5E76\u6C47\u603B\u7ED3\u679C",
  formTriggerKind: "\u89E6\u53D1\u7C7B\u578B",
  triggerCron: "cron\uFF085 \u6BB5\u8868\u8FBE\u5F0F\uFF09",
  triggerInterval: "\u95F4\u9694\uFF08\u5982 30m / 2h\uFF09",
  triggerOnce: "\u4E00\u6B21\u6027\uFF08ISO \u65F6\u95F4\uFF09",
  formExpression: "\u8868\u8FBE\u5F0F",
  exprPlaceholderCron: "0 9 * * 1-5",
  exprPlaceholderInterval: "30m",
  exprPlaceholderOnce: "2026-08-16T09:00:00+08:00",
  formTimezone: "\u65F6\u533A",
  timezonePlaceholder: "local / Asia/Shanghai",
  formWorkspace: "\u5DE5\u4F5C\u533A\uFF08headless \u8FD0\u884C cwd\uFF0C\u7559\u7A7A\u7528\u9ED8\u8BA4\uFF09",
  workspacePlaceholder: "\u5982 /path/to/job/workspace",
  formDeliverTo: "\u7ED3\u679C\u6295\u9012\u4F1A\u8BDD\uFF08deliverTo\uFF0C\u7559\u7A7A\u4E0D\u6295\u9012\uFF09",
  deliverToPlaceholder: "\u76EE\u6807\u4F1A\u8BDD ID\uFF1B\u8BE5\u4F1A\u8BDD\u5728\u7EBF\u65F6\u7ED3\u679C followup \u8FDB\u53BB",
  formCatchUp: "\u8FFD\u8D76\u7B56\u7565",
  catchUpGlobal: "\u8DDF\u968F\u5168\u5C40\uFF08run_once\uFF09",
  catchUpRunOnce: "run_once\uFF08\u9519\u8FC7\u8865\u8DD1\u4E00\u6B21\uFF09",
  catchUpSkip: "skip\uFF08\u8D85\u65F6\u5DEE\u5373\u8DF3\u8FC7\uFF09",
  formEnabled: "\u542F\u7528",
  previewLabel: "\u672A\u6765 5 \u6B21\u89E6\u53D1\uFF1A",
  previewSeparator: " \uFF5C ",
  previewPending: "\u2026",
  saving: "\u4FDD\u5B58\u4E2D\u2026",
  save: "\u4FDD\u5B58",
  cancel: "\u53D6\u6D88",
  noJobs: "\u6682\u65E0\u5B9A\u65F6\u4EFB\u52A1\uFF0C\u70B9\u300C+ \u65B0\u5EFA\u4EFB\u52A1\u300D\u521B\u5EFA\u7B2C\u4E00\u4E2A\u3002",
  pausedBreaker: "\u5DF2\u7194\u65AD\u6682\u505C",
  paused: "\u5DF2\u6682\u505C",
  enabledBadge: "\u542F\u7528",
  completedBadge: "\u5DF2\u5B8C\u6210",
  running: "\u8FD0\u884C\u4E2D\u2026",
  triggerNow: "\u7ACB\u5373\u89E6\u53D1",
  resume: "\u6062\u590D",
  pause: "\u6682\u505C",
  edit: "\u7F16\u8F91",
  delete: "\u5220\u9664",
  triggerKindCron: "cron",
  triggerKindInterval: "\u95F4\u9694",
  triggerKindOnce: "\u4E00\u6B21\u6027",
  separator: " \xB7 ",
  deliveryTo: "\u6295\u9012\u2192{id}",
  catchUpTag: "\u8FFD\u8D76:{policy}",
  nextRun: "\u4E0B\u6B21: {time}",
  lastRun: "\u4E0A\u6B21: {time}",
  runCount: "\u8FD0\u884C {count} \u6B21",
  consecutiveFailures: "\u8FDE\u7EED\u5931\u8D25 {count}",
  collapseHistory: "\u6536\u8D77\u5386\u53F2",
  runHistory: "\u8FD0\u884C\u5386\u53F2",
  noRuns: "\u6682\u65E0\u8FD0\u884C\u8BB0\u5F55",
  runManual: "\u624B\u52A8",
  runScheduled: "\u5B9A\u65F6",
  triggeredAt: "\u89E6\u53D1\u4E8E {time}",
  duration: "\u8017\u65F6 {s}s",
  exitCode: "exit {code}",
  deliveredTo: "\u5DF2\u6295\u9012\u2192{id}",
  deliveryStatus: "\u6295\u9012:{status}",
  noOutput: "\uFF08\u65E0\u8F93\u51FA\uFF09",
  emptyDate: "\u2014",
  deleteConfirmTitle: "\u5220\u9664\u4EFB\u52A1",
  deleteConfirmBody: "\u5220\u9664\u4EFB\u52A1\u300C{name}\u300D\uFF1F\u8FD0\u884C\u53F0\u8D26\u5C06\u4E00\u5E76\u5220\u9664\u3002",
  pauseConfirmTitle: "\u6682\u505C\u4EFB\u52A1",
  pauseConfirmBody: "\u6682\u505C\u4EFB\u52A1\u300C{name}\u300D\uFF1F\u6682\u505C\u540E\u4E0D\u4F1A\u89E6\u53D1\uFF0C\u53EF\u968F\u65F6\u6062\u590D\u3002",
  resumeConfirmTitle: "\u6062\u590D\u4EFB\u52A1",
  resumeConfirmBody: "\u6062\u590D\u4EFB\u52A1\u300C{name}\u300D\uFF1F\u6062\u590D\u540E\u6309\u539F\u8BA1\u5212\u7EE7\u7EED\u89E6\u53D1\u3002",
  triggerConfirmTitle: "\u7ACB\u5373\u89E6\u53D1",
  triggerConfirmBody: "\u7ACB\u5373\u89E6\u53D1\u4EFB\u52A1\u300C{name}\u300D\uFF1F\u5C06\u521B\u5EFA\u4E00\u6B21\u624B\u52A8\u8FD0\u884C\u3002",
  confirmDelete: "\u5220\u9664",
  confirmPause: "\u6682\u505C",
  confirmResume: "\u6062\u590D",
  confirmTrigger: "\u89E6\u53D1"
};
var NS = "scheduler";

// src/client/index.ts
var inject = ["slots", "conversation", "locale"];
function apply(ctx) {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-scheduler: dictionaries");
  const t = ctx.locale.bind(NS);
  let disposeTab;
  disposeTab = ctx.slots.inject("conversation.view", () => ctx.slots.register({
    name: "conversation.view",
    id: "scheduler",
    order: 96,
    locale: NS,
    label: () => t("tabTitle")
  }, (props) => SchedulerTabView({ ...props })));
  ctx.on("dispose", () => disposeTab?.());
}
return module.exports; } });
