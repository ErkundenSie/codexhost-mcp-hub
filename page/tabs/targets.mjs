/**
 * "AI Targets" tab renderer: clean overview cards with read-only path strips,
 * on-demand path editing, soft-tinted MCP chips, and collapsible custom target form.
 */

import { el } from "../dom.mjs";

export function renderTargetsTab(ctx) {
  const { state, api, t, render, showToast, sortedTargets } = ctx;
  const targets = sortedTargets();
  const visibleInstalled = targets.filter(
    (tg) => tg.detected || tg.exists || tg.custom || tg.overridden || tg.enabled,
  );
  const hiddenUninstalled = targets.filter(
    (tg) => !(tg.detected || tg.exists || tg.custom || tg.overridden || tg.enabled),
  );

  const renderTargetRow = (tg) => {
    const isEditing = state.editingTargetPathId === tg.id;
    const isInstalled = tg.detected || tg.exists || tg.custom || tg.overridden;
    const fmtLabel =
      tg.format === "codex-toml" ? "TOML" : tg.format === "dsh-cordis-yaml" ? "YAML" : "JSON";
    const pathInput = isEditing
      ? el("input", {
          className: "mh-input",
          value: tg.configPath,
          "data-keep-focus": `target-path-${tg.id}`,
        })
      : null;

    return el("div", { className: "mh-setting-row" }, [
      el("div", { className: "mh-setting-row-head" }, [
        el("div", { className: "mh-card-title", style: "font-size:13.5px" }, [
          el("span", { className: `mh-target-dot ${isInstalled ? "is-on" : ""}` }),
          el("span", { text: tg.name }),
          el("span", { className: "mh-tag mh-tag-mono", text: fmtLabel }),
          tg.custom ? el("span", { className: "mh-tag mh-tag-accent", text: t("badgeCustom") }) : null,
        ]),
        el("div", { className: "mh-card-actions" }, [
          el("span", {
            className: "mh-backup-time",
            text: t("targetNativeCount", { count: tg.nativeCount }),
          }),
          el("button", {
            className: "mh-btn mh-btn-sm",
            text: t("targetViewConfig"),
            onClick: async () => {
              try {
                const raw = await api.backend.invoke("targets/read-raw", { targetId: tg.id });
                state.modal = { type: "view-config", ...raw };
                render();
              } catch (err) {
                showToast(err instanceof Error ? err.message : String(err), true);
              }
            },
          }),
          el("button", {
            className: "mh-btn mh-btn-sm",
            text: isEditing ? t("btnCancel") : t("targetEditPath"),
            onClick: () => {
              state.editingTargetPathId = isEditing ? null : tg.id;
              render();
            },
          }),
          tg.custom
            ? el("button", {
                className: "mh-btn mh-btn-sm mh-btn-danger",
                text: t("btnDelete"),
                onClick: async () => {
                  try {
                    state.overview = await api.backend.invoke("targets/custom-remove", {
                      targetId: tg.id,
                    });
                    if (state.editingTargetPathId === tg.id) state.editingTargetPathId = null;
                    render();
                  } catch (err) {
                    showToast(err instanceof Error ? err.message : String(err), true);
                  }
                },
              })
            : null,
        ]),
      ]),
      tg.error ? el("div", { className: "mh-probe-bar is-err", style: "margin:8px 0 0", text: tg.error }) : null,
      isEditing
        ? el("div", { className: "mh-path-row" }, [
            pathInput,
            el("button", {
              className: "mh-btn mh-btn-sm mh-btn-primary",
              text: t("targetSavePath"),
              onClick: async () => {
                try {
                  state.overview = await api.backend.invoke("targets/set-path", {
                    targetId: tg.id,
                    configPath: pathInput.value,
                  });
                  state.editingTargetPathId = null;
                  showToast(t("toastPathUpdated"));
                  render();
                } catch (err) {
                  showToast(err instanceof Error ? err.message : String(err), true);
                }
              },
            }),
            tg.overridden
              ? el("button", {
                  className: "mh-btn mh-btn-sm",
                  text: t("targetResetPath"),
                  onClick: async () => {
                    try {
                      state.overview = await api.backend.invoke("targets/set-path", {
                        targetId: tg.id,
                        configPath: "",
                      });
                      state.editingTargetPathId = null;
                      showToast(t("toastPathUpdated"));
                      render();
                    } catch (err) {
                      showToast(err instanceof Error ? err.message : String(err), true);
                    }
                  },
                })
              : null,
          ])
        : el("div", { className: "mh-path-readonly" }, [
            el("span", { className: "mh-path-readonly-text", title: tg.configPath, text: tg.configPath }),
            el("span", {
              className: "mh-path-readonly-badge",
              text: tg.overridden || tg.custom ? t("targetPathCustom") : t("targetPathDefault"),
            }),
          ]),
      tg.nativeServers.length > 0
        ? el(
            "div",
            { className: "mh-chips" },
            tg.nativeServers.map((ns) =>
              el("span", {
                className: `mh-tag ${ns.isBuiltin ? "" : ns.managed ? "mh-tag-ok" : ""}`,
                text: ns.isBuiltin
                  ? `${ns.name} (${t("badgeBuiltin", { vendor: ns.builtinVendor || "Vendor" })})`
                  : `${ns.name}${ns.managed ? "" : ` (${t("badgeUnmanaged")})`}`,
              }),
            ),
          )
        : null,
    ]);
  };

  const nameInput = el("input", { className: "mh-input", placeholder: t("customTargetName") });
  const pathInput = el("input", { className: "mh-input", placeholder: t("customTargetPath") });
  const keyInput = el("input", {
    className: "mh-input",
    value: "mcpServers",
    placeholder: t("customTargetRootKey"),
  });

  const detectedPanel = el("div", { className: "mh-panel" }, [
    el("div", { className: "mh-panel-head" }, [
      el("div", {}, [
        el("h3", { text: t("targetsPanelTitle") }),
        el("p", { text: t("targetsHint") }),
      ]),
      el("div", { className: "mh-actions" }, [
        el("span", { className: "mh-as-count-pill", text: String(visibleInstalled.length) }),
        el("button", {
          className: `mh-btn mh-btn-sm ${state.showCustomTargetForm ? "mh-btn-soft" : ""}`,
          text: state.showCustomTargetForm ? t("btnCancel") : t("btnAddCustomTargetShort"),
          onClick: () => {
            state.showCustomTargetForm = !state.showCustomTargetForm;
            render();
          },
        }),
      ]),
    ]),
    state.showCustomTargetForm
      ? el("div", { className: "mh-custom-inline-box" }, [
          el("div", { className: "mh-form-grid" }, [
            el("div", { className: "mh-field-row" }, [
              el("div", { className: "mh-field" }, [
                el("label", { text: t("customTargetName") }),
                nameInput,
              ]),
              el("div", { className: "mh-field" }, [
                el("label", { text: t("customTargetRootKey") }),
                keyInput,
              ]),
            ]),
            el("div", { className: "mh-field" }, [
              el("label", { text: t("customTargetPath") }),
              el("div", { className: "mh-path-row", style: "margin-top:0" }, [
                pathInput,
                el("button", {
                  className: "mh-btn mh-btn-sm mh-btn-primary",
                  text: t("btnSave"),
                  onClick: async () => {
                    try {
                      state.overview = await api.backend.invoke("targets/custom-add", {
                        name: nameInput.value,
                        configPath: pathInput.value,
                        rootKey: keyInput.value || "mcpServers",
                      });
                      state.showCustomTargetForm = false;
                      showToast(t("toastSaved", { name: nameInput.value }));
                      render();
                    } catch (err) {
                      showToast(err instanceof Error ? err.message : String(err), true);
                    }
                  },
                }),
              ]),
            ]),
          ]),
        ])
      : null,
    el("div", { className: "mh-setting-rows" }, visibleInstalled.map(renderTargetRow)),
    hiddenUninstalled.length > 0
      ? el("div", { className: "mh-panel-foot" }, [
          el("button", {
            className: "mh-btn-link",
            style: "padding:4px 8px",
            text: state.showUninstalledTargets
              ? `▾ ${t("targetsHideUninstalled", { count: hiddenUninstalled.length })}`
              : `▸ ${t("targetsShowUninstalled", { count: hiddenUninstalled.length })}`,
            onClick: () => {
              state.showUninstalledTargets = !state.showUninstalledTargets;
              render();
            },
          }),
        ])
      : null,
    state.showUninstalledTargets && hiddenUninstalled.length > 0
      ? el("div", { className: "mh-setting-rows mh-setting-rows-muted" }, hiddenUninstalled.map(renderTargetRow))
      : null,
  ]);

  return el("div", {}, [detectedPanel]);
}
