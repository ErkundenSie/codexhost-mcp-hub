/**
 * "Project & Backups" tab renderer: project-level MCP sync panel and backup/restore history panel.
 */

import { el, formatDate } from "../dom.mjs";

export function renderProjectAndBackupsTab(ctx) {
  const { state, api, t, render, showToast } = ctx;

  const dirInput = el("input", {
    className: "mh-input",
    placeholder: t("projectDirPlaceholder"),
    value: state.projectDir,
    onInput: (e) => {
      state.projectDir = e.target.value;
    },
  });

  const formatOptions = [
    ["project-mcp-json", ".mcp.json", t("projectFormatStandardSub")],
    ["project-cursor", ".cursor/mcp.json", "Cursor / Cursor CLI"],
    ["project-codex", ".codex/config.toml", "Codex CLI"],
    ["project-opencode", "opencode.json", "OpenCode"],
  ];

  const scanRows = (state.projectScan?.items ?? []).map((item) =>
    el("div", { className: "mh-scan-row" }, [
      el("div", { className: "mh-backup-info" }, [
        el("div", { className: "mh-backup-meta" }, [
          el("strong", { text: item.name }),
          el("span", {
            className: `mh-tag ${item.exists ? "mh-tag-accent" : ""}`,
            text: item.exists ? t("badgeFileExists") : t("badgeNotFound"),
          }),
        ]),
        el("div", { className: "mh-cmd-inline", text: item.configPath }),
      ]),
      item.servers.length > 0
        ? el(
            "div",
            { className: "mh-chips", style: "margin-top:0" },
            item.servers.map((s) => el("span", { className: "mh-tag mh-tag-accent", text: s.name })),
          )
        : el("span", { className: "mh-backup-time", text: t("targetNativeCount", { count: 0 }) }),
    ]),
  );

  const enabledMcpCount = (state.overview?.servers ?? []).filter(
    (s) => s.enabled && !s.isLoopback && !s.isBuiltin,
  ).length;

  const projectPanel = el("div", { className: "mh-panel" }, [
    el("div", { className: "mh-panel-head" }, [
      el("div", {}, [
        el("h3", { text: t("sectionProjectTitle") }),
        el("p", { text: t("projectHint") }),
      ]),
    ]),
    el("div", { className: "mh-panel-body" }, [
      el("div", { className: "mh-path-row", style: "margin-top:0" }, [
        dirInput,
        el("button", {
          className: "mh-btn",
          text: t("projectScanBtn"),
          onClick: async () => {
            try {
              state.projectScan = await api.backend.invoke("project/scan", {
                projectDir: state.projectDir,
              });
              render();
            } catch (err) {
              showToast(err instanceof Error ? err.message : String(err), true);
            }
          },
        }),
      ]),
      el("div", { className: "mh-field", style: "margin-top:14px" }, [
        el("label", { text: t("projectFormatLabel") }),
        el(
          "div",
          { className: "mh-format-grid" },
          formatOptions.map(([id, fileLabel, subLabel]) => {
            const selected = state.projectFormats.has(id);
            return el(
              "button",
              {
                className: `mh-format-tile ${selected ? "is-selected" : ""}`,
                onClick: () => {
                  if (selected) state.projectFormats.delete(id);
                  else state.projectFormats.add(id);
                  render();
                },
              },
              [
                el("div", { className: "mh-format-main" }, [
                  el("span", { className: "mh-format-file", text: fileLabel }),
                  el("span", { className: "mh-format-sub", text: subLabel }),
                ]),
                el("span", { className: "mh-format-check", text: selected ? "✓" : "" }),
              ],
            );
          }),
        ),
      ]),
      scanRows.length > 0 ? el("div", { className: "mh-scan-list" }, scanRows) : null,
    ]),
    el("div", { className: "mh-panel-foot" }, [
      el("span", {
        className: "mh-backup-time",
        text: `${enabledMcpCount} MCP · ${state.projectFormats.size} ${t("tabTargets").replace(/\s*\(.*/, "")}`,
      }),
      el("button", {
        className: "mh-btn mh-btn-primary",
        disabled: state.projectFormats.size === 0,
        text: t("projectSyncBtn"),
        onClick: async () => {
          try {
            const res = await api.backend.invoke("project/sync", {
              projectDir: state.projectDir,
              formatIds: [...state.projectFormats],
            });
            state.projectScan = res.scan;
            const okCount = (res.results ?? []).filter((r) => r.status === "updated").length;
            showToast(t("syncDone", { count: okCount }));
            render();
          } catch (err) {
            showToast(err instanceof Error ? err.message : String(err), true);
          }
        },
      }),
    ]),
  ]);

  const backupsPanel = el("div", { className: "mh-panel" }, [
    el("div", { className: "mh-panel-head" }, [
      el("div", {}, [
        el("h3", { text: t("sectionBackupsTitle") }),
        el("p", { text: t("backupsHint") }),
      ]),
      el("span", { className: "mh-tag mh-tag-mono", text: `${state.backups.length}` }),
    ]),
    state.backups.length === 0
      ? el("div", { className: "mh-backup-empty", text: t("backupsEmpty") })
      : el(
          "div",
          { className: "mh-backup-rows" },
          state.backups.map((b) =>
            el("div", { className: "mh-backup-row" }, [
              el("div", { className: "mh-backup-info" }, [
                el("div", { className: "mh-backup-meta" }, [
                  el("strong", { text: b.targetName || b.targetId }),
                  el("span", { className: "mh-backup-time", text: formatDate(b.createdAt) }),
                  el("span", { className: "mh-tag mh-tag-mono", text: `${b.sizeBytes} B` }),
                ]),
                el("div", { className: "mh-cmd-inline", text: b.configPath }),
              ]),
              el("button", {
                className: "mh-btn mh-btn-sm",
                text: t("btnRestore"),
                onClick: () => {
                  state.modal = { type: "confirm-restore", backup: b };
                  render();
                },
              }),
            ]),
          ),
        ),
  ]);

  return el("div", {}, [projectPanel, backupsPanel]);
}
