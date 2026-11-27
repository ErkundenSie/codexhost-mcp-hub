/**
 * Modal dialogs renderer: Quick Config (2-step batch-apply), Unified Add MCP, Edit Server, and confirmations.
 */

import { transportSignature } from "../shared/models.mjs";
import { el, formatTransportPreview, parseKvLines, svgEl } from "./dom.mjs";

function makeWizardBoltIcon() {
  return svgEl(
    "svg",
    {
      width: 15,
      height: 15,
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: "currentColor",
      "stroke-width": 2.2,
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
      "aria-hidden": "true",
    },
    [svgEl("polygon", { points: "13 2 3 14 12 14 11 22 21 10 12 10 13 2" })],
  );
}

function buildTransportFromForm(m) {
  if (m.transportType === "stdio") {
    const transport = {
      type: "stdio",
      command: m.command.trim(),
      args: m.argsText
        .split(/\r?\n/)
        .map((x) => x.trim())
        .filter(Boolean),
      env: parseKvLines(m.envText, "="),
    };
    const cwd = m.cwd.trim();
    if (cwd) transport.cwd = cwd;
    return transport;
  }
  const transport = {
    type: m.transportType,
    url: m.url.trim(),
    headers: parseKvLines(m.headersText, ":"),
  };
  const bearerEnv = m.bearerTokenEnvVar.trim();
  if (bearerEnv) transport.bearerTokenEnvVar = bearerEnv;
  return transport;
}

function renderServerFormFields(ctx, m, targetSetKey) {
  const { t, render, managedTargets } = ctx;
  const managed = managedTargets();
  const targetsSet = m[targetSetKey];

  return el("div", { className: "mh-form-grid" }, [
    el("div", { className: "mh-field-row" }, [
      el("div", { className: "mh-field" }, [
        el("label", { text: t("fieldName") }),
        el("input", {
          className: "mh-input",
          value: m.name,
          onInput: (e) => {
            m.name = e.target.value;
          },
        }),
      ]),
      el("div", { className: "mh-field" }, [
        el("label", { text: t("fieldTransport") }),
        el(
          "select",
          {
            className: "mh-select",
            value: m.transportType,
            onChange: (e) => {
              m.transportType = e.target.value;
              render();
            },
          },
          [
            el("option", { value: "stdio", text: "stdio (command + args)" }),
            el("option", { value: "http", text: "HTTP / Streamable HTTP" }),
            el("option", { value: "sse", text: "SSE" }),
          ],
        ),
      ]),
    ]),
    el("div", { className: "mh-field-row" }, [
      el("div", { className: "mh-field" }, [
        el("label", { text: t("fieldAlias") }),
        el("input", {
          className: "mh-input",
          placeholder: "Codex / Pi / ...",
          value: m.alias || "",
          onInput: (e) => {
            m.alias = e.target.value;
          },
        }),
      ]),
      el("div", { className: "mh-field" }, [
        el("label", { text: t("fieldDesc") }),
        el("input", {
          className: "mh-input",
          value: m.description,
          onInput: (e) => {
            m.description = e.target.value;
          },
        }),
      ]),
    ]),
    ...(m.transportType === "stdio"
      ? [
          el("div", { className: "mh-field" }, [
            el("label", { text: t("fieldCommand") }),
            el("input", {
              className: "mh-input",
              placeholder: "npx / uvx / node / C:\\path\\to\\server.exe",
              value: m.command,
              onInput: (e) => {
                m.command = e.target.value;
              },
            }),
          ]),
          el("div", { className: "mh-field" }, [
            el("label", { text: t("fieldArgs") }),
            el("textarea", {
              className: "mh-textarea",
              placeholder: "-y\n@modelcontextprotocol/server-filesystem\nD:\\Projects",
              value: m.argsText,
              onInput: (e) => {
                m.argsText = e.target.value;
              },
            }),
          ]),
          el("div", { className: "mh-field" }, [
            el("label", { text: t("fieldEnv") }),
            el("textarea", {
              className: "mh-textarea",
              placeholder: "API_KEY=xxx",
              value: m.envText,
              onInput: (e) => {
                m.envText = e.target.value;
              },
            }),
          ]),
          el("div", { className: "mh-field" }, [
            el("label", { text: t("fieldCwd") }),
            el("input", {
              className: "mh-input",
              value: m.cwd,
              onInput: (e) => {
                m.cwd = e.target.value;
              },
            }),
          ]),
        ]
      : [
          el("div", { className: "mh-field" }, [
            el("label", { text: t("fieldUrl") }),
            el("input", {
              className: "mh-input",
              placeholder: "https://example.com/mcp",
              value: m.url,
              onInput: (e) => {
                m.url = e.target.value;
              },
            }),
          ]),
          el("div", { className: "mh-field" }, [
            el("label", { text: t("fieldHeaders") }),
            el("textarea", {
              className: "mh-textarea",
              placeholder: "Authorization: Bearer xxx",
              value: m.headersText,
              onInput: (e) => {
                m.headersText = e.target.value;
              },
            }),
          ]),
          el("div", { className: "mh-field" }, [
            el("label", { text: t("fieldBearerEnv") }),
            el("input", {
              className: "mh-input",
              placeholder: "MY_MCP_TOKEN",
              value: m.bearerTokenEnvVar,
              onInput: (e) => {
                m.bearerTokenEnvVar = e.target.value;
              },
            }),
          ]),
        ]),
    el("div", { className: "mh-field" }, [
      el("div", { className: "mh-ai-panel-head", style: "margin-bottom:4px" }, [
        el("label", { text: t("fieldTargets") }),
        el("div", { className: "mh-actions" }, [
          el("button", {
            className: "mh-btn-link",
            text: t("btnSelectAll"),
            onClick: () => {
              m[targetSetKey] = new Set(managed.map((x) => x.id));
              render();
            },
          }),
          el("button", {
            className: "mh-btn-link",
            text: t("btnSelectNone"),
            onClick: () => {
              m[targetSetKey] = new Set();
              render();
            },
          }),
        ]),
      ]),
      el(
        "div",
        { className: "mh-ai-grid", style: "grid-template-columns: repeat(3, minmax(0, 1fr))" },
        managed.map((tg) => {
          const selected = targetsSet.has(tg.id);
          return el(
            "button",
            {
              className: `mh-ai-tile ${selected ? "is-selected-solid" : ""}`,
              onClick: () => {
                if (selected) targetsSet.delete(tg.id);
                else targetsSet.add(tg.id);
                render();
              },
            },
            [
              el("span", { text: tg.shortName || tg.name }),
              el("span", { className: "mh-tile-mark", text: selected ? "✓" : "" }),
            ],
          );
        }),
      ),
    ]),
  ]);
}

