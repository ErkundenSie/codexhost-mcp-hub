/**
 * Cross-platform MCP Hub settings page (`manifestVersion: 2` `page` entry).
 *
 * Orchestrates shared page state, header/segmented navigation, modal lifecycle (including Escape close),
 * focus-preserving re-renders, and toast notifications across modular tabs.
 */

import { createTranslator } from "../shared/i18n.mjs";
import { toStandardMcpJson } from "../shared/models.mjs";
import { el, formatKvLines } from "./dom.mjs";
import { renderModal } from "./modals.mjs";
import { renderProjectAndBackupsTab } from "./tabs/project-backups.mjs";
import { renderServersTab } from "./tabs/servers.mjs";
import { renderTargetsTab } from "./tabs/targets.mjs";

export async function mount(root, api) {
  const state = {
    locale: api.locale || "zh-CN",
    colorScheme: api.colorScheme || "light",
    tab: "servers",
    search: "",
    searchComposing: false,
    selectedServerIds: new Set(),
    openMoreId: null,
    showUninstalledTargets: false,
    loading: true,
    syncing: false,
    applyingServerIds: new Set(),
    overview: null,
    backups: [],
    projectDir: "",
    projectScan: null,
    projectFormats: new Set(["project-mcp-json"]),
    probes: {},
    probingIds: new Set(),
    modal: null,
    toasts: [],
  };

  let translate = createTranslator(state.locale);
  const t = (key, vars) => translate(key, vars);

  const rootEl = el("div", {
    className: `mh-root ${state.colorScheme === "dark" ? "is-dark" : ""}`,
  });
  root.replaceChildren(rootEl);

  // Close overflow menu when clicking outside
  rootEl.addEventListener(
    "click",
    (e) => {
      if (state.openMoreId && !e.target.closest?.(".mh-more-wrap")) {
        state.openMoreId = null;
        render();
      }
    },
    { signal: api.signal },
  );

  // Close active modal or overflow menu on Escape
  window.addEventListener(
    "keydown",
    (e) => {
      if (e.key !== "Escape") return;
      if (state.modal && !state.syncing) {
        state.modal = null;
        render();
      } else if (state.openMoreId) {
        state.openMoreId = null;
        render();
      }
    },
    { signal: api.signal },
  );

  let toastContainer = null;
  function renderToasts() {
    if (!toastContainer) {
      toastContainer = el("div", { className: "mh-toast-wrap" });
      rootEl.appendChild(toastContainer);
    }
    toastContainer.replaceChildren(
      ...state.toasts.map((item) =>
        el("div", {
          className: `mh-toast ${item.isError ? "is-error" : ""}`,
          text: item.msg,
        }),
      ),
    );
  }

  function showToast(msg, isError = false) {
    const id = `${Date.now()}-${Math.random()}`;
    state.toasts.push({ id, msg, isError });
    renderToasts();
    const timer = setTimeout(() => {
      state.toasts = state.toasts.filter((x) => x.id !== id);
      renderToasts();
    }, 3800);
    api.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
  }

  async function refreshOverview(silent = false) {
    if (!silent) {
      state.loading = true;
      render();
    }
    try {
      state.overview = await api.backend.invoke("overview");
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), true);
    } finally {
      state.loading = false;
      render();
    }
  }

  async function refreshBackups() {
    try {
      const res = await api.backend.invoke("backups/list");
      state.backups = res?.backups ?? [];
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), true);
    }
    render();
  }

  const unsubLocale = api.onLocaleChange((next) => {
    state.locale = next;
    translate = createTranslator(next);
    render();
  });

  const unsubTheme = api.onColorSchemeChange((next) => {
    state.colorScheme = next;
    rootEl.className = `mh-root ${next === "dark" ? "is-dark" : ""}`;
    render();
  });

  function sortedTargets() {
    const targets = state.overview?.targets ?? [];
    return [...targets].sort((a, b) => {
      if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
      if (a.exists !== b.exists) return a.exists ? -1 : 1;
      if (a.detected !== b.detected) return a.detected ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }

  function managedTargets() {
    return sortedTargets().filter((tg) => tg.enabled);
  }

  function managedTargetIds() {
    return managedTargets().map((tg) => tg.id);
  }

  function openBatchWizard() {
    const allServers = state.overview?.servers ?? [];
    state.modal = {
      type: "batch-apply",
      step: 1,
      fromWizard: true,
      mode: "add",
      ids: allServers.map((s) => s.id),
      targets: new Set(),
      skipExisting: true,
    };
    render();
  }

  function openUnifiedAddModal(initialMode = "json") {
    const candidates = state.overview?.importCandidates ?? [];
    const defaultSelected = new Set(
      candidates.filter((c) => !c.alreadyInHub).map((c) => c.variantKey || c.name),
    );
    state.modal = {
      type: "add-unified",
      mode: initialMode,
      jsonText: "",
      jsonTargets: new Set(managedTargetIds()),
      jsonOverwrite: false,
      name: "",
      alias: "",
      description: "",
      enabled: true,
      transportType: "stdio",
      command: "",
      argsText: "",
      cwd: "",
      envText: "",
      url: "",
      headersText: "",
      bearerTokenEnvVar: "",
      formTargets: new Set(managedTargetIds()),
      importSelected: defaultSelected,
    };
    render();
  }

  function openServerEditor(server) {
    const tr = server?.transport ?? { type: "stdio", command: "", args: [], env: {} };
    state.modal = {
      type: "edit-server",
      id: server.id,
      name: server.name ?? "",
      alias: server.alias ?? "",
      description: server.description ?? "",
      enabled: server.enabled !== false,
      transportType: tr.type || "stdio",
      command: tr.command || "",
      argsText: (tr.args ?? []).join("\n"),
      cwd: tr.cwd || "",
      envText: formatKvLines(tr.env, "="),
      url: tr.url || "",
      headersText: formatKvLines(tr.headers, ": "),
      bearerTokenEnvVar: tr.bearerTokenEnvVar || "",
      targets: new Set(server.targets ?? []),
    };
    render();
  }

  async function applySingleServer(server) {
    state.applyingServerIds.add(server.id);
    render();
    try {
      const res = await api.backend.invoke("servers/apply-single", { id: server.id });
      state.overview = res.overview;
      if (res.errorCount > 0) {
        showToast(t("syncPartialErr", { count: res.errorCount }), true);
      } else {
        showToast(t("syncDone", { count: res.updatedCount }));
      }
      if (state.tab === "project-backups") await refreshBackups();
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), true);
    } finally {
      state.applyingServerIds.delete(server.id);
      render();
    }
  }

  async function revertSingleServer(server) {
    try {
      state.overview = await api.backend.invoke("servers/revert-single", { id: server.id });
      showToast(t("toastReverted", { name: server.name }));
      render();
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), true);
    }
  }

  async function probeServer(server) {
    state.probingIds.add(server.id);
    render();
    try {
      const res = await api.backend.invoke("servers/probe", { id: server.id });
      state.probes[server.id] = res;
    } catch (err) {
      state.probes[server.id] = {
        ok: false,
        kind: server.transport?.type || "http",
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      state.probingIds.delete(server.id);
      render();
    }
  }

  async function copyServerJson(server) {
    const json = toStandardMcpJson(server);
    try {
      await navigator.clipboard.writeText(json);
      showToast(`${t("btnCopied")}: ${server.name}`);
    } catch {
      showToast(json);
    }
  }

  function renderHeader() {
    const serverCount = (state.overview?.servers ?? []).length;
    return el("div", { className: "mh-header" }, [
      el("div", { className: "mh-title-wrap" }, [
        el("h1", { text: t("appTitle") }),
        el("p", { className: "mh-subtitle", text: t("appSubtitle") }),
      ]),
      el("div", { className: "mh-actions" }, [
        el("button", {
          className: "mh-btn mh-btn-primary",
          disabled: state.loading || serverCount === 0,
          text: t("btnBatchConfig"),
          onClick: () => openBatchWizard(),
        }),
        el("button", {
          className: "mh-btn mh-btn-soft",
          text: t("btnAddUnified"),
          onClick: () => openUnifiedAddModal("json"),
        }),
      ]),
    ]);
  }

  function renderTabs() {
    const serverCount = (state.overview?.servers ?? []).length;
    const managedCount = managedTargets().length;
    const tabs = [
      ["servers", t("tabServers"), serverCount],
      ["targets", t("tabTargets"), managedCount],
      ["project-backups", t("tabProjectBackups"), null],
    ];
    return el("div", { className: "mh-nav-bar" }, [
      el(
        "div",
        { className: "mh-seg-tabs", role: "tablist" },
        tabs.map(([id, label, count]) =>
          el(
            "button",
            {
              className: `mh-seg-tab ${state.tab === id ? "is-active" : ""}`,
              onClick: () => {
                state.tab = id;
                if (id === "project-backups") void refreshBackups();
                render();
              },
            },
            [
              el("span", { text: label }),
              count !== null ? el("span", { className: "mh-seg-count", text: String(count) }) : null,
            ],
          ),
        ),
      ),
    ]);
  }

  const ctx = {
    state,
    api,
    t,
    render,
    showToast,
    sortedTargets,
    managedTargets,
    openUnifiedAddModal,
    openServerEditor,
    applySingleServer,
    revertSingleServer,
    probeServer,
    copyServerJson,
  };

  function captureFocusState() {
    const active = root.activeElement || document.activeElement;
    const key = active?.getAttribute?.("data-keep-focus");
    if (!key) return null;
    return {
      key,
      start: typeof active.selectionStart === "number" ? active.selectionStart : null,
      end: typeof active.selectionEnd === "number" ? active.selectionEnd : null,
    };
  }

  function restoreFocusState(focusInfo) {
    if (!focusInfo) return;
    const target = rootEl.querySelector(`[data-keep-focus="${focusInfo.key}"]`);
    if (!target) return;
    target.focus({ preventScroll: true });
    if (focusInfo.start !== null && focusInfo.end !== null && typeof target.setSelectionRange === "function") {
      try {
        target.setSelectionRange(focusInfo.start, focusInfo.end);
      } catch {
        // Ignore input types that reject setSelectionRange
      }
    }
  }

  function render() {
    if (api.signal.aborted) return;
    const focusInfo = captureFocusState();

    let bodyContent;
    if (state.tab === "servers") bodyContent = renderServersTab(ctx);
    else if (state.tab === "targets") bodyContent = renderTargetsTab(ctx);
    else bodyContent = renderProjectAndBackupsTab(ctx);

    const shell = el("div", { className: "mh-shell" }, [
      renderHeader(),
      renderTabs(),
      bodyContent,
    ]);

    const modalEl = renderModal(ctx);
    rootEl.replaceChildren(...(modalEl ? [shell, modalEl] : [shell]));
    toastContainer = null;
    renderToasts();
    restoreFocusState(focusInfo);
  }

  render();
  await refreshOverview(false);

  return () => {
    unsubLocale();
    unsubTheme();
    root.replaceChildren();
  };
}
