/**
 * "Auto-Sync" tab renderer: modular status hero, 2-column strategy & triggers bento,
 * fluid AI pill chips + MCP filter scope card, and live activity logs.
 */

import { el, svgEl } from "../dom.mjs";

function makeSyncIcon() {
  return svgEl(
    "svg",
    {
      width: 19,
      height: 19,
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: "currentColor",
      "stroke-width": 2,
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
      "aria-hidden": "true",
    },
    [
      svgEl("path", { d: "M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" }),
      svgEl("path", { d: "M3 3v5h5" }),
      svgEl("path", { d: "M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" }),
      svgEl("path", { d: "M16 16h5v5" }),
    ],
  );
}

function makeShieldIcon() {
  return svgEl(
    "svg",
    {
      width: 13,
      height: 13,
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: "currentColor",
      "stroke-width": 2.2,
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
      "aria-hidden": "true",
    },
    [
      svgEl("path", { d: "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" }),
      svgEl("path", { d: "m9 12 2 2 4-4" }),
    ],
  );
}

function formatShortTime(iso) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleTimeString([], { hour12: false });
  } catch {
    return iso;
  }
}

export function renderAutoSyncTab(ctx) {
  const { state, api, t, render, showToast, managedTargets } = ctx;
  const managed = managedTargets();
  const cfg = state.overview?.autoSync ?? {
    enabled: false,
    mode: "bidirectional",
    primaryTargetId: managed[0]?.id || "",
    updateScope: "existing-only",
    mcpScope: "all",
    selectedMcpNames: [],
    targetIds: managed.map((x) => x.id),
    syncAdditions: true,
    syncUpdates: true,
    syncRemovals: false,
  };
  const logs = state.overview?.autoSyncLogs ?? [];

  const uniqueMcpNames = [...new Set((state.overview?.servers ?? []).map((s) => s.name))].sort((a, b) =>
    a.toLowerCase().localeCompare(b.toLowerCase()),
  );
  const selectedMcpSet = new Set(cfg.selectedMcpNames ?? []);
  const selectedTargetSet = new Set(cfg.targetIds ?? []);
  const primaryTarget = managed.find((x) => x.id === cfg.primaryTargetId) || managed[0];

  async function patchConfig(patch) {
    try {
      state.overview = await api.backend.invoke("autosync/set-config", patch);
      render();
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), true);
    }
  }

  const statusText = !cfg.enabled
    ? t("autoSyncStatusOff")
    : cfg.mcpScope === "selected"
      ? t("autoSyncStatusOnScoped", { mcps: selectedMcpSet.size, count: selectedTargetSet.size })
      : t("autoSyncStatusOn", { count: selectedTargetSet.size });

  const modeSummary =
    cfg.mode === "primary"
      ? t("autoSyncSummaryPrimary", { name: primaryTarget?.shortName || primaryTarget?.name || "-" })
      : t("autoSyncSummaryBi");
  const scopeSummary =
    cfg.updateScope === "all-selected" ? t("autoSyncSummaryAll") : t("autoSyncSummaryExisting");
  const mcpSummary =
    cfg.mcpScope === "selected"
      ? t("autoSyncSummaryMcpScoped", { count: selectedMcpSet.size })
      : t("autoSyncSummaryMcpAll", { count: uniqueMcpNames.length });

  // 1. Hero Status Card
  const heroCard = el("div", { className: "mh-as-card mh-as-hero" }, [
    el("div", { className: "mh-as-hero-top" }, [
      el("div", { className: "mh-as-hero-left" }, [
        el("div", { className: `mh-as-hero-icon ${cfg.enabled ? "is-on" : ""}` }, [makeSyncIcon()]),
        el("div", { className: "mh-as-hero-copy" }, [
          el("div", { className: "mh-as-hero-title-row" }, [
            el("h3", { text: t("autoSyncPanelTitle") }),
            el("span", { className: `mh-status-pill ${cfg.enabled ? "is-on" : ""}` }, [
              cfg.enabled ? el("span", { className: "mh-live-dot" }) : null,
              el("span", { text: statusText }),
            ]),
          ]),
          el("p", { className: "mh-as-hero-desc", text: t("autoSyncPanelDesc") }),
        ]),
      ]),
      el(
        "button",
        {
          className: `mh-toggle-btn mh-toggle-lg ${cfg.enabled ? "is-on" : ""}`,
          role: "switch",
          "aria-checked": String(Boolean(cfg.enabled)),
          "aria-label": t("autoSyncPanelTitle"),
          onClick: () => patchConfig({ enabled: !cfg.enabled }),
        },
        [el("span", { className: "mh-toggle-thumb" })],
      ),
    ]),
    el("div", { className: "mh-as-hero-summary" }, [
      el("div", { className: "mh-as-summary-pills" }, [
        el("span", { className: "mh-as-meta-chip", text: modeSummary }),
        el("span", { className: "mh-as-meta-sep", text: "·" }),
        el("span", { className: "mh-as-meta-chip", text: scopeSummary }),
        el("span", { className: "mh-as-meta-sep", text: "·" }),
        el("span", { className: "mh-as-meta-chip", text: mcpSummary }),
      ]),
      el("div", { className: "mh-as-guard-inline" }, [
        el("span", { className: "mh-as-guard-icon" }, [makeShieldIcon()]),
        el("span", { text: t("autoSyncGuardStrip") }),
      ]),
    ]),
  ]);

  // 2A. Strategy Card (Left of Bento)
  const strategyCard = el("div", { className: "mh-as-card" }, [
    el("div", { className: "mh-as-card-head" }, [
      el("span", { className: "mh-as-card-title", text: t("autoSyncStrategyTitle") }),
      el("span", { className: "mh-as-card-sub", text: t("autoSyncStrategySub") }),
    ]),
    el("div", { className: "mh-as-card-body" }, [
      el("div", { className: "mh-as-field-group" }, [
        el("div", { className: "mh-as-field-label", text: t("autoSyncModeLabel") }),
        el("div", { className: "mh-as-opt-grid" }, [
          el(
            "button",
            {
              className: `mh-as-opt ${cfg.mode === "bidirectional" ? "is-active" : ""}`,
              onClick: () => patchConfig({ mode: "bidirectional" }),
            },
            [
              el("div", { className: "mh-as-opt-top" }, [
                el("span", { className: "mh-as-opt-title", text: t("autoSyncModeBiTitle") }),
                el("span", { className: "mh-as-radio-dot" }),
              ]),
              el("div", { className: "mh-as-opt-desc", text: t("autoSyncModeBiDesc") }),
            ],
          ),
          el(
            "button",
            {
              className: `mh-as-opt ${cfg.mode === "primary" ? "is-active" : ""}`,
              onClick: () =>
                patchConfig({
                  mode: "primary",
                  primaryTargetId: cfg.primaryTargetId || managed[0]?.id || "",
                }),
            },
            [
              el("div", { className: "mh-as-opt-top" }, [
                el("span", { className: "mh-as-opt-title", text: t("autoSyncModePrimaryTitle") }),
                el("span", { className: "mh-as-radio-dot" }),
              ]),
              el("div", { className: "mh-as-opt-desc", text: t("autoSyncModePrimaryDesc") }),
            ],
          ),
        ]),
        cfg.mode === "primary" && managed.length > 0
          ? el("div", { className: "mh-primary-select-row" }, [
              el("strong", { text: t("autoSyncPrimarySelectLabel") }),
              el(
                "select",
                {
                  className: "mh-select",
                  value: cfg.primaryTargetId || managed[0].id,
                  onChange: (e) => patchConfig({ primaryTargetId: e.target.value }),
                },
                managed.map((tg) => el("option", { value: tg.id, text: tg.name })),
              ),
            ])
          : null,
      ]),
      el("div", { className: "mh-as-field-group" }, [
        el("div", { className: "mh-as-field-label", text: t("autoSyncScopeLabel") }),
        el("div", { className: "mh-as-opt-grid" }, [
          el(
            "button",
            {
              className: `mh-as-opt ${cfg.updateScope === "existing-only" ? "is-active" : ""}`,
              onClick: () => patchConfig({ updateScope: "existing-only" }),
            },
            [
              el("div", { className: "mh-as-opt-top" }, [
                el("span", { className: "mh-as-opt-title" }, [
                  el("span", { text: t("autoSyncScopeExistingTitle") }),
                  el("span", { className: "mh-as-badge-rec", text: t("autoSyncScopeExistingBadge") }),
                ]),
                el("span", { className: "mh-as-radio-dot" }),
              ]),
              el("div", { className: "mh-as-opt-desc", text: t("autoSyncScopeExistingDesc") }),
            ],
          ),
          el(
            "button",
            {
              className: `mh-as-opt ${cfg.updateScope === "all-selected" ? "is-active" : ""}`,
              onClick: () => patchConfig({ updateScope: "all-selected" }),
            },
            [
              el("div", { className: "mh-as-opt-top" }, [
                el("span", { className: "mh-as-opt-title", text: t("autoSyncScopeAllTitle") }),
                el("span", { className: "mh-as-radio-dot" }),
              ]),
              el("div", { className: "mh-as-opt-desc", text: t("autoSyncScopeAllDesc") }),
            ],
          ),
        ]),
      ]),
    ]),
  ]);

  // 2B. Trigger Actions Card (Right of Bento)
  function renderActionRow({ title, desc, warnBadge, checked, onToggle }) {
    return el(
      "div",
      {
        className: "mh-as-action-row",
        onClick: onToggle,
      },
      [
        el("div", { className: "mh-as-action-info" }, [
          el("div", { className: "mh-as-action-title" }, [
            el("span", { text: title }),
            warnBadge ? el("span", { className: "mh-as-badge-warn", text: warnBadge }) : null,
          ]),
          el("div", { className: "mh-as-action-desc", text: desc }),
        ]),
        el(
          "button",
          {
            className: `mh-toggle-btn mh-toggle-sm ${checked ? "is-on" : ""}`,
            role: "switch",
            "aria-checked": String(Boolean(checked)),
            "aria-label": title,
            onClick: (e) => {
              e.stopPropagation();
              onToggle();
            },
          },
          [el("span", { className: "mh-toggle-thumb" })],
        ),
      ],
    );
  }

  const actionsCard = el("div", { className: "mh-as-card mh-as-card-stretch" }, [
    el("div", { className: "mh-as-card-head" }, [
      el("span", { className: "mh-as-card-title", text: t("autoSyncRulesLabel") }),
      el("span", { className: "mh-as-card-sub", text: t("autoSyncRulesSub") }),
    ]),
    el("div", { className: "mh-as-action-rows" }, [
      renderActionRow({
        title: t("autoSyncRuleAddTitle"),
        desc: t("autoSyncRuleAddDesc"),
        checked: cfg.syncAdditions,
        onToggle: () => patchConfig({ syncAdditions: !cfg.syncAdditions }),
      }),
      renderActionRow({
        title: t("autoSyncRuleUpdateTitle"),
        desc: t("autoSyncRuleUpdateDesc"),
        checked: cfg.syncUpdates,
        onToggle: () => patchConfig({ syncUpdates: !cfg.syncUpdates }),
      }),
      renderActionRow({
        title: t("autoSyncRuleRemoveTitle"),
        desc: t("autoSyncRuleRemoveDesc"),
        warnBadge: t("autoSyncRuleRemoveWarn"),
        checked: cfg.syncRemovals,
        onToggle: () => patchConfig({ syncRemovals: !cfg.syncRemovals }),
      }),
    ]),
  ]);

  const bentoGrid = el("div", { className: `mh-as-bento ${cfg.enabled ? "" : "is-paused"}` }, [
    strategyCard,
    actionsCard,
  ]);

  // 3. Scope Card (AI Pill Chips + MCP Scope Filter)
  const scopeCard = el("div", { className: `mh-as-card ${cfg.enabled ? "" : "is-paused"}` }, [
    el("div", { className: "mh-as-scope-section" }, [
      el("div", { className: "mh-as-scope-head" }, [
        el("div", { className: "mh-as-card-title" }, [
          el("span", { text: t("autoSyncTargetsTitle") }),
          el("span", { className: "mh-as-count-pill", text: `${selectedTargetSet.size} / ${managed.length}` }),
        ]),
        el("div", { className: "mh-actions" }, [
          el("button", {
            className: "mh-btn-link",
            text: t("btnSelectAll"),
            onClick: () => patchConfig({ targetIds: managed.map((x) => x.id) }),
          }),
          el("button", {
            className: "mh-btn-link",
            text: t("btnSelectNone"),
            onClick: () => patchConfig({ targetIds: [] }),
          }),
        ]),
      ]),
      el(
        "div",
        { className: "mh-as-ai-pills" },
        managed.map((tg) => {
          const on = selectedTargetSet.has(tg.id);
          return el(
            "button",
            {
              className: `mh-as-ai-pill ${on ? "is-on" : ""}`,
              "aria-pressed": String(on),
              onClick: () => {
                const next = on
                  ? [...selectedTargetSet].filter((id) => id !== tg.id)
                  : [...selectedTargetSet, tg.id];
                void patchConfig({ targetIds: next });
              },
            },
            [
              el("span", { className: "mh-as-ai-dot" }),
              el("span", { text: tg.shortName || tg.name }),
              on ? el("span", { className: "mh-as-ai-chk", text: "✓" }) : null,
            ],
          );
        }),
      ),
    ]),
    el("div", { className: "mh-as-scope-section" }, [
      el("div", { className: "mh-as-scope-head mh-as-scope-head-tight" }, [
        el("div", {}, [
          el("div", { className: "mh-as-card-title", text: t("autoSyncMcpScopeLabel") }),
          el("div", { className: "mh-row-sub", text: t("autoSyncMcpScopeDesc") }),
        ]),
        el("div", { className: "mh-pill-seg" }, [
          el("button", {
            className: cfg.mcpScope === "all" ? "is-active" : "",
            text: t("autoSyncMcpAll", { count: uniqueMcpNames.length }),
            onClick: () => patchConfig({ mcpScope: "all" }),
          }),
          el("button", {
            className: cfg.mcpScope === "selected" ? "is-active" : "",
            text: t("autoSyncMcpSelected", { count: selectedMcpSet.size }),
            onClick: () =>
              patchConfig({
                mcpScope: "selected",
                selectedMcpNames:
                  selectedMcpSet.size > 0 ? [...selectedMcpSet] : uniqueMcpNames.slice(0, uniqueMcpNames.length),
              }),
          }),
        ]),
      ]),
      cfg.mcpScope === "selected"
        ? uniqueMcpNames.length === 0
          ? el("div", { className: "mh-row-sub", style: "margin-top:8px", text: t("autoSyncMcpEmpty") })
          : el(
              "div",
              { className: "mh-mcp-chips" },
              uniqueMcpNames.map((name) => {
                const active = selectedMcpSet.has(name);
                return el("button", {
                  className: `mh-mcp-chip ${active ? "is-on" : ""}`,
                  text: `${active ? "✓ " : ""}${name}`,
                  onClick: () => {
                    const next = active
                      ? [...selectedMcpSet].filter((x) => x !== name)
                      : [...selectedMcpSet, name];
                    void patchConfig({ selectedMcpNames: next });
                  },
                });
              }),
            )
        : null,
    ]),
  ]);

  // 4. Recent Activity Logs Card
  const logsCard = el("div", { className: "mh-as-card" }, [
    el("div", { className: "mh-as-card-head" }, [
      el("div", { className: "mh-as-card-title" }, [
        el("span", { text: t("autoSyncLogsTitle") }),
        el("span", { className: "mh-as-count-pill", text: String(logs.length) }),
      ]),
      el("div", { className: "mh-actions" }, [
        el("span", { className: "mh-as-card-sub", text: t("autoSyncLogsDesc") }),
        logs.length > 0
          ? el("button", {
              className: "mh-btn-link",
              text: t("btnSelectNone"),
              onClick: async () => {
                try {
                  await api.backend.invoke("autosync/clear-logs");
                  if (state.overview) state.overview.autoSyncLogs = [];
                  render();
                } catch (err) {
                  showToast(err instanceof Error ? err.message : String(err), true);
                }
              },
            })
          : null,
      ]),
    ]),
    logs.length === 0
      ? el("div", { className: "mh-as-log-empty", text: t("autoSyncLogsEmpty") })
      : el(
          "div",
          { className: "mh-as-log-list" },
          logs.map((entry) => {
            const actionLabel =
              entry.action === "add"
                ? t("autoSyncActionAdd")
                : entry.action === "update"
                  ? t("autoSyncActionUpdate")
                  : entry.action === "remove"
                    ? t("autoSyncActionRemove")
                    : entry.action === "skip"
                      ? t("autoSyncActionSkip")
                      : t("autoSyncActionBlocked");
            const actionCls =
              entry.action === "add"
                ? "mh-tag-ok"
                : entry.action === "update"
                  ? "mh-tag-accent"
                  : entry.action === "remove" || entry.action === "blocked"
                    ? "mh-tag-danger"
                    : "mh-tag-mono";

            let routeText = entry.sourceName || entry.sourceTargetId || "";
            if (entry.action === "skip") {
              const reason =
                entry.detail === "builtin"
                  ? t("autoSyncDetailBuiltin")
                  : t("autoSyncDetailLoopback");
              routeText = `${routeText} · ${reason}`;
            } else if (entry.action === "blocked") {
              const reason =
                entry.detail === "mass-wipe-guard" ? t("autoSyncDetailMassWipe") : entry.detail;
              routeText = `${routeText} · ${reason}`;
            } else {
              const destStr = (entry.destNames ?? []).join("、");
              const suffix =
                entry.detail === "existing-only" ? ` ${t("autoSyncDetailExistingOnly")}` : "";
              routeText = `${routeText} → ${destStr}${suffix}`;
            }

            const statusBadgeText =
              entry.status === "protected"
                ? t("autoSyncBadgeProtected")
                : entry.status === "blocked"
                  ? t("autoSyncBadgeBlocked")
                  : t("autoSyncBadgeSynced");
            const statusBadgeCls =
              entry.status === "blocked"
                ? "mh-tag-danger"
                : entry.status === "synced"
                  ? "mh-tag-ok"
                  : "";

            return el("div", { className: "mh-log-row" }, [
              el("div", { className: "mh-log-left" }, [
                el("span", { className: "mh-log-time", text: formatShortTime(entry.at) }),
                el("span", { className: `mh-tag ${actionCls}`, text: actionLabel }),
                el("strong", { text: entry.mcpName }),
                el("span", { className: "mh-log-route", text: routeText }),
              ]),
              el("span", { className: `mh-tag ${statusBadgeCls}`, text: statusBadgeText }),
            ]);
          }),
        ),
  ]);

  return el("div", { className: "mh-as-stack" }, [heroCard, bentoGrid, scopeCard, logsCard]);
}
