/**
 * "MCP List" tab renderer: search toolbar (IME & focus safe), batch bar, and 2-tier MCP cards.
 */

import { el, formatTransportPreview, svgEl } from "../dom.mjs";

function makeSearchIcon() {
  return svgEl(
    "svg",
    {
      width: 13,
      height: 13,
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: "currentColor",
      "stroke-width": 2,
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
      "aria-hidden": "true",
    },
    [svgEl("circle", { cx: 11, cy: 11, r: 8 }), svgEl("path", { d: "m21 21-4.3-4.3" })],
  );
}

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

function formatExpiryTime(ts) {
  if (!ts) return "";
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return "";
  }
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
    openCloneServerModal,
    applySingleServer,
    revertSingleServer,
    probeServer,
    startOAuthLogin,
    openOAuthConfirmModal,
    cancelOAuthLogin,
    refreshOAuthToken,
    logoutOAuth,
    copyOAuthLink,
    copyServerJson,
  } = ctx;
  const oauthFeatureOn = Boolean(state.overview?.features?.oauthEnabled);

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
      el("div", { className: "mh-search-wrap" }, [
        el("span", { className: "mh-search-icon" }, [makeSearchIcon()]),
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
  const groupedEntries = [];
  const groupIndexByName = new Map();
  for (const s of filtered) {
    const existingIdx = groupIndexByName.get(s.name);
    if (existingIdx !== undefined) {
      groupedEntries[existingIdx].variants.push(s);
    } else {
      groupIndexByName.set(s.name, groupedEntries.length);
      groupedEntries.push({ name: s.name, variants: [s] });
    }
  }

  const cards = groupedEntries.map(({ name: groupName, variants }) => {
    const isGrouped = variants.length > 1;
    const savedActiveId = state.activeVariantByName?.[groupName];
    const server = (savedActiveId && variants.find((v) => v.id === savedActiveId)) || variants[0];
    const probe = state.probes[server.id];
    const isProbing = state.probingIds.has(server.id);
    const isApplying = state.applyingServerIds.has(server.id);
    const isChecked = state.selectedServerIds.has(server.id);
    const moreOpen = state.openMoreId === server.id;
    const changes = computeServerCardChanges(server, managed);
    const isUrlTransport = server.transport?.type === "http" || server.transport?.type === "sse";
    const groupHasAccountMode = Boolean(
      oauthFeatureOn && variants.some((v) => v.transport?.type === "http" || v.transport?.type === "sse"),
    );
    const isAccountMode = Boolean(oauthFeatureOn && isUrlTransport);
    const oauthState = oauthFeatureOn && isUrlTransport ? server.oauth : null;
    const oauthPending = oauthFeatureOn && isUrlTransport ? state.oauthPendingById[server.id] : null;
    const isOAuthStarting = oauthFeatureOn && state.oauthStartingIds.has(server.id);
    const isOAuthBusy = oauthFeatureOn && state.oauthBusyIds.has(server.id);
    const hintNeedsAuth = Boolean(
      oauthFeatureOn && isUrlTransport && !oauthState?.authenticated && server.oauthAuthHint?.needsAuth,
    );
    const oauthNeedsLogin = Boolean(
      oauthFeatureOn && isUrlTransport && (probe?.needsAuth || oauthState?.expired || hintNeedsAuth),
    );
    const transportBadge =
      server.transport?.type === "stdio"
        ? t("badgeStdio")
        : server.transport?.type === "sse"
          ? t("badgeSse")
          : t("badgeHttp");

    // Map each AI target owned by a sibling variant so tiles can show subtle visual distinction
    const siblingOwnerByTarget = new Map();
    if (isGrouped) {
      for (const other of variants) {
        if (other.id === server.id) continue;
        const otherLabel = other.alias || t("variantDefaultLabel");
        for (const tg of managed) {
          if (other.targetStatuses?.[tg.id] === "synced" && !siblingOwnerByTarget.has(tg.id)) {
            siblingOwnerByTarget.set(tg.id, otherLabel);
          }
        }
      }
    }

    let oauthInlineEl = null;
    if (oauthState?.authenticated && !oauthState.expired) {
      const tip = oauthState.expiresAt
        ? server.oauthHeaderManaged && oauthState.hasRefreshToken
          ? t("oauthBadgeTipAutoSync", { time: formatExpiryTime(oauthState.expiresAt) })
          : oauthState.hasRefreshToken
            ? t("oauthBadgeTipAutoRefresh", { time: formatExpiryTime(oauthState.expiresAt) })
            : t("oauthBadgeTipExpires", { time: formatExpiryTime(oauthState.expiresAt) })
        : t("oauthBadgeTipValid");
      oauthInlineEl = el("span", { className: "mh-oauth-inline is-ok", title: tip }, [
        el("span", { className: "mh-dot is-ok" }),
        el("span", { text: t("oauthInlineAuthed") }),
      ]);
    } else if (oauthFeatureOn && isUrlTransport && (isOAuthStarting || oauthPending || oauthNeedsLogin)) {
      oauthInlineEl = el("button", {
        className: "mh-btn mh-btn-sm mh-btn-soft",
        disabled: isOAuthStarting || Boolean(oauthPending),
        text: isOAuthStarting
          ? t("oauthBtnStarting")
          : oauthPending
            ? t("oauthBtnWaiting")
            : t("oauthBtnLogin"),
        onClick: () => openOAuthConfirmModal(server),
      });
    }

    let variantStripEl = null;
    if (isGrouped) {
      const activeLabel = server.alias || t("variantDefaultLabel");
      const activeSyncedNames = changes.synced.map((x) => x.shortName || x.name);
      const summaryText =
        activeSyncedNames.length > 0
          ? t("variantViewingSummary", {
              alias: activeLabel,
              ais:
                activeSyncedNames.slice(0, 3).join("、") +
                (activeSyncedNames.length > 3 ? ` +${activeSyncedNames.length - 3}` : ""),
            })
          : t("variantViewingNone", { alias: activeLabel });

      variantStripEl = el("div", { className: "mh-variant-strip" }, [
        el("div", { className: "mh-variant-tabs", role: "tablist" }, [
          ...variants.map((v) => {
            const vActive = v.id === server.id;
            const vLabel = v.alias || t("variantDefaultLabel");
            const vChanges = computeServerCardChanges(v, managed);
            const vIsUrl = v.transport?.type === "http" || v.transport?.type === "sse";
            const vOAuth = oauthFeatureOn && vIsUrl ? v.oauth : null;
            const vProbe = state.probes[v.id];
            let dotCls = null;
            if (oauthFeatureOn && vIsUrl) {
              if (vOAuth?.authenticated && !vOAuth.expired) dotCls = "is-ok";
              else if (vOAuth?.expired || vProbe?.needsAuth || v.oauthAuthHint?.needsAuth) dotCls = "is-warn";
              else dotCls = "is-off";
            }
            return el(
              "button",
              {
                className: `mh-variant-tab ${vActive ? "is-active" : ""}`,
                role: "tab",
                "aria-selected": String(vActive),
                onClick: () => {
                  state.activeVariantByName[groupName] = v.id;
                  state.openMoreId = null;
                  render();
                },
              },
              [
                dotCls ? el("span", { className: `mh-dot ${dotCls}` }) : null,
                el("span", { text: vLabel }),
                vChanges.hasChanges ? el("span", { className: "mh-variant-pending-dot" }) : null,
              ],
            );
          }),
          el("button", {
            className: "mh-variant-tab is-add",
            text: groupHasAccountMode ? t("variantAddAccountBtn") : t("variantAddConfigBtn"),
            onClick: () => openCloneServerModal(server),
          }),
        ]),
        el("span", { className: "mh-variant-meta", title: summaryText, text: summaryText }),
      ]);
    }

    let oauthWaitEl = null;
    if (oauthPending && oauthPending.status === "pending") {
      const remainingSec = Math.max(0, Math.ceil((oauthPending.expiresAt - Date.now()) / 1000));
      oauthWaitEl = el("div", { className: "mh-oauth-wait-bar" }, [
        el("span", {
          className: "mh-oauth-wait-text",
          text: t("oauthWaitTitle", { sec: remainingSec }),
        }),
        el("div", { className: "mh-actions" }, [
          el("a", {
            className: "mh-btn mh-btn-sm mh-btn-soft",
            href: oauthPending.authUrl,
            target: "_blank",
            rel: "noopener noreferrer",
            text: t("oauthWaitReopen"),
          }),
          el("button", {
            className: "mh-btn mh-btn-sm",
            text: t("oauthWaitCopy"),
            onClick: () => copyOAuthLink(oauthPending.authUrl),
          }),
          el("button", {
            className: "mh-btn mh-btn-sm",
            text: t("btnCancel"),
            onClick: () => cancelOAuthLogin(server),
          }),
        ]),
      ]);
    }

    let probeEl = null;
    if (probe) {
      const hasTools = typeof probe.toolCount === "number";
      const isAuthWarn = Boolean(probe.ok && probe.needsAuth);
      let text;
      if (probe.kind === "stdio") {
        text = probe.ok
          ? hasTools
            ? t("probeStdioOkTools", { count: probe.toolCount })
            : probe.warn
              ? t("probeStdioWarn", { detail: probe.detail })
              : t("probeStdioOk", { detail: probe.detail })
          : t("probeFail", { error: probe.error });
      } else if (isAuthWarn) {
        text = t("probeAuth", { status: probe.status });
      } else if (probe.ok) {
        text = hasTools
          ? t("probeOkTools", { status: probe.status, count: probe.toolCount })
          : t("probeOk", { status: probe.status });
        if (probe.usedOAuth) {
          text += t("probeUsedOAuthSuffix");
        }
      } else {
        text = t("probeFail", { error: probe.error });
      }
      const toolsList = Array.isArray(probe.tools) ? probe.tools : [];
      const toolsExpanded = state.expandedToolIds.has(server.id);
      const toolPreview =
        !toolsExpanded && hasTools && Array.isArray(probe.toolNames) && probe.toolNames.length > 0
          ? `${probe.toolNames.join(", ")}${probe.toolCount > probe.toolNames.length ? " …" : ""}`
          : "";
      const barTone = isAuthWarn ? "is-auth" : probe.ok ? "is-ok" : "is-err";
      probeEl = el("div", { className: `mh-probe-bar ${barTone}` }, [
        el("div", { className: "mh-probe-head" }, [
          el("span", { text }),
          isAuthWarn && isUrlTransport && !oauthFeatureOn
            ? el("span", { className: "mh-probe-hint", text: t("probeAuthEnableHint") })
            : null,
          toolsList.length > 0
            ? el("button", {
                className: "mh-btn-link",
                text: toolsExpanded
                  ? t("probeToolsHide")
                  : t("probeToolsShow", { count: probe.toolCount ?? toolsList.length }),
                onClick: () => {
                  if (toolsExpanded) state.expandedToolIds.delete(server.id);
                  else state.expandedToolIds.add(server.id);
                  render();
                },
              })
            : null,
        ]),
        toolPreview ? el("div", { className: "mh-probe-tools", text: toolPreview }) : null,
        toolsExpanded && toolsList.length > 0
          ? el(
              "div",
              { className: "mh-tools-list" },
              toolsList.map((tool) =>
                el("div", { className: "mh-tool-row" }, [
                  el("span", { className: "mh-tool-name", title: tool.name, text: tool.name }),
                  el("span", {
                    className: "mh-tool-desc",
                    title: tool.description || t("probeToolNoDesc"),
                    text: tool.description || t("probeToolNoDesc"),
                  }),
                ]),
              ),
            )
          : null,
      ]);
    }

    const statParts = [t("cardStatSynced", { count: changes.synced.length })];
    if (isGrouped && siblingOwnerByTarget.size > 0) {
      statParts.push(t("cardStatSiblingUsed", { count: siblingOwnerByTarget.size }));
    }
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
        className: `mh-card ${server.enabled ? "" : "is-disabled"} ${isChecked ? "is-checked" : ""} ${changes.hasChanges ? "has-apply-bar" : ""} ${isGrouped ? "has-variant-strip" : ""}`,
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
                !isGrouped && server.alias
                  ? el("span", { className: "mh-tag mh-tag-alias", text: server.alias })
                  : null,
                el("span", {
                  className: "mh-tag mh-tag-mono",
                  text: transportBadge,
                }),
                isGrouped
                  ? el("span", {
                      className: "mh-tag-count-pill",
                      text: groupHasAccountMode
                        ? t("variantAccountCountBadge", { count: variants.length })
                        : t("variantConfigCountBadge", { count: variants.length }),
                    })
                  : null,
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
            oauthInlineEl,
            el("button", {
              className: "mh-btn mh-btn-sm",
              disabled: isProbing || Boolean(oauthPending),
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
                    ...(oauthFeatureOn && isUrlTransport
                      ? [
                          ...(oauthState?.authenticated
                            ? [
                                oauthState.hasRefreshToken
                                  ? el("button", {
                                      className: "mh-more-item",
                                      disabled: isOAuthBusy,
                                      text: t("oauthMenuRefresh"),
                                      onClick: () => {
                                        state.openMoreId = null;
                                        void refreshOAuthToken(server);
                                        render();
                                      },
                                    })
                                  : null,
                                oauthState.expired
                                  ? el("button", {
                                      className: "mh-more-item",
                                      disabled: isOAuthStarting || Boolean(oauthPending),
                                      text: t("oauthMenuRelogin"),
                                      onClick: () => {
                                        state.openMoreId = null;
                                        openOAuthConfirmModal(server);
                                      },
                                    })
                                  : null,
                                el("button", {
                                  className: "mh-more-item",
                                  disabled: isOAuthBusy,
                                  text: t("oauthMenuLogout"),
                                  onClick: () => {
                                    state.openMoreId = null;
                                    void logoutOAuth(server);
                                    render();
                                  },
                                }),
                                el("div", { className: "mh-more-sep" }),
                              ]
                            : !oauthNeedsLogin && !oauthPending && !isOAuthStarting
                              ? [
                                  el("button", {
                                    className: "mh-more-item is-accent",
                                    disabled: isOAuthStarting || Boolean(oauthPending),
                                    text: t("oauthMenuLogin"),
                                    onClick: () => {
                                      state.openMoreId = null;
                                      openOAuthConfirmModal(server);
                                    },
                                  }),
                                  el("div", { className: "mh-more-sep" }),
                                ]
                              : []),
                        ]
                      : []),
                    el("button", {
                      className: "mh-more-item",
                      text: isAccountMode ? t("btnCloneAccount") : t("btnCloneConfig"),
                      onClick: () => {
                        state.openMoreId = null;
                        openCloneServerModal(server);
                      },
                    }),
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
        variantStripEl,
        oauthWaitEl,
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
              const siblingOwner = status === "off" ? siblingOwnerByTarget.get(tg.id) : null;
              const cls =
                status === "synced"
                  ? "is-synced"
                  : status === "pending-add"
                    ? "is-pending-add"
                    : status === "pending-update"
                      ? "is-pending-update"
                      : status === "pending-remove"
                        ? "is-pending-remove"
                        : siblingOwner
                          ? "is-sibling-owned"
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
                  title: siblingOwner ? t("variantSiblingTileTip", { owner: siblingOwner }) : undefined,
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