function renderBatchPreviewRows(ctx, m, managed) {
  const { state, t } = ctx;
  const allServers = state.overview?.servers ?? [];
  const selectedServers = allServers.filter((s) => m.ids.includes(s.id));
  const chosenTargets = managed.filter((tg) => m.targets.has(tg.id));

  if (chosenTargets.length === 0) {
    return [el("div", { className: "mh-batch-preview-row", text: t("batchPreviewEmpty") })];
  }

  const rows = [];
  for (const tg of chosenTargets) {
    const nativeByName = new Map(tg.nativeServers.map((ns) => [ns.name, ns]));
    const adds = [];
    const overwrites = [];
    const skips = [];
    const removes = [];

    for (const s of selectedServers) {
      const native = nativeByName.get(s.name);
      if (m.mode === "add") {
        if (!native) {
          adds.push(s.name);
        } else {
          const same =
            native.enabled !== false &&
            transportSignature(native.transport) === transportSignature(s.transport);
          if (!same) {
            if (m.skipExisting) skips.push(s.name);
            else overwrites.push(s.name);
          }
        }
      } else if (
        native &&
        !(native.isBuiltin && (!native.builtinOwnerTargetId || native.builtinOwnerTargetId === tg.id))
      ) {
        removes.push(s.name);
      }
    }

    const parts = [];
    if (adds.length) parts.push(el("span", { text: t("batchPreviewAdd", { names: adds.join("、") }) }));
    if (overwrites.length) {
      parts.push(
        el("span", {
          className: "mh-warn-text",
          text: t("batchPreviewOverwrite", { names: overwrites.join("、") }),
        }),
      );
    }
    if (skips.length) {
      parts.push(
        el("span", {
          className: "mh-warn-text",
          text: t("batchPreviewSkip", { names: skips.join("、") }),
        }),
      );
    }
    if (removes.length) {
      parts.push(
        el("span", {
          className: "mh-danger-text",
          text: t("batchPreviewRemove", { names: removes.join("、") }),
        }),
      );
    }

    if (parts.length > 0) {
      const interleaved = [el("strong", { text: `• ${tg.shortName || tg.name}：` })];
      parts.forEach((p, idx) => {
        if (idx > 0) interleaved.push(document.createTextNode(" ｜ "));
        interleaved.push(p);
      });
      rows.push(el("div", { className: "mh-batch-preview-row" }, interleaved));
    }
  }

  if (rows.length === 0) {
    return [el("div", { className: "mh-batch-preview-row", text: t("batchPreviewNoop") })];
  }
  return rows;
}

