/**
 * "Auto-Sync" tab renderer: real-time file-watcher settings, propagation scope, MCP filter, and activity logs.
 */

import { el } from "../dom.mjs";

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

  const configPanel = el("div", { className: "mh-panel" }, [
    el("div", { className: "mh-panel-head" }, [
      el("div", {}, [
        el("h3", { text: t("autoSyncPanelTitle") }),
        el("p", { text: t("autoSyncPanelDesc") }),
      ]),
      el("div", { className: "mh-toggle-pill" }, [
        el("span", { className: `mh-status-pill ${cfg.enabled ? "is-on" : ""}` }, [
          cfg.enabled ? el("span", { className: "mh-live-dot" }) : null,
          el("span", { text: statusText }),
        ]),
        el(
          "button",
          {
            className: `mh-toggle-btn ${cfg.enabled ? "is-on" : ""}`,
            role: "switch",
            "aria-checked": String(Boolean(cfg.enabled)),
            onClick: () => patchConfig({ enabled: !cfg.enabled }),
          },
          [el("span", { className: "mh-toggle-thumb" })],
        ),
      ]),
    ]),
    el("div", { className: "mh-setting-rows" }, [
      // Row 1: Sync Mode
      el("div", { className: "mh-setting-row" }, [
        el("div", { className: "mh-row-label", text: t("autoSyncModeLabel") }),
        el("div", { className: "mh-mode-cards" }, [
          el(
            "button",
            {
              className: `mh-mode-card ${cfg.mode === "bidirectional" ? "is-active" : ""}`,
              onClick: () => patchConfig({ mode: "bidirectional" }),
            },
            [
              el("div", { className: "mh-mode-card-head" }, [
                el("span", { className: "mh-mode-card-title", text: t("autoSyncModeBiTitle") }),
                el("span", { className: "mh-radio", text: cfg.mode === "bidirectional" ? "✓" : "" }),
              ]),
              el("p", { text: t("autoSyncModeBiDesc") }),
            ],
          ),
          el(
            "button",
            {
              className: `mh-mode-card ${cfg.mode === "primary" ? "is-active" : ""}`,
              onClick: () =>
                patchConfig({
                  mode: "primary",
                  primaryTargetId: cfg.primaryTargetId || managed[0]?.id || "",
                }),
            },
            [
              el("div", { className: "mh-mode-card-head" }, [
                el("span", { className: "mh-mode-card-title", text: t("autoSyncModePrimaryTitle") }),
                el("span", { className: "mh-radio", text: cfg.mode === "primary" ? "✓" : "" }),
              ]),
              el("p", { text: t("autoSyncModePrimaryDesc") }),
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

      // Row 2: Update Propagation Scope
      el("div", { className: "mh-setting-row" }, [
        el("div", { className: "mh-row-label", text: t("autoSyncScopeLabel") }),
        el("div", { className: "mh-mode-cards" }, [
          el(
            "button",
            {
              className: `mh-mode-card ${cfg.updateScope === "existing-only" ? "is-active" : ""}`,
              onClick: () => patchConfig({ updateScope: "existing-only" }),
            },
            [
              el("div", { className: "mh-mode-card-head" }, [
                el("span", { className: "mh-mode-card-title" }, [
                  el("span", { text: t("autoSyncScopeExistingTitle") }),
                  el("span", { className: "mh-tag mh-tag-ok", text: t("autoSyncScopeExistingBadge") }),
                ]),
                el("span", { className: "mh-radio", text: cfg.updateScope === "existing-only" ? "✓" : "" }),
              ]),
              el("p", { text: t("autoSyncScopeExistingDesc") }),
            ],
          ),
          el(
            "button",
            {
              className: `mh-mode-card ${cfg.updateScope === "all-selected" ? "is-active" : ""}`,
              onClick: () => patchConfig({ updateScope: "all-selected" }),
            },
            [
              el("div", { className: "mh-mode-card-head" }, [
                el("span", { className: "mh-mode-card-title", text: t("autoSyncScopeAllTitle") }),
                el("span", { className: "mh-radio", text: cfg.updateScope === "all-selected" ? "✓" : "" }),
              ]),
              el("p", { text: t("autoSyncScopeAllDesc") }),
            ],
          ),
        ]),
      ]),

      // Row 3: MCP Scope
      el("div", { className: "mh-setting-row" }, [
        el("div", { className: "mh-scope-head" }, [
          el("div", {}, [
            el("div", { className: "mh-row-label", text: t("autoSyncMcpScopeLabel") }),
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

      // Row 4: Target AIs
      el("div", { className: "mh-setting-row" }, [
        el("div", { className: "mh-ai-panel-head", style: "margin-bottom:8px" }, [
          el("div", {
            className: "mh-row-label",
            text: t("autoSyncTargetsLabel", { selected: selectedTargetSet.size, total: managed.length }),
          }),
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
          { className: "mh-ai-grid" },
          managed.map((tg) => {
            const on = selectedTargetSet.has(tg.id);
            return el(
              "button",
              {
                className: `mh-ai-tile ${on ? "is-synced" : ""}`,
                onClick: () => {
                  const next = on
                    ? [...selectedTargetSet].filter((id) => id !== tg.id)
                    : [...selectedTargetSet, tg.id];
                  void patchConfig({ targetIds: next });
                },
              },
              [
                el("span", { text: tg.shortName || tg.name }),
                el("span", { className: "mh-tile-mark", text: on ? "✓" : "" }),
              ],
            );
          }),
        ),
      ]),

      // Row 5: Trigger Rules & Safety Guard
      el("div", { className: "mh-setting-row" }, [
        el("div", { className: "mh-row-label", text: t("autoSyncRulesLabel") }),
        el("div", { className: "mh-rule-list" }, [
          el("label", { className: "mh-rule-item" }, [
            el("input", {
              type: "checkbox",
              checked: cfg.syncAdditions,
              onChange: (e) => patchConfig({ syncAdditions: e.target.checked }),
            }),
            el("span", {}, [
              el("strong", { text: t("autoSyncRuleAddTitle") }),
              el("span", { className: "mh-rule-sub", text: t("autoSyncRuleAddDesc") }),
            ]),
          ]),
          el("label", { className: "mh-rule-item" }, [
            el("input", {
              type: "checkbox",
              checked: cfg.syncUpdates,
              onChange: (e) => patchConfig({ syncUpdates: e.target.checked }),
            }),
            el("span", {}, [
              el("strong", { text: t("autoSyncRuleUpdateTitle") }),
              el("span", { className: "mh-rule-sub", text: t("autoSyncRuleUpdateDesc") }),
            ]),
          ]),
          el("label", { className: "mh-rule-item" }, [
            el("input", {
              type: "checkbox",
              checked: cfg.syncRemovals,
              onChange: (e) => patchConfig({ syncRemovals: e.target.checked }),
            }),
            el("span", {}, [
              el("strong", { text: t("autoSyncRuleRemoveTitle") }),
              el("span", {
                className: "mh-tag mh-tag-alias",
                style: "margin-left:6px",
                text: t("autoSyncRuleRemoveWarn"),
              }),
              el("span", { className: "mh-rule-sub", text: t("autoSyncRuleRemoveDesc") }),
            ]),
          ]),
        ]),
        el("div", { className: "mh-guard-strip" }, [
          el("span", { text: "🛡" }),
          el("span", { text: t("autoSyncGuardStrip") }),
        ]),
      ]),
    ]),
  ]);

  const logsPanel = el("div", { className: "mh-panel" }, [
    el("div", { className: "mh-panel-head" }, [
      el("div", {}, [
        el("h3", { text: t("autoSyncLogsTitle") }),
        el("p", { text: t("autoSyncLogsDesc") }),
      ]),
      el("div", { className: "mh-actions" }, [
        el("span", { className: "mh-tag mh-tag-mono", text: String(logs.length) }),
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
      ? el("div", { className: "mh-backup-empty", text: t("autoSyncLogsEmpty") })
      : el(
          "div",
          {},
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

  return el("div", {}, [configPanel, logsPanel]);
}
