/**
 * "MCP List" tab renderer: search toolbar (IME & focus safe), batch bar, and 2-tier MCP cards.
 */

import { el, formatTransportPreview } from "../dom.mjs";

function computeServerCardChanges(server, managed) {
  const synced = [];
  const adds = [];
  const overwrites = [];
  const removes = [];
  for (const tg of managed) {
    const st = server.targetStatuses?.[tg.id] || "off";
    if (st === "synced") synced.push(tg);
    else if (st === "pending-add") adds.push(tg);
    else if (st === "pending-update") overwrites.push(tg);
    else if (st === "pending-remove") removes.push(tg);
  }
  return {
    synced,
    adds,
    overwrites,
    removes,
    hasChanges: adds.length + overwrites.length + removes.length > 0,
  };
}

export function renderServersTab(ctx) {
  const {
    state,
    api,
    t,
    render,
    showToast,
    managedTargets,
    openUnifiedAddModal,
    openServerEditor,
    applySingleServer,
    revertSingleServer,
    probeServer,
    copyServerJson,
  } = ctx;

  const allServers = state.overview?.servers ?? [];
  const existingIds = new Set(allServers.map((s) => s.id));
  for (const id of [...state.selectedServerIds]) {
    if (!existingIds.has(id)) state.selectedServerIds.delete(id);
  }

  const newImportableCount = state.overview?.summary?.newImportableCount ?? 0;
  const q = state.search.trim().toLowerCase();
  const filtered = allServers.filter((s) => {
    if (!q) return true;
    const hay = `${s.name} ${s.alias ?? ""} ${s.description ?? ""} ${formatTransportPreview(s.transport)}`.toLowerCase();
    return hay.includes(q);
  });

  const discoverBanner =
    newImportableCount > 0
      ? el("div", { className: "mh-discover-banner" }, [
          el("span", { text: t("newDiscoverBanner", { count: newImportableCount }) }),
          el("button", {
            className: "mh-btn mh-btn-sm mh-btn-primary",
            text: t("newDiscoverAction"),
            onClick: () => openUnifiedAddModal("import"),
          }),
        ])
      : null;

  if (allServers.length === 0) {
    return el("div", {}, [
      discoverBanner,
      el("div", { className: "mh-empty" }, [
        el("h3", { text: t("emptyServersTitle") }),
        el("p", { text: t("emptyServersDesc") }),
        el("div", { className: "mh-actions", style: "justify-content:center" }, [
          newImportableCount > 0
            ? el("button", {
                className: "mh-btn mh-btn-primary",
                text: t("newDiscoverAction"),
                onClick: () => openUnifiedAddModal("import"),
              })
            : null,
          el("button", {
            className: newImportableCount > 0 ? "mh-btn" : "mh-btn mh-btn-primary",
            text: t("btnAddUnified"),
            onClick: () => openUnifiedAddModal("json"),
          }),
        ]),
      ]),
    ]);
  }

  const selectedInFiltered = filtered.filter((s) => state.selectedServerIds.has(s.id)).length;
  const allFilteredSelected = filtered.length > 0 && selectedInFiltered === filtered.length;

  const toolbar = el("div", { className: "mh-toolbar" }, [
    el("div", { className: "mh-toolbar-left" }, [
      el("label", { className: "mh-switch" }, [
        el("input", {
          type: "checkbox",
          checked: allFilteredSelected,
          onChange: (e) => {
            if (e.target.checked) {
              for (const s of filtered) state.selectedServerIds.add(s.id);
            } else {
              for (const s of filtered) state.selectedServerIds.delete(s.id);
            }
            render();
          },
        }),
        t("batchSelectAll", { selected: selectedInFiltered, total: filtered.length }),
      ]),
      el("input", {
        className: "mh-input mh-search",
        type: "search",
        "data-keep-focus": "server-search",
        placeholder: t("searchPlaceholder"),
        value: state.search,
        onCompositionstart: () => {
          state.searchComposing = true;
        },
        onCompositionend: (e) => {
          state.searchComposing = false;
          state.search = e.target.value;
          render();
        },
        onInput: (e) => {
          state.search = e.target.value;
          if (!state.searchComposing) render();
        },
      }),
    ]),
    el("div", { className: "mh-legend" }, [
      el("span", { className: "mh-legend-item" }, [
        el("span", { className: "mh-legend-swatch is-synced" }),
        t("legendSynced"),
      ]),
      el("span", { className: "mh-legend-item" }, [
        el("span", { className: "mh-legend-swatch is-pending-write" }),
        t("legendPendingWrite"),
      ]),
      el("span", { className: "mh-legend-item" }, [
        el("span", { className: "mh-legend-swatch is-overwrite" }),
        t("legendOverwrite"),
      ]),
      el("span", { className: "mh-legend-item" }, [
        el("span", { className: "mh-legend-swatch is-pending-remove" }),
        t("legendPendingRemove"),
      ]),
      el("span", { className: "mh-legend-item" }, [
        el("span", { className: "mh-legend-swatch is-off" }),
        t("legendOff"),
      ]),
    ]),
  ]);

  const selectedServers = allServers.filter((s) => state.selectedServerIds.has(s.id));
  const batchBar =
    selectedServers.length > 0
      ? el("div", { className: "mh-batch-bar" }, [
          el("span", {
            className: "mh-batch-bar-label",
            text: t("batchSelectedLabel", {
              count: selectedServers.length,
              names:
                selectedServers
                  .slice(0, 3)
                  .map((s) => (s.alias ? `${s.name}(${s.alias})` : s.name))
                  .join(", ") + (selectedServers.length > 3 ? "…" : ""),
            }),
          }),
          el("div", { className: "mh-actions" }, [
            el("button", {
              className: "mh-btn mh-btn-sm mh-btn-primary",
              text: t("batchAddBtn"),
              onClick: () => {
                state.modal = {
                  type: "batch-apply",
                  step: 2,
                  fromWizard: false,
                  mode: "add",
                  ids: selectedServers.map((s) => s.id),
                  targets: new Set(),
                  skipExisting: true,
                };
                render();
              },
            }),
            el("button", {
              className: "mh-btn mh-btn-sm mh-btn-danger",
              text: t("batchRemoveBtn"),
              onClick: () => {
                state.modal = {
                  type: "batch-apply",
                  step: 2,
                  fromWizard: false,
                  mode: "remove",
                  ids: selectedServers.map((s) => s.id),
                  targets: new Set(),
                  skipExisting: false,
                };
                render();
              },
            }),
            el("button", {
              className: "mh-btn mh-btn-sm",
              text: t("batchClearSelection"),
              onClick: () => {
                state.selectedServerIds.clear();
                render();
              },
            }),
          ]),
        ])
      : null;

  const managed = managedTargets();
  const cards = filtered.map((server) => {
    const probe = state.probes[server.id];
    const isProbing = state.probingIds.has(server.id);
    const isApplying = state.applyingServerIds.has(server.id);
    const isChecked = state.selectedServerIds.has(server.id);
    const moreOpen = state.openMoreId === server.id;
    const changes = computeServerCardChanges(server, managed);
    const transportBadge =
      server.transport?.type === "stdio"
        ? t("badgeStdio")
        : server.transport?.type === "sse"
          ? t("badgeSse")
          : t("badgeHttp");

    let probeEl = null;
    if (probe) {
      let text;
      if (probe.kind === "stdio") {
        text = probe.ok
          ? probe.warn
            ? t("probeStdioWarn", { detail: probe.detail })
            : t("probeStdioOk", { detail: probe.detail })
          : t("probeFail", { error: probe.error });
      } else if (probe.ok && probe.needsAuth) {
        text = t("probeAuth", { status: probe.status });
      } else if (probe.ok) {
        text = t("probeOk", { status: probe.status });
      } else {
        text = t("probeFail", { error: probe.error });
      }
      probeEl = el("div", {
        className: `mh-probe-bar ${probe.ok ? "is-ok" : "is-err"}`,
        text,
      });
    }

    const statParts = [t("cardStatSynced", { count: changes.synced.length })];
    if (changes.adds.length) statParts.push(t("cardStatAdd", { count: changes.adds.length }));
    if (changes.overwrites.length) statParts.push(t("cardStatOverwrite", { count: changes.overwrites.length }));
    if (changes.removes.length) statParts.push(t("cardStatRemove", { count: changes.removes.length }));

    const applySummaryNodes = [];
    if (changes.adds.length) {
      applySummaryNodes.push(
        el("span", {
          text: t("cardApplyAdd", {
            names: changes.adds.map((x) => `+ ${x.shortName || x.name}`).join("、"),
          }),
        }),
      );
    }
    if (changes.overwrites.length) {
      applySummaryNodes.push(
        el("span", {
          className: "mh-warn-text",
          text: t("cardApplyOverwrite", {
            names: changes.overwrites.map((x) => `~ ${x.shortName || x.name}`).join("、"),
          }),
        }),
      );
    }
    if (changes.removes.length) {
      applySummaryNodes.push(
        el("span", {
          className: "mh-danger-text",
          text: t("cardApplyRemove", {
            names: changes.removes.map((x) => `- ${x.shortName || x.name}`).join("、"),
          }),
        }),
      );
    }
    applySummaryNodes.push(el("span", { style: "opacity:0.75", text: t("cardApplyAutoBackup") }));

    const applyBar = changes.hasChanges
      ? el("div", { className: "mh-card-apply-bar" }, [
          el("div", { className: "mh-apply-summary" }, applySummaryNodes),
          el("div", { className: "mh-actions" }, [
            el("button", {
              className: "mh-btn mh-btn-sm",
              disabled: isApplying,
              text: t("btnRevert"),
              onClick: () => revertSingleServer(server),
            }),
            el("button", {
              className: "mh-btn mh-btn-sm mh-btn-apply",
              disabled: isApplying,
              text: isApplying ? t("btnSyncing") : t("btnApplyNow"),
              onClick: () => applySingleServer(server),
            }),
          ]),
        ])
      : null;

    const preview = formatTransportPreview(server.transport);

    return el(
      "div",
      {
        className: `mh-card ${server.enabled ? "" : "is-disabled"} ${isChecked ? "is-checked" : ""} ${changes.hasChanges ? "has-apply-bar" : ""}`,
      },
      [
        el("div", { className: "mh-card-top" }, [
          el("div", { className: "mh-card-info" }, [
            el("label", { className: "mh-switch" }, [
              el("input", {
                type: "checkbox",
                checked: isChecked,
                onChange: (e) => {
                  if (e.target.checked) state.selectedServerIds.add(server.id);
                  else state.selectedServerIds.delete(server.id);
                  render();
                },
              }),
            ]),
            el("div", { className: "mh-card-title-col" }, [
              el("div", { className: "mh-card-name-row" }, [
                el("span", { className: "mh-card-name", text: server.name }),
                server.alias ? el("span", { className: "mh-tag mh-tag-alias", text: server.alias }) : null,
                el("span", { className: "mh-tag mh-tag-mono", text: transportBadge }),
                !server.enabled ? el("span", { className: "mh-tag", text: t("badgeDisabled") }) : null,
                server.isLoopback
                  ? el("span", {
                      className: "mh-tag mh-tag-danger",
                      title: t("loopbackTip"),
                      text: t("badgeLoopback"),
                    })
                  : null,
                server.isBuiltin
                  ? el("span", {
                      className: "mh-tag mh-tag-danger",
                      text: t("badgeBuiltinCard", { vendor: server.builtinVendor || "Vendor" }),
                    })
                  : null,
              ]),
              el("div", { className: "mh-cmd-inline mh-cmd-truncate", title: preview, text: preview }),
            ]),
          ]),
          el("div", { className: "mh-card-actions" }, [
            el("button", {
              className: "mh-btn mh-btn-sm",
              disabled: isProbing,
              text: isProbing ? t("btnTesting") : t("btnTest"),
              onClick: () => probeServer(server),
            }),
            el("button", {
              className: "mh-btn mh-btn-sm",
              text: t("btnEdit"),
              onClick: () => openServerEditor(server),
            }),
            el("div", { className: "mh-more-wrap" }, [
              el("button", {
                className: "mh-btn mh-btn-sm",
                text: "⋯",
                onClick: (e) => {
                  e.stopPropagation();
                  state.openMoreId = moreOpen ? null : server.id;
                  render();
                },
              }),
              moreOpen
                ? el("div", { className: "mh-more-menu" }, [
                    el("button", {
                      className: "mh-more-item",
                      text: t("btnCopyJson"),
                      onClick: () => {
                        state.openMoreId = null;
                        void copyServerJson(server);
                        render();
                      },
                    }),
                    el("button", {
                      className: "mh-more-item",
                      text: server.enabled ? t("btnToggleDisable") : t("btnToggleEnable"),
                      onClick: async () => {
                        state.openMoreId = null;
                        try {
                          state.overview = await api.backend.invoke("servers/toggle", {
                            id: server.id,
                            enabled: !server.enabled,
                          });
                          render();
                        } catch (err) {
                          showToast(err instanceof Error ? err.message : String(err), true);
                        }
                      },
                    }),
                    el("button", {
                      className: "mh-more-item is-danger",
                      text: t("btnDelete"),
                      onClick: () => {
                        state.openMoreId = null;
                        state.modal = { type: "confirm-delete", server };
                        render();
                      },
                    }),
                  ])
                : null,
            ]),
          ]),
        ]),
        probeEl,
        el("div", { className: "mh-card-ai-panel" }, [
          el("div", { className: "mh-ai-panel-head" }, [
            el("span", { text: `${t("cardDistHeader")}（${statParts.join(" · ")}）` }),
            el("div", { className: "mh-actions" }, [
              el("button", {
                className: "mh-btn-link",
                text: t("btnEnableAllAis"),
                onClick: async () => {
                  try {
                    state.overview = await api.backend.invoke("servers/set-targets", {
                      id: server.id,
                      targets: managed.map((tg) => tg.id),
                      autoEnable: true,
                    });
                    render();
                  } catch (err) {
                    showToast(err instanceof Error ? err.message : String(err), true);
                  }
                },
              }),
              el("button", {
                className: "mh-btn-link",
                text: t("btnDisableAllAis"),
                onClick: async () => {
                  try {
                    state.overview = await api.backend.invoke("servers/set-targets", {
                      id: server.id,
                      targets: [],
                      autoEnable: false,
                    });
                    render();
                  } catch (err) {
                    showToast(err instanceof Error ? err.message : String(err), true);
                  }
                },
              }),
            ]),
          ]),
          el(
            "div",
            { className: "mh-ai-grid" },
            managed.map((tg) => {
              const selected = server.enabled && (server.targets ?? []).includes(tg.id);
              const status = server.targetStatuses?.[tg.id] || (selected ? "pending-add" : "off");
              const cls =
                status === "synced"
                  ? "is-synced"
                  : status === "pending-add"
                    ? "is-pending-add"
                    : status === "pending-update"
                      ? "is-pending-update"
                      : status === "pending-remove"
                        ? "is-pending-remove"
                        : "";
              const mark =
                status === "synced"
                  ? "✓"
                  : status === "pending-add"
                    ? "+"
                    : status === "pending-update"
                      ? t("tileOverwriteTag")
                      : status === "pending-remove"
                        ? "-"
                        : "";
              return el(
                "button",
                {
                  className: `mh-ai-tile ${cls}`,
                  onClick: async () => {
                    let next;
                    if (!server.enabled) {
                      const currentlySynced = managed
                        .filter((x) =>
                          x.nativeServers.some((ns) => ns.name === server.name && ns.enabled !== false),
                        )
                        .map((x) => x.id);
                      next = [...new Set([...currentlySynced, tg.id])];
                    } else {
                      next = selected
                        ? (server.targets ?? []).filter((id) => id !== tg.id)
                        : [...(server.targets ?? []), tg.id];
                    }
                    try {
                      state.overview = await api.backend.invoke("servers/set-targets", {
                        id: server.id,
                        targets: next,
                        autoEnable: true,
                      });
                      render();
                    } catch (err) {
                      showToast(err instanceof Error ? err.message : String(err), true);
                    }
                  },
                },
                [
                  el("span", { text: tg.shortName || tg.name }),
                  el("span", { className: "mh-tile-mark", text: mark }),
                ],
              );
            }),
          ),
        ]),
        applyBar,
      ],
    );
  });

  return el("div", {}, [discoverBanner, toolbar, batchBar, el("div", { className: "mh-list" }, cards)]);
}
