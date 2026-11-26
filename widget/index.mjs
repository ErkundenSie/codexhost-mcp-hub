/**
 * Cross-platform floating widget (`manifestVersion: 2` `widget` entry).
 * Runs in Desktop and Web main windows via Shadow DOM.
 * Only interactive areas use `pointer-events: auto` so the rest passes clicks through.
 */

import { createTranslator } from "../shared/i18n.mjs";

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "className") node.className = v;
    else if (k === "text") node.textContent = String(v);
    else if (k.startsWith("on") && typeof v === "function") {
      node.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (k === "disabled") {
      node.disabled = v;
    } else {
      node.setAttribute(k, String(v));
    }
  }
  const list = Array.isArray(children) ? children : [children];
  for (const child of list) {
    if (child === null || child === undefined || child === false) continue;
    if (typeof child === "string" || typeof child === "number") {
      node.appendChild(document.createTextNode(String(child)));
    } else {
      node.appendChild(child);
    }
  }
  return node;
}

export async function mount(root, api) {
  let locale = api.locale || "zh-CN";
  let t = createTranslator(locale);
  let visible = true;
  let expanded = false;
  let busy = false;
  let overview = null;
  let statusText = "";
  let statusError = false;

  try {
    const settings = await api.storage.get();
    visible = settings.showWidget !== false;
  } catch {
    visible = true;
  }

  async function refresh() {
    if (api.signal.aborted) return;
    busy = true;
    render();
    try {
      overview = await api.backend.invoke("overview");
      statusText = "";
      statusError = false;
    } catch (err) {
      statusText = err instanceof Error ? err.message : String(err);
      statusError = true;
    } finally {
      busy = false;
      render();
    }
  }

  async function syncNow() {
    if (api.signal.aborted) return;
    busy = true;
    statusText = t("widgetSyncing");
    statusError = false;
    render();
    try {
      const res = await api.backend.invoke("sync/apply", {});
      overview = res.overview;
      statusText =
        res.errorCount > 0
          ? t("syncPartialErr", { count: res.errorCount })
          : t("syncDone", { count: res.updatedCount });
      statusError = res.errorCount > 0;
    } catch (err) {
      statusText = err instanceof Error ? err.message : String(err);
      statusError = true;
    } finally {
      busy = false;
      render();
    }
  }

  function render() {
    if (api.signal.aborted) return;
    if (!visible) {
      root.replaceChildren();
      return;
    }

    const summary = overview?.summary;
    const pending = summary?.pendingChanges ?? 0;
    const managedTargets = (overview?.targets ?? []).filter((x) => x.enabled);
    const diffById = new Map((overview?.diffs ?? []).map((d) => [d.targetId, d]));

    const panel = expanded
      ? el("div", { className: "mhw-panel" }, [
          el("div", { className: "mhw-panel-head" }, [
            el("span", { text: t("widgetTitle") }),
            el("button", {
              className: "mhw-close",
              text: "✕",
              onClick: () => {
                expanded = false;
                render();
              },
            }),
          ]),
          el("div", { className: "mhw-meta" }, [
            el("span", {
              className: "mhw-chip",
              text: t("widgetManagedCount", { count: summary?.totalServers ?? 0 }),
            }),
            el("span", {
              className: "mhw-chip",
              text: t("widgetDetectedCount", { count: summary?.managedTargets ?? managedTargets.length }),
            }),
            el("span", {
              className: `mhw-chip ${pending > 0 ? "is-accent" : ""}`,
              text: pending > 0 ? t("widgetPending", { count: pending }) : t("widgetAllSynced"),
            }),
          ]),
          el(
            "div",
            { className: "mhw-target-list" },
            managedTargets.map((tg) => {
              const d = diffById.get(tg.id);
              const delta = d ? d.adds.length + d.updates.length + d.removes.length : 0;
              return el("div", { className: "mhw-target-row" }, [
                el("span", { text: tg.name }),
                el("span", {
                  text: delta > 0 ? `+${delta}` : `${tg.nativeCount} MCP`,
                }),
              ]);
            }),
          ),
          el("div", { className: "mhw-actions" }, [
            el("button", {
              className: "mhw-btn",
              disabled: busy,
              text: t("widgetRefresh"),
              onClick: () => refresh(),
            }),
            el("button", {
              className: "mhw-btn mhw-btn-primary",
              disabled: busy || pending === 0,
              text: busy ? t("widgetSyncing") : t("widgetSyncNow"),
              onClick: () => syncNow(),
            }),
          ]),
          statusText
            ? el("div", {
                className: `mhw-status ${statusError ? "is-err" : ""}`,
                text: statusText,
              })
            : null,
          el("div", { className: "mhw-hint", text: t("widgetHint") }),
        ])
      : null;

    const pill = el(
      "button",
      {
        className: "mhw-pill",
        onClick: () => {
          expanded = !expanded;
          if (expanded && !overview) void refresh();
          else render();
        },
      },
      [
        el("span", { className: `mhw-dot ${pending > 0 ? "is-warn" : ""}` }),
        el("span", {
          text:
            pending > 0
              ? `MCP · ${t("widgetPending", { count: pending })}`
              : `MCP · ${summary ? summary.totalServers : "…"}`,
        }),
      ],
    );

    root.replaceChildren(el("div", { className: "mhw-wrap" }, [panel, pill]));
  }

  const unsubLocale = api.onLocaleChange((next) => {
    locale = next;
    t = createTranslator(next);
    render();
  });

  const unsubStorage = api.storage.onChange((next) => {
    visible = next?.showWidget !== false;
    render();
  });

  render();
  void refresh();

  return () => {
    unsubLocale();
    unsubStorage();
    root.replaceChildren();
  };
}