export function renderModal(ctx) {
  const { state, api, t, render, showToast, managedTargets } = ctx;
  const m = state.modal;
  if (!m) return null;

  const close = () => {
    state.modal = null;
    render();
  };

  let title = "";
  let titleIcon = null;
  let modalTabs = null;
  let body = [];
  let footer = [];

  if (m.type === "batch-apply") {
    const managed = managedTargets();
    const allServers = state.overview?.servers ?? [];
    const isStep1 = m.step === 1;
    const isAdd = m.mode === "add";

    if (m.fromWizard) {
      titleIcon = el("span", { className: "mh-wizard-title-icon" }, [makeWizardBoltIcon()]);
      modalTabs = el("div", { className: "mh-wizard-stepper" }, [
        el("span", { className: `mh-wizard-step ${isStep1 ? "is-active" : "is-done"}` }, [
          el("span", { className: "mh-wizard-step-num", text: isStep1 ? "1" : "✓" }),
          el("span", { text: t("wizardStep1") }),
        ]),
        el("span", { className: `mh-wizard-step-line ${!isStep1 ? "is-done" : ""}` }),
        el("span", { className: `mh-wizard-step ${!isStep1 ? "is-active" : ""}` }, [
          el("span", { className: "mh-wizard-step-num", text: "2" }),
          el("span", { text: t("wizardStep2") }),
        ]),
      ]);
    }

    if (isStep1) {
      title = m.fromWizard ? t("wizardTitle") : t("modalBatchStep1Title");
      const selectedSet = new Set(m.ids);
      body = [
        el("div", { className: "mh-ai-panel-head", style: "margin-bottom:10px" }, [
          el("span", { text: t("modalBatchStep1Hint") }),
          el("div", { className: "mh-actions" }, [
            el("button", {
              className: "mh-btn-link",
              text: t("btnSelectAll"),
              onClick: () => {
                m.ids = allServers.map((s) => s.id);
                render();
              },
            }),
            el("button", {
              className: "mh-btn-link",
              text: t("btnSelectNone"),
              onClick: () => {
                m.ids = [];
                render();
              },
            }),
          ]),
        ]),
        el("div", { className: "mh-ai-panel-head", style: "margin-bottom:10px" }, [
          el("span", { text: t("batchModeLabel") }),
          el("div", { className: "mh-mode-seg" }, [
            el("button", {
              className: isAdd ? "is-active" : "",
              text: t("batchAddBtn"),
              onClick: () => {
                m.mode = "add";
                m.skipExisting = true;
                render();
              },
            }),
            el("button", {
              className: !isAdd ? "is-active-danger" : "",
              text: t("batchRemoveBtn"),
              onClick: () => {
                m.mode = "remove";
                m.skipExisting = false;
                render();
              },
            }),
          ]),
        ]),
        el(
          "div",
          { className: "mh-list", style: "gap:8px" },
          allServers.map((s) => {
            const picked = selectedSet.has(s.id);
            const togglePick = () => {
              if (picked) m.ids = m.ids.filter((id) => id !== s.id);
              else m.ids = [...m.ids, s.id];
              render();
            };
            return el(
              "div",
              {
                className: `mh-import-row mh-pick-row ${picked ? "is-picked" : ""}`,
                onClick: (e) => {
                  if (e.target.tagName !== "INPUT" && !e.target.closest("label")) togglePick();
                },
              },
              [
                el("label", { className: "mh-switch" }, [
                  el("input", {
                    type: "checkbox",
                    checked: picked,
                    onChange: () => togglePick(),
                  }),
                ]),
                el("div", { className: "mh-import-row-main" }, [
                  el("div", { className: "mh-card-title", style: "font-size:13px" }, [
                    el("span", { text: s.name }),
                    s.alias ? el("span", { className: "mh-tag mh-tag-alias", text: s.alias }) : null,
                    el("span", { className: "mh-tag mh-tag-mono", text: s.transport?.type || "stdio" }),
                  ]),
                  el("div", {
                    className: "mh-cmd-inline",
                    text: formatTransportPreview(s.transport),
                  }),
                ]),
              ],
            );
          }),
        ),
      ];

      footer = [
        el("button", { className: "mh-btn", text: t("btnCancel"), onClick: close }),
        el("button", {
          className: "mh-btn mh-btn-primary",
          disabled: m.ids.length === 0,
          text: t("btnNextStep"),
          onClick: () => {
            m.step = 2;
            render();
          },
        }),
      ];
    } else {
      title = isAdd
        ? t("modalBatchAddTitle", { count: m.ids.length })
        : t("modalBatchRemoveTitle", { count: m.ids.length });

      body = [
        el("div", { className: "mh-ai-panel-head", style: "margin-bottom:8px" }, [
          el("span", { text: isAdd ? t("batchAddHint") : t("batchRemoveHint") }),
          el("div", { className: "mh-actions" }, [
            el("button", {
              className: "mh-btn-link",
              text: t("btnSelectAll"),
              onClick: () => {
                m.targets = new Set(managed.map((x) => x.id));
                render();
              },
            }),
            el("button", {
              className: "mh-btn-link",
              text: t("btnSelectNone"),
              onClick: () => {
                m.targets = new Set();
                render();
              },
            }),
          ]),
        ]),
        el(
          "div",
          { className: "mh-ai-grid", style: "grid-template-columns: repeat(3, minmax(0, 1fr))" },
          managed.map((tg) => {
            const selected = m.targets.has(tg.id);
            return el(
              "button",
              {
                className: `mh-ai-tile ${selected ? "is-selected-solid" : ""}`,
                onClick: () => {
                  if (selected) m.targets.delete(tg.id);
                  else m.targets.add(tg.id);
                  render();
                },
              },
              [
                el("span", { text: tg.shortName || tg.name }),
                el("span", { className: "mh-tile-mark", text: selected ? "✓" : "" }),
              ],
            );
          }),
        ),
        isAdd
          ? el("label", { className: "mh-switch", style: "margin-top:12px" }, [
              el("input", {
                type: "checkbox",
                checked: m.skipExisting,
                onChange: (e) => {
                  m.skipExisting = e.target.checked;
                  render();
                },
              }),
              t("batchSkipExisting"),
            ])
          : null,
        el("div", { className: "mh-batch-preview" }, [
          el("strong", { text: t("batchPreviewTitle") }),
          ...renderBatchPreviewRows(ctx, m, managed),
        ]),
      ];

      footer = [
        m.fromWizard
          ? el("button", {
              className: "mh-btn",
              text: t("btnPrevStep"),
              onClick: () => {
                m.step = 1;
                render();
              },
            })
          : null,
        el("button", { className: "mh-btn", text: t("btnCancel"), onClick: close }),
        el("button", {
          className: `mh-btn ${isAdd ? "mh-btn-apply" : "mh-btn-danger"}`,
          disabled: state.syncing || m.targets.size === 0,
          text: state.syncing ? t("btnSyncing") : t("btnApplyNow"),
          onClick: async () => {
            state.syncing = true;
            render();
            try {
              const res = await api.backend.invoke("servers/batch-apply", {
                ids: m.ids,
                targetIds: [...m.targets],
                mode: m.mode,
                skipExisting: m.skipExisting,
              });
              state.overview = res.overview;
              state.selectedServerIds.clear();
              state.modal = null;
              if (res.errorCount > 0) {
                showToast(t("syncPartialErr", { count: res.errorCount }), true);
              } else if (res.skippedCount > 0) {
                showToast(
                  t("syncDoneWithSkipped", { count: res.updatedCount, skipped: res.skippedCount }),
                );
              } else {
                showToast(t("syncDone", { count: res.updatedCount }));
              }
            } catch (err) {
              showToast(err instanceof Error ? err.message : String(err), true);
            } finally {
              state.syncing = false;
              render();
            }
          },
        }),
      ];
    }
  } else if (m.type === "add-unified") {
    title = t("modalAddTitle");
    const managed = managedTargets();
    modalTabs = el(
      "div",
      { className: "mh-modal-tabs" },
      [
        ["json", t("addTabJson")],
        ["form", t("addTabForm")],
        ["import", t("addTabImport")],
      ].map(([id, label]) =>
        el("button", {
          className: `mh-tab ${m.mode === id ? "is-active" : ""}`,
          text: label,
          onClick: () => {
            m.mode = id;
            render();
          },
        }),
      ),
    );

    if (m.mode === "json") {
      body = [
        el("div", { className: "mh-form-grid" }, [
          el("div", { className: "mh-field" }, [
            el("label", { text: t("fieldJsonPaste") }),
            el("textarea", {
              className: "mh-textarea",
              style: "min-height:175px",
              placeholder:
                '{\n  "mcpServers": {\n    "filesystem": {\n      "command": "npx",\n      "args": ["-y", "@modelcontextprotocol/server-filesystem", "D:\\\\Projects"]\n    }\n  }\n}',
              value: m.jsonText,
              onInput: (e) => {
                m.jsonText = e.target.value;
              },
            }),
          ]),
          el("div", { className: "mh-field" }, [
            el("label", { text: t("fieldTargets") }),
            el(
              "div",
              { className: "mh-ai-grid", style: "grid-template-columns: repeat(3, minmax(0, 1fr))" },
              managed.map((tg) => {
                const selected = m.jsonTargets.has(tg.id);
                return el(
                  "button",
                  {
                    className: `mh-ai-tile ${selected ? "is-selected-solid" : ""}`,
                    onClick: () => {
                      if (selected) m.jsonTargets.delete(tg.id);
                      else m.jsonTargets.add(tg.id);
                      render();
                    },
                  },
                  [
                    el("span", { text: tg.shortName || tg.name }),
                    el("span", { className: "mh-tile-mark", text: selected ? "✓" : "" }),
                  ],
                );
              }),
            ),
          ]),
          el("label", { className: "mh-switch" }, [
            el("input", {
              type: "checkbox",
              checked: m.jsonOverwrite,
              onChange: (e) => {
                m.jsonOverwrite = e.target.checked;
              },
            }),
            t("importOverwrite"),
          ]),
        ]),
      ];
      footer = [
        el("button", { className: "mh-btn", text: t("btnCancel"), onClick: close }),
        el("button", {
          className: "mh-btn mh-btn-primary",
          text: t("btnSave"),
          onClick: async () => {
            try {
              const res = await api.backend.invoke("servers/import-json", {
                jsonText: m.jsonText,
                targets: [...m.jsonTargets],
                overwrite: m.jsonOverwrite,
              });
              state.overview = res.overview;
              showToast(t("toastImported", { added: res.added, updated: res.updated }));
              state.modal = null;
              render();
              void ctx.maybeProbeUncheckedAuthHints?.(state.overview);
            } catch (err) {
              showToast(err instanceof Error ? err.message : String(err), true);
            }
          },
        }),
      ];
    } else if (m.mode === "form") {
      body = [renderServerFormFields(ctx, m, "formTargets")];
      footer = [
        el("button", { className: "mh-btn", text: t("btnCancel"), onClick: close }),
        el("button", {
          className: "mh-btn mh-btn-primary",
          text: t("btnSave"),
          onClick: async () => {
            try {
              state.overview = await api.backend.invoke("servers/save", {
                name: m.name,
                alias: m.alias,
                description: m.description,
                enabled: true,
                transport: buildTransportFromForm(m),
                targets: [...m.formTargets],
              });
              showToast(t("toastSaved", { name: m.name.trim() }));
              state.modal = null;
              render();
              void ctx.maybeProbeUncheckedAuthHints?.(state.overview);
            } catch (err) {
              showToast(err instanceof Error ? err.message : String(err), true);
            }
          },
        }),
      ];
    } else {
      const candidates = state.overview?.importCandidates ?? [];
      const excludedBuiltins = state.overview?.excludedBuiltins ?? [];
      body = [
        el("div", { className: "mh-hint-box", text: t("importActualHint") }),
        candidates.length === 0
          ? el("div", { className: "mh-desc", text: t("importEmptyCandidates") })
          : el(
              "div",
              { className: "mh-list" },
              candidates.map((c) => {
                const key = c.variantKey || c.name;
                const checked = m.importSelected.has(key);
                const aisText = c.presentIn.map((p) => p.targetName).join(", ");
                return el("div", { className: "mh-import-row" }, [
                  el("label", { className: "mh-switch" }, [
                    el("input", {
                      type: "checkbox",
                      checked,
                      onChange: (e) => {
                        if (e.target.checked) m.importSelected.add(key);
                        else m.importSelected.delete(key);
                        render();
                      },
                    }),
                  ]),
                  el("div", { className: "mh-import-row-main" }, [
                    el("div", { className: "mh-card-title", style: "font-size:13px" }, [
                      el("span", { text: c.name }),
                      c.hasVariants
                        ? el("span", {
                            className: "mh-tag mh-tag-alias",
                            text: t("importVariantTag", { alias: c.suggestedAlias }),
                          })
                        : null,
                      el("span", { className: "mh-tag mh-tag-mono", text: c.transport?.type || "stdio" }),
                      c.alreadyInHub
                        ? el("span", { className: "mh-tag mh-tag-accent", text: t("importAlreadyInHub") })
                        : null,
                      c.isLoopback
                        ? el("span", { className: "mh-tag mh-tag-danger", text: t("badgeLoopback") })
                        : null,
                    ]),
                    el("div", {
                      className: "mh-cmd-inline",
                      text: formatTransportPreview(c.transport),
                    }),
                    el("div", {
                      className: "mh-import-row-meta",
                      text: t("importPresentIn", { ais: aisText }),
                    }),
                  ]),
                ]);
              }),
            ),
        excludedBuiltins.length > 0
          ? el("div", { className: "mh-field", style: "margin-top:12px" }, [
              el("div", {
                className: "mh-desc",
                text: t("importSkippedBuiltinCount", { count: excludedBuiltins.length }),
              }),
              el(
                "div",
                { className: "mh-chips" },
                excludedBuiltins.map((b) =>
                  el("span", {
                    className: "mh-tag",
                    text: `${b.name} · ${t("badgeBuiltin", { vendor: b.vendor })}`,
                  }),
                ),
              ),
            ])
          : null,
      ];
      footer = [
        el("button", { className: "mh-btn", text: t("btnCancel"), onClick: close }),
        el("button", {
          className: "mh-btn mh-btn-primary",
          disabled: m.importSelected.size === 0,
          text: t("importAction", { count: m.importSelected.size }),
          onClick: async () => {
            try {
              const res = await api.backend.invoke("servers/import-from-target", {
                sourceTargetId: "all",
                selectedVariants: [...m.importSelected],
                overwrite: false,
              });
              state.overview = res.overview;
              showToast(
                res.skippedBuiltin > 0
                  ? t("toastImportedWithSkipped", {
                      added: res.added,
                      updated: res.updated,
                      skipped: res.skippedBuiltin,
                    })
                  : t("toastImported", { added: res.added, updated: res.updated }),
              );
              state.modal = null;
              render();
              void ctx.maybeProbeUncheckedAuthHints?.(state.overview);
            } catch (err) {
              showToast(err instanceof Error ? err.message : String(err), true);
            }
          },
        }),
      ];
    }
  } else if (m.type === "edit-server") {
    const isAccountClone = Boolean(m.isClone && m.isAccountMode);
    const isOAuthClone = Boolean(isAccountClone && m.cloneAuthMode === "oauth");
    title = !m.isClone
      ? t("modalEditTitle")
      : isAccountClone
        ? t("modalCloneAccountTitle", { name: m.name })
        : t("modalCloneConfigTitle", { name: m.name });

    const modeSwitcher = isAccountClone
      ? el("div", { className: "mh-seg-tabs", style: "margin-bottom:14px" }, [
          el("button", {
            className: `mh-seg-tab ${m.cloneAuthMode === "oauth" ? "is-active" : ""}`,
            text: t("cloneModeOAuth"),
            onClick: () => {
              m.cloneAuthMode = "oauth";
              render();
            },
          }),
          el("button", {
            className: `mh-seg-tab ${m.cloneAuthMode === "config" ? "is-active" : ""}`,
            text: t("cloneModeConfig"),
            onClick: () => {
              m.cloneAuthMode = "config";
              render();
            },
          }),
        ])
      : null;

    if (isOAuthClone) {
      const managed = managedTargets();
      body = [
        modeSwitcher,
        el("p", { className: "mh-desc", text: t("cloneOAuthHint") }),
        el("div", { className: "mh-form-grid" }, [
          el("div", { className: "mh-field" }, [
            el("label", { text: t("cloneAccountAliasLabel") }),
            el("input", {
              className: "mh-input",
              placeholder: t("cloneAccountAliasPlaceholder"),
              value: m.alias || "",
              onInput: (e) => {
                m.alias = e.target.value;
              },
            }),
          ]),
          el("div", { className: "mh-field" }, [
            el("div", { className: "mh-ai-panel-head" }, [
              el("label", { style: "margin:0", text: t("cloneAccountTargetsLabel") }),
              el("div", { className: "mh-actions" }, [
                el("button", {
                  className: "mh-btn-link",
                  text: t("btnSelectAll"),
                  onClick: () => {
                    m.targets = new Set(managed.map((tg) => tg.id));
                    render();
                  },
                }),
                el("button", {
                  className: "mh-btn-link",
                  text: t("btnSelectNone"),
                  onClick: () => {
                    m.targets = new Set();
                    render();
                  },
                }),
              ]),
            ]),
            el(
              "div",
              { className: "mh-ai-grid", style: "margin-top:6px" },
              managed.map((tg) => {
                const on = m.targets.has(tg.id);
                return el(
                  "button",
                  {
                    className: `mh-ai-tile ${on ? "is-selected-solid" : ""}`,
                    onClick: () => {
                      if (on) m.targets.delete(tg.id);
                      else m.targets.add(tg.id);
                      render();
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
        ]),
      ];
    } else {
      body = [
        modeSwitcher,
        m.isClone
          ? el("p", {
              className: "mh-desc",
              text: isAccountClone ? t("modalCloneAccountConfigHint") : t("modalCloneConfigHint"),
            })
          : null,
        renderServerFormFields(ctx, m, "targets"),
      ];
    }

    footer = [
      el("button", { className: "mh-btn", text: t("btnCancel"), onClick: close }),
      el("button", {
        className: "mh-btn mh-btn-primary",
        text: isOAuthClone ? t("cloneOAuthSubmitBtn") : t("btnSave"),
        onClick: async () => {
          try {
            const prevIds = new Set((state.overview?.servers ?? []).map((s) => s.id));
            const transport = isOAuthClone
              ? { type: m.transportType, url: m.url.trim(), headers: {} }
              : buildTransportFromForm(m);
            const payload = {
              name: m.name,
              alias: m.alias,
              description: m.description,
              enabled: m.enabled,
              transport,
              targets: [...m.targets],
            };
            if (m.id) payload.id = m.id;
            state.overview = await api.backend.invoke("servers/save", payload);
            const savedName = m.name.trim();
            let created = null;
            if (m.isClone) {
              created = (state.overview?.servers ?? []).find(
                (s) => s.name === savedName && !prevIds.has(s.id),
              );
              if (created) {
                state.activeVariantByName[savedName] = created.id;
              }
            }
            state.modal = null;
            render();
            if (isOAuthClone && created) {
              void ctx.startOAuthLogin(created);
            } else {
              showToast(t("toastSaved", { name: savedName }));
              void ctx.maybeProbeUncheckedAuthHints?.(state.overview);
            }
          } catch (err) {
            showToast(err instanceof Error ? err.message : String(err), true);
          }
        },
      }),
    ];
  } else if (m.type === "oauth-confirm") {
    title = t("oauthConfirmTitle", { name: m.serverName });
    body = [
      el("p", { className: "mh-desc", text: t("oauthConfirmLead") }),
      el("ul", { className: "mh-confirm-list" }, [
        el("li", { text: t("oauthConfirmPoint1") }),
        el("li", { text: t("oauthConfirmPoint2") }),
        el("li", { text: t("oauthConfirmPoint3") }),
      ]),
    ];
    footer = [
      el("button", { className: "mh-btn", text: t("btnCancel"), onClick: close }),
      el("button", {
        className: "mh-btn mh-btn-primary",
        text: t("oauthConfirmProceedBtn"),
        onClick: () => {
          const targetServer = m.server;
          state.modal = null;
          render();
          void ctx.startOAuthLogin(targetServer);
        },
      }),
    ];
  } else if (m.type === "oauth-sync") {
    const managed = managedTargets();
    title = m.fromLogin
      ? t("oauthModalTitle", { name: m.serverName })
      : t("oauthModalSyncTitle", { name: m.serverName });
    body = [
      el("p", { className: "mh-desc", text: t("oauthModalDesc") }),
      el("div", { className: "mh-note-box", style: "margin-bottom:12px" }, [
        el("span", {
          text: m.hasRefreshToken ? t("oauthModalAutoRefreshNote") : t("oauthModalNoRefreshNote"),
        }),
      ]),
      el("div", { className: "mh-ai-panel-head" }, [
        el("span", { text: t("oauthModalTargetsLabel", { count: m.targets.size }) }),
        el("div", { className: "mh-actions" }, [
          el("button", {
            className: "mh-btn-link",
            text: t("btnSelectAll"),
            onClick: () => {
              m.targets = new Set(managed.map((tg) => tg.id));
              render();
            },
          }),
          el("button", {
            className: "mh-btn-link",
            text: t("btnSelectNone"),
            onClick: () => {
              m.targets = new Set();
              render();
            },
          }),
        ]),
      ]),
      el(
        "div",
        { className: "mh-ai-grid", style: "margin-top:8px" },
        managed.map((tg) => {
          const on = m.targets.has(tg.id);
          return el(
            "button",
            {
              className: `mh-ai-tile ${on ? "is-selected-solid" : ""}`,
              onClick: () => {
                if (on) m.targets.delete(tg.id);
                else m.targets.add(tg.id);
                render();
              },
            },
            [
              el("span", { text: tg.shortName || tg.name }),
              el("span", { className: "mh-tile-mark", text: on ? "✓" : "" }),
            ],
          );
        }),
      ),
      m.targets.size === 0
        ? el("p", {
            className: "mh-desc",
            style: "margin-top:10px;margin-bottom:0",
            text: t("oauthModalSelectHint"),
          })
        : null,
    ];
    footer = [
      el("button", {
        className: "mh-btn",
        disabled: state.syncing,
        text: m.fromLogin ? t("oauthModalSkipBtn") : t("btnCancel"),
        onClick: close,
      }),
      el("button", {
        className: "mh-btn mh-btn-primary",
        disabled: state.syncing || m.targets.size === 0,
        text: state.syncing
          ? t("oauthModalApplying")
          : t("oauthModalApplyBtn", { count: m.targets.size }),
        onClick: () => ctx.applyOAuthHeaderToTargets(m.serverId, m.serverName, [...m.targets]),
      }),
    ];
  } else if (m.type === "confirm-delete") {
    title = t("btnDelete");
    body = [el("p", { text: t("confirmDelete", { name: m.server.name }) })];
    footer = [
      el("button", { className: "mh-btn", text: t("btnCancel"), onClick: close }),
      el("button", {
        className: "mh-btn mh-btn-danger",
        text: t("btnDelete"),
        onClick: async () => {
          try {
            state.overview = await api.backend.invoke("servers/delete", { id: m.server.id });
            showToast(t("toastDeleted", { name: m.server.name }));
            state.modal = null;
            render();
          } catch (err) {
            showToast(err instanceof Error ? err.message : String(err), true);
          }
        },
      }),
    ];
  } else if (m.type === "view-config") {
    const fmtLabel =
      m.format === "codex-toml" ? "TOML" : m.format?.endsWith("-yaml") ? "YAML" : "JSON";
    title = `${m.targetName || m.targetId} · ${fmtLabel}`;
    body = [
      el("div", { className: "mh-path-readonly", style: "margin-top:0;margin-bottom:10px" }, [
        el("span", { className: "mh-path-readonly-text", title: m.configPath, text: m.configPath }),
      ]),
      m.error ? el("div", { className: "mh-probe-bar is-err", style: "margin:0 0 10px", text: m.error }) : null,
      m.exists && m.rawText
        ? el("pre", { className: "mh-raw-code", text: m.rawText })
        : el("div", { className: "mh-backup-empty", text: t("targetConfigEmpty") }),
    ];
    footer = [
      m.exists && m.rawText
        ? el("button", {
            className: "mh-btn",
            text: t("btnCopyContent"),
            onClick: async () => {
              try {
                await navigator.clipboard.writeText(m.rawText);
                showToast(t("btnCopied"));
              } catch {
                showToast(t("btnCopied"));
              }
            },
          })
        : null,
      el("button", { className: "mh-btn mh-btn-primary", text: t("btnClose"), onClick: close }),
    ];
  } else if (m.type === "confirm-restore") {
    title = t("btnRestore");
    body = [
      el("p", { text: t("confirmRestore", { target: m.backup.targetName || m.backup.targetId }) }),
      el("div", { className: "mh-code-line", text: m.backup.configPath }),
    ];
    footer = [
      el("button", { className: "mh-btn", text: t("btnCancel"), onClick: close }),
      el("button", {
        className: "mh-btn mh-btn-primary",
        text: t("btnRestore"),
        onClick: async () => {
          try {
            const res = await api.backend.invoke("backups/restore", { backupId: m.backup.id });
            state.overview = res.overview;
            showToast(t("toastRestored", { path: res.restored.configPath }));
            state.modal = null;
            render();
          } catch (err) {
            showToast(err instanceof Error ? err.message : String(err), true);
          }
        },
      }),
    ];
  }

  return el(
    "div",
    {
      className: "mh-modal-backdrop",
      onClick: (e) => {
        if (e.target === e.currentTarget) close();
      },
    },
    [
      el("div", { className: "mh-modal" }, [
        el("div", { className: "mh-modal-head" }, [
          el("span", { className: "mh-modal-title-wrap" }, [titleIcon, el("span", { text: title })]),
          el("button", { className: "mh-btn mh-btn-sm", text: "✕", onClick: close }),
        ]),
        modalTabs,
        el("div", { className: "mh-modal-body" }, body),
        el("div", { className: "mh-modal-foot" }, footer),
      ]),
    ],
  );
}
