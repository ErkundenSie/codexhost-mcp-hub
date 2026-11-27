/**
 * Cross-platform MCP Hub settings page (`manifestVersion: 2` `page` entry).
 *
 * Orchestrates shared page state, header/segmented navigation, modal lifecycle (including Escape close),
 * focus-preserving re-renders, and toast notifications across modular tabs.
 */

import { createTranslator } from "../shared/i18n.mjs";
import { toStandardMcpJson } from "../shared/models.mjs";
import { el, formatKvLines, svgEl } from "./dom.mjs";
import { renderModal } from "./modals.mjs";
import { renderAutoSyncTab } from "./tabs/autosync.mjs";
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
    editingTargetPathId: null,
    showCustomTargetForm: false,
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
    expandedToolIds: new Set(),
    activeVariantByName: {},
    oauthStartingIds: new Set(),
    oauthBusyIds: new Set(),
    oauthPendingById: {},
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

  const oauthPollTimers = new Map();

  function stopOAuthPolling(serverId) {
    const timer = oauthPollTimers.get(serverId);
    if (timer) {
      clearInterval(timer);
      oauthPollTimers.delete(serverId);
    }
  }

  function ensureOAuthPolling(serverId, serverName) {
    if (oauthPollTimers.has(serverId)) return;
    let inFlight = false;
    const timer = setInterval(async () => {
      if (api.signal.aborted || inFlight) return;
      if (!state.oauthPendingById[serverId]) {
        stopOAuthPolling(serverId);
        return;
      }
      inFlight = true;
      try {
        const res = await api.backend.invoke("oauth/status", { id: serverId });
        const status = res?.pending?.status;
        if (status === "completed") {
          stopOAuthPolling(serverId);
          delete state.oauthPendingById[serverId];
          showToast(t("oauthToastSuccess", { name: serverName }));
          await refreshOverview(true);
          const fresh = (state.overview?.servers ?? []).find((s) => s.id === serverId);
          if (fresh) {
            openOAuthSyncModal(fresh, true);
            void probeServer(fresh);
          }
          return;
        }
        if (status === "error") {
          stopOAuthPolling(serverId);
          delete state.oauthPendingById[serverId];
          showToast(
            t("oauthToastFailed", {
              name: serverName,
              error: res.pending.error || "Unknown error",
            }),
            true,
          );
          render();
          return;
        }
        if (status === "idle") {
          stopOAuthPolling(serverId);
          delete state.oauthPendingById[serverId];
          render();
          return;
        }
        // Still pending — re-render so countdown ticks smoothly
        render();
      } catch {
        // Ignore transient poll errors
      } finally {
        inFlight = false;
      }
    }, 1200);
    oauthPollTimers.set(serverId, timer);
  }

  function hydratePendingOAuth(overview) {
    const oauthOn = Boolean(overview?.features?.oauthEnabled);
    if (!oauthOn) {
      for (const id of [...oauthPollTimers.keys()]) stopOAuthPolling(id);
      state.oauthPendingById = {};
      return;
    }
    const activeIds = new Set();
    for (const srv of overview?.servers ?? []) {
      if (srv.oauthPending && srv.oauthPending.status === "pending") {
        activeIds.add(srv.id);
        state.oauthPendingById[srv.id] = srv.oauthPending;
        ensureOAuthPolling(srv.id, srv.name);
      }
    }
    for (const id of Object.keys(state.oauthPendingById)) {
      if (!activeIds.has(id)) {
        stopOAuthPolling(id);
        delete state.oauthPendingById[id];
      }
    }
  }

  let authHintProbeInFlight = false;

  async function maybeProbeUncheckedAuthHints(overview) {
    if (api.signal.aborted || authHintProbeInFlight) return;
    if (!overview?.features?.oauthEnabled) return;
    const hasUnchecked = (overview.servers ?? []).some((s) => s.needsAuthCheck);
    if (!hasUnchecked) return;
    authHintProbeInFlight = true;
    try {
      const res = await api.backend.invoke("oauth/probe-auth-hints");
      if (api.signal.aborted) return;
      if (res?.overview) {
        state.overview = res.overview;
        hydratePendingOAuth(state.overview);
        render();
      }
    } catch {
      // Ignore silent background discovery errors
    } finally {
      authHintProbeInFlight = false;
    }
  }

  async function refreshOverview(silent = false) {
    if (!silent) {
      state.loading = true;
      render();
    }
    try {
      state.overview = await api.backend.invoke("overview");
      hydratePendingOAuth(state.overview);
      void maybeProbeUncheckedAuthHints(state.overview);
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
      isClone: false,
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

  function openCloneServerModal(server) {
    const tr = server?.transport ?? { type: "stdio", command: "", args: [], env: {} };
    const oauthFeatureOn = Boolean(state.overview?.features?.oauthEnabled);
    const isUrlTransport = tr.type === "http" || tr.type === "sse";
    const isAccountMode = Boolean(oauthFeatureOn && isUrlTransport);
    const existingAliases = new Set(
      (state.overview?.servers ?? [])
        .filter((s) => s.name === server.name)
        .map((s) => (s.alias || "").trim()),
    );
    const isZh = state.locale.toLowerCase().startsWith("zh");
    const prefix = isAccountMode
      ? isZh
        ? "账号 "
        : "Account "
      : isZh
        ? "配置 "
        : "Config ";
    let idx = 2;
    let suggestedAlias = `${prefix}${idx}`;
    while (existingAliases.has(suggestedAlias)) {
      idx++;
      suggestedAlias = `${prefix}${idx}`;
    }
    // Strip OAuth-managed Authorization header so the cloned variant starts clean for a separate account
    const clonedHeaders = { ...(tr.headers ?? {}) };
    if (isAccountMode && (server.oauthHeaderManaged || server.oauth?.authenticated)) {
      for (const k of Object.keys(clonedHeaders)) {
        if (k.toLowerCase() === "authorization") delete clonedHeaders[k];
      }
    }
    state.modal = {
      type: "edit-server",
      isClone: true,
      isAccountMode,
      cloneAuthMode: isAccountMode ? "oauth" : "config",
      id: null,
      name: server.name ?? "",
      alias: suggestedAlias,
      description: server.description ?? "",
      enabled: true,
      transportType: tr.type || "stdio",
      command: tr.command || "",
      argsText: (tr.args ?? []).join("\n"),
      cwd: tr.cwd || "",
      envText: formatKvLines(tr.env, "="),
      url: tr.url || "",
      headersText: formatKvLines(clonedHeaders, ": "),
      bearerTokenEnvVar: tr.bearerTokenEnvVar || "",
      targets: new Set(),
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
      if (Array.isArray(res?.tools) && res.tools.length > 0) {
        state.expandedToolIds.add(server.id);
      }
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

  async function startOAuthLogin(server) {
    state.oauthStartingIds.add(server.id);
    render();
    try {
      const res = await api.backend.invoke("oauth/start", { id: server.id });
      state.oauthPendingById[server.id] = {
        status: "pending",
        sessionId: res.sessionId,
        authUrl: res.authUrl,
        redirectUri: res.redirectUri,
        expiresAt: res.expiresAt,
      };
      ensureOAuthPolling(server.id, server.name);
      showToast(t("oauthToastStarted", { name: server.name }));
      try {
        window.open(res.authUrl, "_blank", "noopener,noreferrer");
      } catch {
        // Fallback link button is always shown in the waiting bar
      }
    } catch (err) {
      showToast(
        t("oauthToastFailed", {
          name: server.name,
          error: err instanceof Error ? err.message : String(err),
        }),
        true,
      );
    } finally {
      state.oauthStartingIds.delete(server.id);
      render();
    }
  }

  async function cancelOAuthLogin(server) {
    stopOAuthPolling(server.id);
    delete state.oauthPendingById[server.id];
    render();
    try {
      await api.backend.invoke("oauth/cancel", { id: server.id });
      showToast(t("oauthToastCancelled", { name: server.name }));
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), true);
    }
  }

  async function refreshOAuthToken(server) {
    state.oauthBusyIds.add(server.id);
    render();
    try {
      const res = await api.backend.invoke("oauth/refresh", { id: server.id });
      if (res?.overview) {
        state.overview = res.overview;
        hydratePendingOAuth(state.overview);
      }
      showToast(
        res?.updatedTargets > 0
          ? t("oauthToastRefreshedSynced", { name: server.name, count: res.updatedTargets })
          : t("oauthToastRefreshed", { name: server.name }),
      );
      const fresh = (state.overview?.servers ?? []).find((s) => s.id === server.id) || server;
      void probeServer(fresh);
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), true);
    } finally {
      state.oauthBusyIds.delete(server.id);
      render();
    }
  }

  async function logoutOAuth(server) {
    state.oauthBusyIds.add(server.id);
    render();
    try {
      stopOAuthPolling(server.id);
      delete state.oauthPendingById[server.id];
      state.overview = await api.backend.invoke("oauth/logout", { id: server.id });
      hydratePendingOAuth(state.overview);
      if (state.probes[server.id]?.usedOAuth) {
        delete state.probes[server.id];
      }
      showToast(t("oauthToastLoggedOut", { name: server.name }));
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), true);
    } finally {
      state.oauthBusyIds.delete(server.id);
      render();
    }
  }

  function openOAuthConfirmModal(server) {
    state.modal = {
      type: "oauth-confirm",
      server,
      serverName: server.alias ? `${server.name}（${server.alias}）` : server.name,
    };
    render();
  }

  function openOAuthSyncModal(server, fromLogin = false) {
    const managedIds = new Set(managedTargetIds());
    const initialTargets = (server.targets ?? []).filter((id) => managedIds.has(id));
    state.modal = {
      type: "oauth-sync",
      fromLogin,
      serverId: server.id,
      serverName: server.alias ? `${server.name}（${server.alias}）` : server.name,
      hasRefreshToken: Boolean(server.oauth?.hasRefreshToken),
      targets: new Set(initialTargets),
    };
    render();
  }

  async function applyOAuthHeaderToTargets(serverId, serverDisplayName, targetIds) {
    state.syncing = true;
    state.oauthBusyIds.add(serverId);
    render();
    try {
      await api.backend.invoke("servers/set-targets", {
        id: serverId,
        targets: [...targetIds],
        autoEnable: true,
      });
      await api.backend.invoke("oauth/apply-header", { id: serverId });
      const res = await api.backend.invoke("servers/apply-single", { id: serverId });
      state.overview = res.overview;
      hydratePendingOAuth(state.overview);
      state.modal = null;
      if (res.errorCount > 0) {
        showToast(t("syncPartialErr", { count: res.errorCount }), true);
      } else {
        showToast(
          t("oauthToastHeaderApplied", {
            name: serverDisplayName,
            count: res.updatedCount || targetIds.length,
          }),
        );
      }
      if (state.tab === "project-backups") await refreshBackups();
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), true);
    } finally {
      state.syncing = false;
      state.oauthBusyIds.delete(serverId);
      render();
    }
  }

  async function copyOAuthLink(url) {
    try {
      await navigator.clipboard.writeText(url);
      showToast(t("oauthToastLinkCopied"));
    } catch {
      showToast(url);
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

  function makePlusIcon() {
    return svgEl(
      "svg",
      {
        width: 14,
        height: 14,
        viewBox: "0 0 24 24",
        fill: "none",
        stroke: "currentColor",
        "stroke-width": 2.2,
        "stroke-linecap": "round",
        "stroke-linejoin": "round",
        "aria-hidden": "true",
      },
      [svgEl("path", { d: "M12 5v14" }), svgEl("path", { d: "M5 12h14" })],
    );
  }

  function makeBoltIcon() {
    return svgEl(
      "svg",
      {
        width: 14,
        height: 14,
        viewBox: "0 0 24 24",
        fill: "none",
        stroke: "currentColor",
        "stroke-width": 2.1,
        "stroke-linecap": "round",
        "stroke-linejoin": "round",
        "aria-hidden": "true",
      },
      [svgEl("polygon", { points: "13 2 3 14 12 14 11 22 21 10 12 10 13 2" })],
    );
  }

  function renderHeader() {
    const serverCount = (state.overview?.servers ?? []).length;
    const addLabel = t("btnAddUnified").replace(/^\+\s*/, "");
    return el("div", { className: "mh-header" }, [
      el("div", { className: "mh-title-wrap" }, [
        el("h1", { text: t("appTitle") }),
        el("p", { className: "mh-subtitle", text: t("appSubtitle") }),
      ]),
      el("div", { className: "mh-actions" }, [
        el(
          "button",
          {
            className: "mh-btn mh-btn-primary",
            disabled: state.loading || serverCount === 0,
            onClick: () => openBatchWizard(),
          },
          [makeBoltIcon(), el("span", { text: t("btnBatchConfig") })],
        ),
        el(
          "button",
          {
            className: "mh-btn mh-btn-soft",
            onClick: () => openUnifiedAddModal("json"),
          },
          [makePlusIcon(), el("span", { text: addLabel })],
        ),
      ]),
    ]);
  }

  function renderTabs() {
    const serverCount = (state.overview?.servers ?? []).length;
    const managedCount = managedTargets().length;
    const autoSyncFeatureOn = state.overview?.features?.autoSyncEnabled !== false;
    const autoSyncOn = autoSyncFeatureOn && Boolean(state.overview?.autoSync?.enabled);
    const tabs = [
      ["servers", t("tabServers"), serverCount, false],
      ["targets", t("tabTargets"), managedCount, false],
      ["autosync", t("tabAutoSync"), null, autoSyncOn],
      ["project-backups", t("tabProjectBackups"), null, false],
    ];
    return el("div", { className: "mh-nav-bar" }, [
      el(
        "div",
        { className: "mh-seg-tabs", role: "tablist" },
        tabs.map(([id, label, count, showLiveDot]) =>
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
              showLiveDot ? el("span", { className: "mh-live-dot" }) : null,
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
    openCloneServerModal,
    applySingleServer,
    revertSingleServer,
    probeServer,
    startOAuthLogin,
    cancelOAuthLogin,
    refreshOAuthToken,
    logoutOAuth,
    openOAuthConfirmModal,
    openOAuthSyncModal,
    applyOAuthHeaderToTargets,
    maybeProbeUncheckedAuthHints,
    copyOAuthLink,
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
    else if (state.tab === "autosync") bodyContent = renderAutoSyncTab(ctx);
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

  // Zero-I/O revision heartbeat so background auto-sync updates reflect automatically in UI
  let pollInFlight = false;
  const pollTimer = setInterval(async () => {
    if (api.signal.aborted || pollInFlight || state.loading || state.syncing || state.modal || state.searchComposing) {
      return;
    }
    const knownRev = state.overview?.revision ?? 0;
    if (!knownRev) return;
    pollInFlight = true;
    try {
      const res = await api.backend.invoke("overview/revision");
      if (res && typeof res.revision === "number" && res.revision !== knownRev) {
        await refreshOverview(true);
      }
    } catch {
      // Ignore transient poll errors
    } finally {
      pollInFlight = false;
    }
  }, 2500);
  api.signal.addEventListener("abort", () => clearInterval(pollTimer), { once: true });

  render();
  await refreshOverview(false);

  return () => {
    clearInterval(pollTimer);
    for (const id of [...oauthPollTimers.keys()]) stopOAuthPolling(id);
    unsubLocale();
    unsubTheme();
    root.replaceChildren();
  };
}
