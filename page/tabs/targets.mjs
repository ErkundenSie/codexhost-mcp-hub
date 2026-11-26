/**
 * "AI Targets" tab renderer: grouped settings panels for detected AIs & custom JSON targets.
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
    const pathInput = el("input", { className: "mh-input", value: tg.configPath });

    return el("div", { className: "mh-setting-row" }, [
      el("div", { className: "mh-setting-row-head" }, [
        el("div", { className: "mh-card-title", style: "font-size:13.5px" }, [
          el("span", { text: tg.name }),
          tg.custom ? el("span", { className: "mh-tag", text: t("badgeCustom") }) : null,
        ]),
        el("div", { className: "mh-card-actions" }, [
          el("span", {
            className: "mh-backup-time",
            text: t("targetNativeCount", { count: tg.nativeCount }),
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
                    render();
                  } catch (err) {
                    showToast(err instanceof Error ? err.message : String(err), true);
                  }
                },
              })
            : null,
        ]),
      ]),
      tg.error ? el("div", { className: "mh-probe-bar is-err", style: "margin:6px 0 0", text: tg.error }) : null,
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
      el("div", { className: "mh-path-row" }, [
        pathInput,
        el("button", {
          className: "mh-btn mh-btn-sm",
          text: t("targetSavePath"),
          onClick: async () => {
            try {
              state.overview = await api.backend.invoke("targets/set-path", {
                targetId: tg.id,
                configPath: pathInput.value,
              });
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
                  showToast(t("toastPathUpdated"));
                  render();
                } catch (err) {
                  showToast(err instanceof Error ? err.message : String(err), true);
                }
              },
            })
          : null,
      ]),
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
      el("span", { className: "mh-tag mh-tag-mono", text: String(visibleInstalled.length) }),
    ]),
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

  const addCustomPanel = el("div", { className: "mh-panel" }, [
    el("div", { className: "mh-panel-head" }, [
      el("div", {}, [
        el("h3", { text: t("btnAddCustomTarget") }),
        el("p", { text: t("customTargetPanelDesc") }),
      ]),
    ]),
    el("div", { className: "mh-panel-body" }, [
      el("div", { className: "mh-form-grid" }, [
        el("div", { className: "mh-field-row" }, [nameInput, keyInput]),
        el("div", { className: "mh-path-row", style: "margin-top:0" }, [pathInput]),
      ]),
    ]),
    el("div", { className: "mh-panel-foot", style: "justify-content:flex-end" }, [
      el("button", {
        className: "mh-btn mh-btn-primary",
        text: t("btnSave"),
        onClick: async () => {
          try {
            state.overview = await api.backend.invoke("targets/custom-add", {
              name: nameInput.value,
              configPath: pathInput.value,
              rootKey: keyInput.value || "mcpServers",
            });
            showToast(t("toastSaved", { name: nameInput.value }));
            render();
          } catch (err) {
            showToast(err instanceof Error ? err.message : String(err), true);
          }
        },
      }),
    ]),
  ]);

  return el("div", {}, [detectedPanel, addCustomPanel]);
}
