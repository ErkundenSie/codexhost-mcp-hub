/**
 * CodexHost single-instance Node backend for MCP Hub (`manifestVersion: 2`).
 *
 * Exports `activate(ctx)` and registers all RPC methods invoked by `page` and `widget`.
 */

import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import {
  detectBuiltinMcp,
  isCodexhostLoopbackServer,
  normalizeServerName,
  normalizeTransport,
  parseMcpJsonInput,
  transportSignature,
} from "../shared/models.mjs";
import {
  applyTargetMutations,
  getBuiltinTargets,
  getProjectTargetDescriptors,
  readTargetConfig,
} from "./adapters.mjs";
import { probeMcpServer } from "./probe.mjs";
import { HubStore, normalizeAutoSyncConfig } from "./store.mjs";
import { McpFileWatcher } from "./watcher.mjs";

const MAX_AUTOSYNC_LOGS = 40;

export function createHubController({
  dataDir,
  readSettings,
  home = os.homedir(),
  platform = process.platform,
  watchDebounceMs = 750,
}) {
  const store = new HubStore(dataDir);
  let mutex = Promise.resolve();
  const serialize = (fn) => {
    const next = mutex.then(fn, fn);
    mutex = next.then(() => undefined, () => undefined);
    return next;
  };

  let revision = 1;
  /** @type {Map<string, Map<string, { sig: string, enabled: boolean, transport: object }>>} */
  const baselineByTarget = new Map();
  /** @type {Array<object>} */
  let autoSyncLogs = [];

  const watcher = new McpFileWatcher({
    debounceMs: watchDebounceMs,
    onTargetChanged: (targetId) => handleWatchedTargetChange(targetId),
  });

  function pushAutoSyncLog(entry) {
    autoSyncLogs = [
      {
        id: randomUUID().slice(0, 8),
        at: new Date().toISOString(),
        ...entry,
      },
      ...autoSyncLogs,
    ].slice(0, MAX_AUTOSYNC_LOGS);
  }

  function makeNativeSnapshot(serversMap) {
    const snap = new Map();
    for (const [name, srv] of Object.entries(serversMap ?? {})) {
      if (!srv || !srv.transport) continue;
      snap.set(name, {
        sig: transportSignature(srv.transport),
        enabled: srv.enabled !== false,
        transport: srv.transport,
        isBuiltin: detectBuiltinMcp(name, srv.transport).isBuiltin,
        isLoopback: isCodexhostLoopbackServer(name, srv.transport),
      });
    }
    return snap;
  }

  function resolveAutoSyncView(state, scannedTargets) {
    const cfg = normalizeAutoSyncConfig(state.autoSync);
    const activeIds = scannedTargets.filter((t) => t.enabled).map((t) => t.id);
    const activeSet = new Set(activeIds);
    const targetIds =
      cfg.targetIds === null
        ? activeIds
        : cfg.targetIds.filter((id) => activeSet.has(id));
    const primaryTargetId =
      cfg.primaryTargetId && activeSet.has(cfg.primaryTargetId)
        ? cfg.primaryTargetId
        : targetIds[0] || activeIds[0] || "";
    return {
      ...cfg,
      targetIds,
      primaryTargetId,
      watchingCount: cfg.enabled ? watcher.dirWatchers.size : 0,
    };
  }

  async function refreshBaselineForTarget(target) {
    const fresh = await readTargetConfig(target);
    if (!fresh.error) {
      baselineByTarget.set(target.id, makeNativeSnapshot(fresh.servers));
    }
  }

  async function writeTargetSafe(target, upserts, removals) {
    watcher.markSelfWrite(target.id, 1800);
    const res = await applyTargetMutations(target, upserts, removals);
    await refreshBaselineForTarget(target);
    watcher.markSelfWrite(target.id, 1800);
    revision++;
    return res;
  }

  async function syncWatchers(state, scannedTargets) {
    const cfg = resolveAutoSyncView(state, scannedTargets);
    if (!cfg.enabled) {
      watcher.stopAll();
      return;
    }
    const watchSet = new Set(cfg.targetIds);
    if (cfg.mode === "primary" && cfg.primaryTargetId) {
      watchSet.add(cfg.primaryTargetId);
    }
    const toWatch = scannedTargets.filter((t) => watchSet.has(t.id));
    for (const tg of toWatch) {
      if (!baselineByTarget.has(tg.id)) {
        const byName = Object.fromEntries((tg.nativeServers ?? []).map((ns) => [ns.name, ns]));
        baselineByTarget.set(tg.id, makeNativeSnapshot(byName));
      }
    }
    watcher.setTargets(toWatch);
  }

  function resolveTargets(state) {
    const builtins = getBuiltinTargets(home, platform).map((t) => ({
      ...t,
      custom: false,
      configPath: state.targetPathOverrides[t.id] || t.defaultPath,
      overridden: Boolean(state.targetPathOverrides[t.id]),
    }));
    const customs = (state.customTargets ?? []).map((c) => ({
      id: c.id,
      name: c.name,
      shortName: c.name,
      format: "standard-json",
      rootKey: c.rootKey || "mcpServers",
      defaultPath: c.configPath,
      configPath: c.configPath,
      custom: true,
      overridden: false,
      detectFiles: [c.configPath],
    }));
    return [...builtins, ...customs];
  }

  function resolveEnabledTargetSet(_state, scanned) {
    // Whatever is detected locally (or custom/path-overridden) is automatically active.
    return new Set(
      scanned.filter((t) => t.exists || t.detected || t.custom || t.overridden).map((t) => t.id),
    );
  }

  async function backupTargetIfNeeded(target, autoBackup, targetNameOverride) {
    if (!autoBackup) return;
    const fresh = await readTargetConfig(target);
    if (fresh.exists && fresh.rawText) {
      await store.createBackup({
        targetId: target.id,
        targetName: targetNameOverride || target.name,
        configPath: target.configPath,
        content: fresh.rawText,
      });
    }
  }

  async function scanTargets(state) {
    const targets = resolveTargets(state);
    const scanned = await Promise.all(
      targets.map(async (target) => {
        const result = await readTargetConfig(target);
        const managedKeys = state.managedKeysByTarget[target.id] ?? [];
        const nativeList = Object.values(result.servers).map((s) => {
          const builtin = detectBuiltinMcp(s.name, s.transport);
          return {
            ...s,
            managed: managedKeys.includes(s.name),
            isLoopback: isCodexhostLoopbackServer(s.name, s.transport),
            isBuiltin: builtin.isBuiltin,
            builtinVendor: builtin.vendor,
            builtinOwnerTargetId: builtin.ownerTargetId,
          };
        });
        return {
          id: target.id,
          name: target.name,
          shortName: target.shortName || target.name,
          format: target.format,
          rootKey: target.rootKey,
          defaultPath: target.defaultPath,
          configPath: target.configPath,
          custom: target.custom,
          overridden: target.overridden,
          exists: result.exists,
          detected: result.detected,
          error: result.error,
          nativeCount: nativeList.length,
          nativeServers: nativeList,
          managedKeys,
        };
      }),
    );
    const enabledSet = resolveEnabledTargetSet(state, scanned);
    return scanned.map((t) => ({
      ...t,
      enabled: enabledSet.has(t.id),
    }));
  }

  function computeTargetDiff(state, targetScan, includeDisabled = false) {
    const desired = {};
    if (targetScan.enabled || includeDisabled) {
      for (const server of state.servers) {
        if (!server.enabled) continue;
        if (Array.isArray(server.targets) && server.targets.includes(targetScan.id)) {
          desired[server.name] = server;
        }
      }
    }

    const nativeByName = new Map(targetScan.nativeServers.map((s) => [s.name, s]));
    const previouslyManaged = new Set(state.managedKeysByTarget[targetScan.id] ?? []);

    const adds = [];
    const updates = [];
    const removes = [];
    const unchanged = [];
    const preservedUnmanaged = [];

    if (targetScan.enabled || includeDisabled) {
      for (const [name, server] of Object.entries(desired)) {
        const existing = nativeByName.get(name);
        if (!existing) {
          adds.push(name);
        } else if (
          transportSignature(existing.transport) !== transportSignature(server.transport) ||
          existing.enabled === false
        ) {
          updates.push(name);
        } else {
          unchanged.push(name);
        }
      }

      for (const managedName of previouslyManaged) {
        if (!desired[managedName] && nativeByName.has(managedName)) {
          const native = nativeByName.get(managedName);
          // Never delete a vendor built-in MCP (e.g. Codex node_repl) from its native owner AI
          if (
            native?.isBuiltin &&
            (!native.builtinOwnerTargetId || native.builtinOwnerTargetId === targetScan.id)
          ) {
            preservedUnmanaged.push(managedName);
            continue;
          }
          removes.push(managedName);
        }
      }
    }

    for (const native of targetScan.nativeServers) {
      if (!desired[native.name] && !previouslyManaged.has(native.name)) {
        preservedUnmanaged.push(native.name);
      }
    }

    const hasChanges = adds.length > 0 || updates.length > 0 || removes.length > 0;
    return {
      targetId: targetScan.id,
      targetName: targetScan.name,
      configPath: targetScan.configPath,
      format: targetScan.format,
      exists: targetScan.exists,
      detected: targetScan.detected,
      enabled: targetScan.enabled,
      error: targetScan.error,
      adds,
      updates,
      removes,
      unchanged,
      preservedUnmanaged,
      hasChanges,
      desired,
    };
  }

  function getManagedOwnerId(state, targetId, serverName) {
    const explicit = state.managedOwnersByTarget?.[targetId]?.[serverName];
    if (explicit) return explicit;
    if ((state.managedKeysByTarget?.[targetId] ?? []).includes(serverName)) {
      const matching = state.servers.filter((s) => s.name === serverName);
      if (matching.length === 1) return matching[0].id;
    }
    return null;
  }

  function setManagedOwner(state, targetId, serverName, serverId) {
    state.managedOwnersByTarget ??= {};
    state.managedOwnersByTarget[targetId] ??= {};
    state.managedOwnersByTarget[targetId][serverName] = serverId;
    const set = new Set(state.managedKeysByTarget[targetId] ?? []);
    set.add(serverName);
    state.managedKeysByTarget[targetId] = [...set];
  }

  function clearManagedOwner(state, targetId, serverName) {
    if (state.managedOwnersByTarget?.[targetId]) {
      delete state.managedOwnersByTarget[targetId][serverName];
    }
    const set = new Set(state.managedKeysByTarget[targetId] ?? []);
    set.delete(serverName);
    state.managedKeysByTarget[targetId] = [...set];
  }

  function normalizeSingleVariantAlias(state, serverName) {
    const remaining = state.servers.filter((s) => s.name === serverName);
    if (remaining.length === 1 && remaining[0].alias && remaining[0].autoAlias !== false) {
      remaining[0].alias = "";
      remaining[0].autoAlias = false;
    }
  }

  function releaseSiblingTargetClaims(state, winnerServer, targetId) {
    const removedIds = new Set();
    for (const other of state.servers) {
      if (other.id === winnerServer.id || other.name !== winnerServer.name) continue;
      if (Array.isArray(other.targets) && other.targets.includes(targetId)) {
        other.targets = other.targets.filter((id) => id !== targetId);
        // If this same-name variant is no longer used by any AI after being overwritten, remove it
        if (other.targets.length === 0) {
          removedIds.add(other.id);
        }
      }
    }
    if (removedIds.size > 0) {
      state.servers = state.servers.filter((s) => !removedIds.has(s.id));
      normalizeSingleVariantAlias(state, winnerServer.name);
    }
  }

  function buildImportCandidates(state, targets) {
    const hubVariantKeys = new Set(
      state.servers.map((s) => `${s.name}\u0000${transportSignature(s.transport)}`),
    );
    const byVariant = new Map();
    const countByName = new Map();
    const excludedBuiltins = [];

    for (const tg of targets) {
      for (const ns of tg.nativeServers) {
        if (ns.isBuiltin) {
          excludedBuiltins.push({
            name: ns.name,
            vendor: ns.builtinVendor || tg.name,
            targetId: tg.id,
            targetName: tg.shortName || tg.name,
          });
          continue;
        }
        const sig = transportSignature(ns.transport);
        const variantKey = `${ns.name}\u0000${sig}`;
        const existing = byVariant.get(variantKey);
        if (existing) {
          if (!existing.presentIn.some((p) => p.targetId === tg.id)) {
            existing.presentIn.push({ targetId: tg.id, targetName: tg.shortName || tg.name });
          }
        } else {
          byVariant.set(variantKey, {
            variantKey,
            name: ns.name,
            transport: ns.transport,
            enabled: ns.enabled,
            isLoopback: ns.isLoopback,
            alreadyInHub: hubVariantKeys.has(variantKey),
            presentIn: [{ targetId: tg.id, targetName: tg.shortName || tg.name }],
          });
          countByName.set(ns.name, (countByName.get(ns.name) ?? 0) + 1);
        }
      }
    }

    const candidates = [...byVariant.values()].map((c) => {
      const hasVariants = (countByName.get(c.name) ?? 1) > 1;
      const suggestedAlias = hasVariants
        ? c.presentIn
            .slice(0, 2)
            .map((p) => p.targetName)
            .join("/")
        : "";
      return { ...c, hasVariants, suggestedAlias };
    });

    candidates.sort((a, b) => {
      if (a.alreadyInHub !== b.alreadyInHub) return a.alreadyInHub ? 1 : -1;
      const nameCmp = a.name.localeCompare(b.name);
      if (nameCmp !== 0) return nameCmp;
      return a.suggestedAlias.localeCompare(b.suggestedAlias);
    });
    return { candidates, excludedBuiltins };
  }

  async function buildOverview() {
    const state = await store.load();
    const targets = await scanTargets(state);
    const diffs = targets.map((t) => {
      const d = computeTargetDiff(state, t, false);
      const { desired: _omit, ...publicDiff } = d;
      return publicDiff;
    });

    const targetMap = new Map(targets.map((t) => [t.id, t]));
    const nativeLookupByTarget = new Map(
      targets.map((t) => [t.id, new Map(t.nativeServers.map((s) => [s.name, s]))]),
    );

    const enrichedServers = state.servers.map((s) => {
      const builtin = detectBuiltinMcp(s.name, s.transport);
      const targetStatuses = {};
      for (const tg of targets) {
        const native = nativeLookupByTarget.get(tg.id)?.get(s.name);
        const ownerId = getManagedOwnerId(state, tg.id, s.name);
        const selected = s.enabled && Array.isArray(s.targets) && s.targets.includes(tg.id);
        const siblingWantsTarget = state.servers.some(
          (other) =>
            other.id !== s.id &&
            other.name === s.name &&
            other.enabled &&
            Array.isArray(other.targets) &&
            other.targets.includes(tg.id),
        );
        if (selected) {
          if (!native) {
            targetStatuses[tg.id] = "pending-add";
          } else if (
            transportSignature(native.transport) !== transportSignature(s.transport) ||
            native.enabled === false
          ) {
            targetStatuses[tg.id] = "pending-update";
          } else {
            targetStatuses[tg.id] = "synced";
          }
        } else if (
          ownerId === s.id &&
          !siblingWantsTarget &&
          native &&
          tg.enabled &&
          !(native.isBuiltin && (!native.builtinOwnerTargetId || native.builtinOwnerTargetId === tg.id))
        ) {
          targetStatuses[tg.id] = "pending-remove";
        } else {
          targetStatuses[tg.id] = "off";
        }
      }
      return {
        ...s,
        alias: typeof s.alias === "string" ? s.alias : "",
        isLoopback: isCodexhostLoopbackServer(s.name, s.transport),
        isBuiltin: builtin.isBuiltin,
        builtinVendor: builtin.vendor,
        targetStatuses,
      };
    });

    const syncedCountOf = (srv) =>
      Object.values(srv.targetStatuses ?? {}).filter((st) => st === "synced").length;
    enrichedServers.sort((a, b) => {
      const nameCmp = a.name.toLowerCase().localeCompare(b.name.toLowerCase());
      if (nameCmp !== 0) return nameCmp;
      const syncDiff = syncedCountOf(b) - syncedCountOf(a);
      if (syncDiff !== 0) return syncDiff;
      if (!a.alias !== !b.alias) return !a.alias ? -1 : 1;
      return (a.alias || "").localeCompare(b.alias || "");
    });

    const pendingTargets = diffs.filter((d) => d.hasChanges).length;
    const pendingChanges = diffs.reduce(
      (sum, d) => sum + d.adds.length + d.updates.length + d.removes.length,
      0,
    );
    const { candidates: importCandidates, excludedBuiltins } = buildImportCandidates(state, targets);
    const autoSync = resolveAutoSyncView(state, targets);

    return {
      homeDir: home,
      platform,
      dataDir,
      revision,
      servers: enrichedServers,
      targets,
      diffs,
      importCandidates,
      excludedBuiltins,
      autoSync,
      autoSyncLogs,
      summary: {
        totalServers: state.servers.length,
        enabledServers: state.servers.filter((s) => s.enabled).length,
        detectedTargets: targets.filter((t) => t.detected).length,
        managedTargets: targets.filter((t) => t.enabled).length,
        pendingTargets,
        pendingChanges,
        newImportableCount: importCandidates.filter((c) => !c.alreadyInHub).length,
        lastSyncedAt: state.lastSyncedAt,
      },
      _hasTargetCount: targetMap.size,
    };
  }

  async function saveServer(input) {
    return serialize(async () => {
      const state = await store.load();
      const name = normalizeServerName(input?.name);
      const alias = typeof input?.alias === "string" ? input.alias.trim().slice(0, 64) : "";
      const transport = normalizeTransport(input?.transport ?? input);
      const targets = Array.isArray(input?.targets)
        ? [...new Set(input.targets.map((x) => String(x).trim()).filter(Boolean))]
        : [];
      const description = typeof input?.description === "string" ? input.description.trim() : "";
      const enabled = input?.enabled !== false;
      const now = new Date().toISOString();

      const existingIdx = input?.id
        ? state.servers.findIndex((s) => s.id === input.id)
        : state.servers.findIndex((s) => s.name === name && (s.alias || "") === alias);

      const duplicateIdx = state.servers.findIndex(
        (s, idx) => s.name === name && (s.alias || "") === alias && idx !== existingIdx,
      );
      if (duplicateIdx !== -1) {
        throw new Error(
          alias
            ? `An MCP server named "${name}" (${alias}) already exists`
            : `An MCP server named "${name}" already exists (set an Alias to keep multiple configs for the same name)`,
        );
      }

      if (existingIdx >= 0) {
        const prev = state.servers[existingIdx];
        const aliasChanged = alias !== (prev.alias ?? "");
        state.servers[existingIdx] = {
          ...prev,
          name,
          alias,
          autoAlias: aliasChanged ? false : Boolean(prev.autoAlias),
          description,
          enabled,
          transport,
          targets,
          isLoopback: isCodexhostLoopbackServer(name, transport),
          updatedAt: now,
        };
      } else {
        state.servers.push({
          id: randomUUID(),
          name,
          alias,
          autoAlias: false,
          description,
          enabled,
          transport,
          targets,
          isLoopback: isCodexhostLoopbackServer(name, transport),
          createdAt: now,
          updatedAt: now,
        });
      }

      await store.save(state);
      return buildOverview();
    });
  }

  async function deleteServer({ id }) {
    return serialize(async () => {
      const state = await store.load();
      const target = state.servers.find((s) => s.id === id);
      if (!target) {
        throw new Error("Server not found");
      }
      state.servers = state.servers.filter((s) => s.id !== id);
      normalizeSingleVariantAlias(state, target.name);
      await store.save(state);
      return buildOverview();
    });
  }

  async function toggleServer({ id, enabled }) {
    return serialize(async () => {
      const state = await store.load();
      const server = state.servers.find((s) => s.id === id);
      if (!server) throw new Error("Server not found");
      server.enabled = typeof enabled === "boolean" ? enabled : !server.enabled;
      server.updatedAt = new Date().toISOString();
      await store.save(state);
      return buildOverview();
    });
  }

  async function setServerTargets({ id, targets, autoEnable = true }) {
    return serialize(async () => {
      const state = await store.load();
      const server = state.servers.find((s) => s.id === id);
      if (!server) throw new Error("Server not found");
      const nextTargets = Array.isArray(targets)
        ? [...new Set(targets.map((x) => String(x).trim()).filter(Boolean))]
        : [];
      server.targets = nextTargets;
      if (autoEnable && nextTargets.length > 0 && !server.enabled) {
        server.enabled = true;
      }
      server.updatedAt = new Date().toISOString();
      await store.save(state);
      return buildOverview();
    });
  }

  async function applySingleServer({ id }) {
    return serialize(async () => {
      const state = await store.load();
      const server = state.servers.find((s) => s.id === id);
      if (!server) throw new Error("Server not found");
      const settings = await readSettings();
      const autoBackup = settings.autoBackup !== false;
      const targets = resolveTargets(state);
      const scanned = await scanTargets(state);
      const scanById = new Map(scanned.map((s) => [s.id, s]));

      const results = [];
      let updatedCount = 0;

      for (const target of targets) {
        const targetScan = scanById.get(target.id);
        if (!targetScan || !targetScan.enabled) continue;

        const native = targetScan.nativeServers.find((ns) => ns.name === server.name);
        const ownerId = getManagedOwnerId(state, target.id, server.name);
        const desired = server.enabled && Array.isArray(server.targets) && server.targets.includes(target.id);
        const siblingWantsTarget = state.servers.some(
          (other) =>
            other.id !== server.id &&
            other.name === server.name &&
            other.enabled &&
            Array.isArray(other.targets) &&
            other.targets.includes(target.id),
        );

        let action = "unchanged";
        if (desired) {
          if (!native) action = "add";
          else if (
            transportSignature(native.transport) !== transportSignature(server.transport) ||
            native.enabled === false
          ) {
            action = "update";
          }
        } else if (
          ownerId === server.id &&
          !siblingWantsTarget &&
          native &&
          !(native.isBuiltin && (!native.builtinOwnerTargetId || native.builtinOwnerTargetId === target.id))
        ) {
          action = "remove";
        }

        if (action === "unchanged") continue;
        if (targetScan.error) {
          results.push({ targetId: target.id, targetName: target.name, status: "error", error: targetScan.error });
          continue;
        }

        try {
          if (targetScan.exists) {
            await backupTargetIfNeeded(target, autoBackup);
          }

          if (action === "remove") {
            await writeTargetSafe(target, {}, [server.name]);
            clearManagedOwner(state, target.id, server.name);
          } else {
            await writeTargetSafe(target, { [server.name]: server }, []);
            releaseSiblingTargetClaims(state, server, target.id);
            setManagedOwner(state, target.id, server.name, server.id);
          }
          updatedCount++;
          results.push({ targetId: target.id, targetName: target.name, status: "updated", action });
        } catch (err) {
          results.push({
            targetId: target.id,
            targetName: target.name,
            status: "error",
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      if (updatedCount > 0) state.lastSyncedAt = new Date().toISOString();
      await store.save(state);
      return {
        updatedCount,
        errorCount: results.filter((r) => r.status === "error").length,
        results,
        overview: await buildOverview(),
      };
    });
  }

  async function revertSingleServer({ id }) {
    return serialize(async () => {
      const state = await store.load();
      const server = state.servers.find((s) => s.id === id);
      if (!server) throw new Error("Server not found");
      const scanned = await scanTargets(state);
      const syncedIds = [];
      for (const tg of scanned) {
        if (!tg.enabled) continue;
        const native = tg.nativeServers.find((ns) => ns.name === server.name);
        if (
          native &&
          native.enabled !== false &&
          transportSignature(native.transport) === transportSignature(server.transport)
        ) {
          syncedIds.push(tg.id);
        }
      }
      server.targets = syncedIds;
      if (syncedIds.length > 0) server.enabled = true;
      server.updatedAt = new Date().toISOString();
      await store.save(state);
      return buildOverview();
    });
  }

  async function batchApplyTargets({ ids, targetIds, mode = "add", skipExisting = true }) {
    return serialize(async () => {
      const state = await store.load();
      const idSet = new Set(Array.isArray(ids) ? ids.map(String) : []);
      const cleanTargets = Array.isArray(targetIds)
        ? [...new Set(targetIds.map((x) => String(x).trim()).filter(Boolean))]
        : [];
      if (idSet.size === 0) throw new Error("No MCP servers selected");
      if (cleanTargets.length === 0) throw new Error("No target AIs selected");

      const selectedServers = state.servers.filter((s) => idSet.has(s.id));
      const settings = await readSettings();
      const autoBackup = settings.autoBackup !== false;
      const targets = resolveTargets(state);
      const scanned = await scanTargets(state);
      const scanById = new Map(scanned.map((s) => [s.id, s]));
      const targetIdSet = new Set(cleanTargets);

      const now = new Date().toISOString();
      const results = [];
      let updatedCount = 0;
      let skippedCount = 0;

      for (const target of targets) {
        if (!targetIdSet.has(target.id)) continue;
        const targetScan = scanById.get(target.id);
        if (!targetScan) continue;

        const nativeByName = new Map(targetScan.nativeServers.map((ns) => [ns.name, ns]));
        const upserts = {};
        const removals = [];

        for (const server of selectedServers) {
          const native = nativeByName.get(server.name);
          const currentTargets = new Set(Array.isArray(server.targets) ? server.targets : []);

          if (mode === "add") {
            if (native) {
              const sameConfig =
                native.enabled !== false &&
                transportSignature(native.transport) === transportSignature(server.transport);
              if (sameConfig) {
                currentTargets.add(target.id);
                server.targets = [...currentTargets];
                server.enabled = true;
                server.updatedAt = now;
                continue;
              }
              if (skipExisting) {
                skippedCount++;
                continue;
              }
            }
            upserts[server.name] = server;
            currentTargets.add(target.id);
            server.targets = [...currentTargets];
            server.enabled = true;
            server.updatedAt = now;
          } else if (mode === "remove") {
            currentTargets.delete(target.id);
            server.targets = [...currentTargets];
            server.updatedAt = now;
            if (
              native &&
              !(native.isBuiltin && (!native.builtinOwnerTargetId || native.builtinOwnerTargetId === target.id))
            ) {
              removals.push(server.name);
            }
          }
        }

        if (Object.keys(upserts).length === 0 && removals.length === 0) {
          results.push({ targetId: target.id, targetName: target.name, status: "unchanged" });
          continue;
        }
        if (targetScan.error) {
          results.push({ targetId: target.id, targetName: target.name, status: "error", error: targetScan.error });
          continue;
        }

        try {
          if (targetScan.exists) {
            await backupTargetIfNeeded(target, autoBackup);
          }
          await writeTargetSafe(target, upserts, removals);
          for (const name of removals) clearManagedOwner(state, target.id, name);
          for (const [name, srv] of Object.entries(upserts)) {
            releaseSiblingTargetClaims(state, srv, target.id);
            setManagedOwner(state, target.id, name, srv.id);
          }

          updatedCount++;
          results.push({
            targetId: target.id,
            targetName: target.name,
            status: "updated",
            added: Object.keys(upserts).length,
            removed: removals.length,
          });
        } catch (err) {
          results.push({
            targetId: target.id,
            targetName: target.name,
            status: "error",
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      if (updatedCount > 0) state.lastSyncedAt = now;
      await store.save(state);
      return {
        updatedCount,
        skippedCount,
        errorCount: results.filter((r) => r.status === "error").length,
        results,
        overview: await buildOverview(),
      };
    });
  }

  async function batchUpdateTargets({ ids, targetIds, mode = "add" }) {
    return serialize(async () => {
      const state = await store.load();
      const idSet = new Set(Array.isArray(ids) ? ids.map(String) : []);
      const cleanTargets = Array.isArray(targetIds)
        ? [...new Set(targetIds.map((x) => String(x).trim()).filter(Boolean))]
        : [];
      if (idSet.size === 0) throw new Error("No MCP servers selected");
      if (mode !== "replace" && cleanTargets.length === 0) {
        throw new Error("No target AIs selected");
      }

      const now = new Date().toISOString();
      let affected = 0;
      for (const server of state.servers) {
        if (!idSet.has(server.id)) continue;
        const current = new Set(Array.isArray(server.targets) ? server.targets : []);
        if (mode === "add") {
          for (const tid of cleanTargets) current.add(tid);
          server.targets = [...current];
          if (server.targets.length > 0) server.enabled = true;
        } else if (mode === "remove") {
          for (const tid of cleanTargets) current.delete(tid);
          server.targets = [...current];
        } else if (mode === "replace") {
          server.targets = [...cleanTargets];
          if (server.targets.length > 0) server.enabled = true;
        }
        server.updatedAt = now;
        affected++;
      }

      await store.save(state);
      return { affected, overview: await buildOverview() };
    });
  }

  async function importJson({ jsonText, targets, overwrite = false }) {
    return serialize(async () => {
      const state = await store.load();
      const settings = await readSettings();
      const skipLoopback = settings.skipLoopbackCodexhost !== false;
      const parsedList = parseMcpJsonInput(jsonText);
      const selectedTargets = Array.isArray(targets)
        ? [...new Set(targets.map((x) => String(x).trim()).filter(Boolean))]
        : [];
      const now = new Date().toISOString();
      let added = 0;
      let updated = 0;

      for (const item of parsedList) {
        const isLoopback = isCodexhostLoopbackServer(item.name, item.transport);
        const itemTargets = isLoopback && skipLoopback ? [] : selectedTargets;
        const idx = state.servers.findIndex((s) => s.name === item.name);
        if (idx >= 0) {
          if (overwrite) {
            state.servers[idx] = {
              ...state.servers[idx],
              description: item.description || state.servers[idx].description,
              enabled: item.enabled,
              transport: item.transport,
              targets: [...new Set([...state.servers[idx].targets, ...itemTargets])],
              isLoopback,
              updatedAt: now,
            };
            updated++;
          }
        } else {
          state.servers.push({
            id: randomUUID(),
            name: item.name,
            description: item.description,
            enabled: item.enabled,
            transport: item.transport,
            targets: itemTargets,
            isLoopback,
            createdAt: now,
            updatedAt: now,
          });
          added++;
        }
      }

      await store.save(state);
      return { added, updated, overview: await buildOverview() };
    });
  }

  /**
   * Import existing MCPs from local AI configs.
   * Groups by (name + transportSignature) so same-name MCPs with DIFFERENT configs across AIs
   * can ALL be imported as separate cards with automatic source aliases without overwriting each other!
   */
  async function importFromTarget({
    sourceTargetId = "all",
    assignTargets,
    overwrite = false,
    selectedNames,
    selectedVariants,
  } = {}) {
    return serialize(async () => {
      const state = await store.load();
      const settings = await readSettings();
      const skipLoopback = settings.skipLoopbackCodexhost !== false;
      const excludeBuiltin = settings.excludeBuiltinMcp !== false;
      const scanned = await scanTargets(state);

      // Build map of where each (server name + transport signature) actually exists across ALL scanned AIs.
      const actualPresence = new Map();
      const targetShortById = new Map(scanned.map((t) => [t.id, t.shortName || t.name]));
      const variantCountByName = new Map();
      const seenVariantForCount = new Set();

      for (const tg of scanned) {
        for (const ns of tg.nativeServers) {
          if (excludeBuiltin && detectBuiltinMcp(ns.name, ns.transport).isBuiltin) continue;
          const key = `${ns.name}\u0000${transportSignature(ns.transport)}`;
          const list = actualPresence.get(key) ?? [];
          if (!list.includes(tg.id)) list.push(tg.id);
          actualPresence.set(key, list);
          if (!seenVariantForCount.has(key)) {
            seenVariantForCount.add(key);
            variantCountByName.set(ns.name, (variantCountByName.get(ns.name) ?? 0) + 1);
          }
        }
      }

      const sources =
        sourceTargetId === "all"
          ? scanned.filter((t) => t.exists && t.nativeServers.length > 0)
          : scanned.filter((t) => t.id === sourceTargetId);

      const explicitAssign = Array.isArray(assignTargets) ? assignTargets : null;
      const filterVariants =
        Array.isArray(selectedVariants) && selectedVariants.length > 0 ? new Set(selectedVariants) : null;
      const filterNames =
        !filterVariants && Array.isArray(selectedNames) && selectedNames.length > 0
          ? new Set(selectedNames)
          : null;

      const now = new Date().toISOString();
      let added = 0;
      let updated = 0;
      let skippedBuiltin = 0;
      const seenBuiltin = new Set();
      const processedVariants = new Set();

      for (const src of sources) {
        for (const native of src.nativeServers) {
          const builtin = detectBuiltinMcp(native.name, native.transport);
          if (excludeBuiltin && builtin.isBuiltin) {
            if (!seenBuiltin.has(`${src.id}:${native.name}`)) {
              seenBuiltin.add(`${src.id}:${native.name}`);
              skippedBuiltin++;
            }
            continue;
          }

          const sig = transportSignature(native.transport);
          const sigKey = `${native.name}\u0000${sig}`;
          if (filterVariants && !filterVariants.has(sigKey)) continue;
          if (filterNames && !filterNames.has(native.name)) continue;
          if (processedVariants.has(sigKey)) continue;
          processedVariants.add(sigKey);

          const isLoopback = isCodexhostLoopbackServer(native.name, native.transport);
          const presentIds = actualPresence.get(sigKey) ?? [src.id];
          const effectiveTargets =
            isLoopback && skipLoopback
              ? presentIds
              : explicitAssign
                ? [...new Set([...explicitAssign, ...presentIds])]
                : [...new Set(presentIds)];

          // 1. Check if this exact (name + transportSignature) is already in the hub
          const exactIdx = state.servers.findIndex(
            (s) => s.name === native.name && transportSignature(s.transport) === sig,
          );
          if (exactIdx >= 0) {
            const existing = state.servers[exactIdx];
            existing.targets = [...new Set([...(existing.targets ?? []), ...presentIds])];
            existing.updatedAt = now;
            for (const pid of presentIds) setManagedOwner(state, pid, native.name, existing.id);
            continue;
          }

          // 2. Check if another server with the same name (different config) already exists in hub
          const sameNameServers = state.servers.filter((s) => s.name === native.name);
          if (sameNameServers.length > 0 && overwrite) {
            const targetSrv = sameNameServers[0];
            targetSrv.enabled = native.enabled;
            targetSrv.transport = native.transport;
            targetSrv.targets = [...new Set([...(targetSrv.targets ?? []), ...effectiveTargets])];
            targetSrv.isLoopback = isLoopback;
            targetSrv.updatedAt = now;
            for (const pid of presentIds) setManagedOwner(state, pid, native.name, targetSrv.id);
            updated++;
            continue;
          }

          // 3. Auto-assign alias if multiple variants exist for this name
          const needsAlias = sameNameServers.length > 0 || (variantCountByName.get(native.name) ?? 1) > 1;
          const makeAlias = (ids) =>
            ids
              .slice(0, 2)
              .map((id) => targetShortById.get(id) || id)
              .join("/");

          // Backfill alias on existing unlabeled same-name card so both cards are clearly distinguished
          if (needsAlias) {
            for (const existing of sameNameServers) {
              if (!existing.alias) {
                existing.alias =
                  makeAlias(existing.targets?.length ? existing.targets : []) ||
                  existing.transport?.type ||
                  "v1";
                existing.autoAlias = true;
              }
            }
          }

          let alias = needsAlias ? makeAlias(presentIds) : "";
          if (alias && sameNameServers.some((s) => (s.alias || "") === alias)) {
            alias = `${alias} (${native.transport?.type || "alt"})`;
          }

          const newServer = {
            id: randomUUID(),
            name: native.name,
            alias,
            autoAlias: Boolean(alias),
            description: "",
            enabled: native.enabled,
            transport: native.transport,
            targets: effectiveTargets,
            isLoopback,
            createdAt: now,
            updatedAt: now,
          };
          state.servers.push(newServer);
          for (const pid of presentIds) setManagedOwner(state, pid, native.name, newServer.id);
          added++;
        }
      }

      await store.save(state);
      return { added, updated, skippedBuiltin, overview: await buildOverview() };
    });
  }

  async function previewSync({ targetIds } = {}) {
    const state = await store.load();
    const scanned = await scanTargets(state);
    const idFilter = Array.isArray(targetIds) && targetIds.length > 0 ? new Set(targetIds) : null;
    const diffs = scanned
      .filter((t) => (idFilter ? idFilter.has(t.id) : t.enabled))
      .map((t) => {
        const { desired: _omit, ...publicDiff } = computeTargetDiff(state, t, Boolean(idFilter));
        return publicDiff;
      });
    return { diffs };
  }

  async function applySync({ targetIds } = {}) {
    return serialize(async () => {
      const state = await store.load();
      const settings = await readSettings();
      const autoBackup = settings.autoBackup !== false;
      const targets = resolveTargets(state);
      const scanned = await scanTargets(state);
      const scanById = new Map(scanned.map((s) => [s.id, s]));
      const idFilter = Array.isArray(targetIds) && targetIds.length > 0 ? new Set(targetIds) : null;

      const results = [];
      let updatedCount = 0;

      for (const target of targets) {
        const targetScan = scanById.get(target.id);
        if (!targetScan) continue;
        if (idFilter ? !idFilter.has(target.id) : !targetScan.enabled) continue;

        const diff = computeTargetDiff(state, targetScan, Boolean(idFilter));
        if (!diff.hasChanges) {
          results.push({ targetId: target.id, targetName: target.name, status: "unchanged" });
          continue;
        }
        if (targetScan.error) {
          results.push({
            targetId: target.id,
            targetName: target.name,
            status: "error",
            error: targetScan.error,
          });
          continue;
        }

        const upserts = {};
        for (const name of [...diff.adds, ...diff.updates]) {
          upserts[name] = diff.desired[name];
        }

        try {
          if (targetScan.exists) {
            await backupTargetIfNeeded(target, autoBackup);
          }

          await writeTargetSafe(target, upserts, diff.removes);

          for (const name of diff.removes) clearManagedOwner(state, target.id, name);
          for (const [name, srv] of Object.entries(diff.desired)) {
            releaseSiblingTargetClaims(state, srv, target.id);
            setManagedOwner(state, target.id, name, srv.id);
          }

          updatedCount++;
          results.push({
            targetId: target.id,
            targetName: target.name,
            status: "updated",
            added: diff.adds.length,
            updated: diff.updates.length,
            removed: diff.removes.length,
          });
        } catch (err) {
          results.push({
            targetId: target.id,
            targetName: target.name,
            status: "error",
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      if (updatedCount > 0) {
        state.lastSyncedAt = new Date().toISOString();
      }
      await store.save(state);
      return {
        updatedCount,
        errorCount: results.filter((r) => r.status === "error").length,
        results,
        overview: await buildOverview(),
      };
    });
  }

  async function setTargetEnabled({ targetId, enabled, targetIds }) {
    return serialize(async () => {
      const state = await store.load();
      if (Array.isArray(targetIds)) {
        state.enabledTargets = [...new Set(targetIds.map((x) => String(x).trim()).filter(Boolean))];
      } else if (targetId) {
        const scanned = await scanTargets(state);
        const current = resolveEnabledTargetSet(state, scanned);
        if (enabled) current.add(targetId);
        else current.delete(targetId);
        state.enabledTargets = [...current];
      }
      await store.save(state);
      return buildOverview();
    });
  }

  async function setTargetPath({ targetId, configPath }) {
    return serialize(async () => {
      const state = await store.load();
      const trimmed = String(configPath ?? "").trim();
      if (!trimmed) {
        delete state.targetPathOverrides[targetId];
      } else {
        state.targetPathOverrides[targetId] = trimmed;
      }
      await store.save(state);
      baselineByTarget.delete(targetId);
      const scanned = await scanTargets(state);
      await syncWatchers(state, scanned);
      return buildOverview();
    });
  }

  async function addCustomTarget({ name, configPath, rootKey = "mcpServers" }) {
    return serialize(async () => {
      const cleanName = String(name ?? "").trim();
      const cleanPath = String(configPath ?? "").trim();
      const cleanKey = String(rootKey ?? "mcpServers").trim() || "mcpServers";
      if (!cleanName || !cleanPath) {
        throw new Error("Custom target requires both name and absolute configPath");
      }
      const state = await store.load();
      const id = `custom-${cleanName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || randomUUID().slice(0, 6)}`;
      if (resolveTargets(state).some((t) => t.id === id)) {
        throw new Error(`Target ID "${id}" already exists`);
      }
      state.customTargets.push({ id, name: cleanName, configPath: cleanPath, rootKey: cleanKey });
      if (Array.isArray(state.enabledTargets) && !state.enabledTargets.includes(id)) {
        state.enabledTargets.push(id);
      }
      await store.save(state);
      const scanned = await scanTargets(state);
      await syncWatchers(state, scanned);
      return buildOverview();
    });
  }

  async function removeCustomTarget({ targetId }) {
    return serialize(async () => {
      const state = await store.load();
      state.customTargets = state.customTargets.filter((t) => t.id !== targetId);
      if (Array.isArray(state.enabledTargets)) {
        state.enabledTargets = state.enabledTargets.filter((id) => id !== targetId);
      }
      delete state.managedKeysByTarget[targetId];
      delete state.managedOwnersByTarget[targetId];
      delete state.targetPathOverrides[targetId];
      baselineByTarget.delete(targetId);
      for (const s of state.servers) {
        s.targets = (s.targets ?? []).filter((id) => id !== targetId);
      }
      await store.save(state);
      const scanned = await scanTargets(state);
      await syncWatchers(state, scanned);
      return buildOverview();
    });
  }

  async function scanProject({ projectDir }) {
    const dir = String(projectDir ?? "").trim();
    if (!dir) throw new Error("Project directory is required");
    const descriptors = getProjectTargetDescriptors(dir);
    const items = await Promise.all(
      descriptors.map(async (desc) => {
        const res = await readTargetConfig(desc);
        return {
          ...desc,
          exists: res.exists,
          error: res.error,
          servers: Object.values(res.servers),
        };
      }),
    );
    return { projectDir: path.resolve(dir), items };
  }

  async function syncProject({ projectDir, formatIds }) {
    return serialize(async () => {
      const dir = String(projectDir ?? "").trim();
      if (!dir) throw new Error("Project directory is required");
      const state = await store.load();
      const settings = await readSettings();
      const autoBackup = settings.autoBackup !== false;
      const enabledServers = state.servers.filter(
        (s) => s.enabled && !s.isLoopback && !detectBuiltinMcp(s.name, s.transport).isBuiltin,
      );
      const upserts = {};
      const duplicateNames = [];
      for (const srv of enabledServers) {
        if (!upserts[srv.name]) {
          upserts[srv.name] = srv;
        } else {
          if (!duplicateNames.includes(srv.name)) duplicateNames.push(srv.name);
          // Prefer unaliased primary entry over aliased variants when exporting to a single project file
          if (upserts[srv.name].alias && !srv.alias) {
            upserts[srv.name] = srv;
          }
        }
      }
      const descriptors = getProjectTargetDescriptors(dir);
      const selected = new Set(Array.isArray(formatIds) ? formatIds : ["project-mcp-json"]);
      const results = [];

      for (const desc of descriptors) {
        if (!selected.has(desc.id)) continue;
        try {
          await backupTargetIfNeeded(desc, autoBackup, `${desc.name} (${path.basename(dir)})`);
          await applyTargetMutations(desc, upserts, []);
          results.push({
            id: desc.id,
            configPath: desc.configPath,
            status: "updated",
            count: Object.keys(upserts).length,
          });
        } catch (err) {
          results.push({
            id: desc.id,
            configPath: desc.configPath,
            status: "error",
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      return { results, duplicateNames, scan: await scanProject({ projectDir: dir }) };
    });
  }

  async function probeServer({ id, server }) {
    const settings = await readSettings();
    let target = server;
    if (!target && id) {
      const state = await store.load();
      target = state.servers.find((s) => s.id === id);
    }
    if (!target) throw new Error("Server not found");
    return probeMcpServer(target, settings.httpProbeTimeoutMs ?? 4000);
  }

  async function listBackups() {
    return { backups: await store.listBackups() };
  }

  async function restoreBackup({ backupId }) {
    return serialize(async () => {
      const state = await store.load();
      const safeBackupId = String(backupId ?? "").trim();
      const targetMatch = resolveTargets(state).find((t) => {
        const safeId = t.id.replace(/[^a-zA-Z0-9_-]/g, "_");
        return safeBackupId.endsWith(`_${safeId}`);
      });
      if (targetMatch) watcher.markSelfWrite(targetMatch.id, 1800);
      const meta = await store.restoreBackup(backupId);
      const restoredTarget = resolveTargets(state).find((t) => t.id === meta.targetId);
      if (restoredTarget) {
        await refreshBaselineForTarget(restoredTarget);
        watcher.markSelfWrite(restoredTarget.id, 1800);
      }
      revision++;
      return { restored: meta, overview: await buildOverview() };
    });
  }

  async function handleWatchedTargetChange(sourceTargetId) {
    return serialize(async () => {
      const state = await store.load();
      const scanned = await scanTargets(state);
      const cfg = resolveAutoSyncView(state, scanned);
      if (!cfg.enabled) return { propagated: 0 };

      const targets = resolveTargets(state);
      const targetById = new Map(targets.map((t) => [t.id, t]));
      const scanById = new Map(scanned.map((t) => [t.id, t]));
      const sourceTarget = targetById.get(sourceTargetId);
      if (!sourceTarget) return { propagated: 0 };

      const fresh = await readTargetConfig(sourceTarget);
      if (fresh.error) {
        pushAutoSyncLog({
          action: "blocked",
          mcpName: "*",
          sourceTargetId,
          sourceName: sourceTarget.shortName || sourceTarget.name,
          destNames: [],
          status: "blocked",
          detail: fresh.error,
        });
        revision++;
        return { propagated: 0, blocked: "parse-error" };
      }

      const nextSnap = makeNativeSnapshot(fresh.servers);
      const prevSnap = baselineByTarget.get(sourceTargetId);
      if (!prevSnap) {
        baselineByTarget.set(sourceTargetId, nextSnap);
        return { propagated: 0 };
      }

      const added = [];
      const updated = [];
      const removed = [];
      const skippedProtected = [];

      for (const [name, cur] of nextSnap.entries()) {
        const prev = prevSnap.get(name);
        if (!prev) {
          if (cur.isBuiltin || cur.isLoopback) {
            skippedProtected.push({ name, reason: cur.isBuiltin ? "builtin" : "loopback" });
          } else {
            added.push({ name, entry: cur });
          }
        } else if (cur.sig !== prev.sig || cur.enabled !== prev.enabled) {
          if (cur.isBuiltin || cur.isLoopback) {
            skippedProtected.push({ name, reason: cur.isBuiltin ? "builtin" : "loopback" });
          } else {
            updated.push({ name, entry: cur, prev });
          }
        }
      }

      for (const [name, prev] of prevSnap.entries()) {
        if (!nextSnap.has(name) && !prev.isBuiltin && !prev.isLoopback) {
          removed.push({ name, prev });
        }
      }

      const totalChanges = added.length + updated.length + removed.length + skippedProtected.length;
      if (totalChanges === 0) {
        return { propagated: 0 };
      }

      // Update baseline immediately so late OS events won't re-trigger
      baselineByTarget.set(sourceTargetId, nextSnap);
      revision++;

      for (const sk of skippedProtected) {
        pushAutoSyncLog({
          action: "skip",
          mcpName: sk.name,
          sourceTargetId,
          sourceName: sourceTarget.shortName || sourceTarget.name,
          destNames: [],
          status: "protected",
          detail: sk.reason,
        });
      }

      // Mass-wipe circuit breaker: refuse to broadcast if >=2 managed MCPs vanished all at once
      const prevNonBuiltinCount = [...prevSnap.values()].filter((x) => !x.isBuiltin && !x.isLoopback).length;
      const nextNonBuiltinCount = [...nextSnap.values()].filter((x) => !x.isBuiltin && !x.isLoopback).length;
      if (prevNonBuiltinCount >= 2 && nextNonBuiltinCount === 0 && removed.length >= 2) {
        pushAutoSyncLog({
          action: "blocked",
          mcpName: "*",
          sourceTargetId,
          sourceName: sourceTarget.shortName || sourceTarget.name,
          destNames: [],
          status: "blocked",
          detail: "mass-wipe-guard",
        });
        return { propagated: 0, blocked: "mass-wipe-guard" };
      }

      // Check whether this source is allowed to trigger propagation
      const allowedSource =
        cfg.mode === "primary"
          ? sourceTargetId === cfg.primaryTargetId
          : cfg.targetIds.includes(sourceTargetId);
      if (!allowedSource) {
        return { propagated: 0 };
      }

      const settings = await readSettings();
      const autoBackup = settings.autoBackup !== false;
      const now = new Date().toISOString();
      const mcpAllowSet = cfg.mcpScope === "selected" ? new Set(cfg.selectedMcpNames) : null;
      const candidateDestIds = cfg.targetIds.filter((id) => id !== sourceTargetId);

      let propagated = 0;
      let stateDirty = false;

      const findOrCreateHubServer = (name, entry, prevSig) => {
        const ownerId = getManagedOwnerId(state, sourceTargetId, name);
        let srv = ownerId ? state.servers.find((s) => s.id === ownerId) : null;
        if (!srv && prevSig) {
          srv = state.servers.find((s) => s.name === name && transportSignature(s.transport) === prevSig);
        }
        if (!srv) {
          const sameName = state.servers.filter((s) => s.name === name);
          if (sameName.length === 1) srv = sameName[0];
        }
        if (srv) {
          srv.transport = entry.transport;
          srv.enabled = entry.enabled !== false;
          srv.targets = [...new Set([...(srv.targets ?? []), sourceTargetId])];
          srv.isLoopback = isCodexhostLoopbackServer(name, entry.transport);
          srv.updatedAt = now;
        } else {
          srv = {
            id: randomUUID(),
            name,
            alias: "",
            autoAlias: false,
            description: "",
            enabled: entry.enabled !== false,
            transport: entry.transport,
            targets: [sourceTargetId],
            isLoopback: isCodexhostLoopbackServer(name, entry.transport),
            createdAt: now,
            updatedAt: now,
          };
          state.servers.push(srv);
        }
        setManagedOwner(state, sourceTargetId, name, srv.id);
        stateDirty = true;
        return srv;
      };

      // 1. Propagate additions
      if (cfg.syncAdditions) {
        for (const { name, entry } of added) {
          if (mcpAllowSet && !mcpAllowSet.has(name)) continue;
          const hubSrv = findOrCreateHubServer(name, entry, null);
          const destNames = [];
          for (const destId of candidateDestIds) {
            const destTarget = targetById.get(destId);
            const destScan = scanById.get(destId);
            if (!destTarget || !destScan || destScan.error) continue;
            const destNative = destScan.nativeServers.find((ns) => ns.name === name);
            if (destNative) {
              // Do not clobber an existing differently-configured same-name MCP on add
              continue;
            }
            try {
              if (destScan.exists) await backupTargetIfNeeded(destTarget, autoBackup);
              await writeTargetSafe(destTarget, { [name]: hubSrv }, []);
              setManagedOwner(state, destId, name, hubSrv.id);
              hubSrv.targets = [...new Set([...(hubSrv.targets ?? []), destId])];
              destNames.push(destTarget.shortName || destTarget.name);
              propagated++;
              stateDirty = true;
            } catch {
              // Skip failing target without stopping other targets
            }
          }
          if (destNames.length > 0) {
            pushAutoSyncLog({
              action: "add",
              mcpName: name,
              sourceTargetId,
              sourceName: sourceTarget.shortName || sourceTarget.name,
              destNames,
              status: "synced",
              detail: "",
            });
          }
        }
      }

      // 2. Propagate updates
      if (cfg.syncUpdates) {
        for (const { name, entry, prev } of updated) {
          if (mcpAllowSet && !mcpAllowSet.has(name)) continue;
          const hubSrv = findOrCreateHubServer(name, entry, prev.sig);
          const destNames = [];
          for (const destId of candidateDestIds) {
            const destTarget = targetById.get(destId);
            const destScan = scanById.get(destId);
            if (!destTarget || !destScan || destScan.error) continue;
            const destNative = destScan.nativeServers.find((ns) => ns.name === name);
            const destOwnerId = getManagedOwnerId(state, destId, name);
            // Respect intentional same-name variant isolation
            if (destOwnerId && destOwnerId !== hubSrv.id) continue;
            if (cfg.updateScope === "existing-only") {
              const hasExisting = Boolean(destNative) || (hubSrv.targets ?? []).includes(destId);
              if (!hasExisting) continue;
            }
            if (
              destNative &&
              destNative.enabled !== false &&
              transportSignature(destNative.transport) === entry.sig
            ) {
              continue;
            }
            try {
              if (destScan.exists) await backupTargetIfNeeded(destTarget, autoBackup);
              await writeTargetSafe(destTarget, { [name]: hubSrv }, []);
              setManagedOwner(state, destId, name, hubSrv.id);
              hubSrv.targets = [...new Set([...(hubSrv.targets ?? []), destId])];
              destNames.push(destTarget.shortName || destTarget.name);
              propagated++;
              stateDirty = true;
            } catch {
              // Skip failing target without stopping other targets
            }
          }
          if (destNames.length > 0) {
            pushAutoSyncLog({
              action: "update",
              mcpName: name,
              sourceTargetId,
              sourceName: sourceTarget.shortName || sourceTarget.name,
              destNames,
              status: "synced",
              detail: cfg.updateScope === "existing-only" ? "existing-only" : "all-selected",
            });
          }
        }
      }

      // 3. Propagate removals (only when explicitly enabled by user)
      if (cfg.syncRemovals) {
        for (const { name, prev } of removed) {
          if (mcpAllowSet && !mcpAllowSet.has(name)) continue;
          const ownerId = getManagedOwnerId(state, sourceTargetId, name);
          const hubSrv =
            (ownerId ? state.servers.find((s) => s.id === ownerId) : null) ||
            state.servers.find((s) => s.name === name && transportSignature(s.transport) === prev.sig) ||
            null;
          clearManagedOwner(state, sourceTargetId, name);
          if (hubSrv) {
            hubSrv.targets = (hubSrv.targets ?? []).filter((id) => id !== sourceTargetId);
            stateDirty = true;
          }
          const destNames = [];
          for (const destId of candidateDestIds) {
            const destTarget = targetById.get(destId);
            const destScan = scanById.get(destId);
            if (!destTarget || !destScan || destScan.error) continue;
            const destNative = destScan.nativeServers.find((ns) => ns.name === name);
            if (!destNative) continue;
            if (
              destNative.isBuiltin &&
              (!destNative.builtinOwnerTargetId || destNative.builtinOwnerTargetId === destId)
            ) {
              continue;
            }
            const destOwnerId = getManagedOwnerId(state, destId, name);
            if (hubSrv && destOwnerId && destOwnerId !== hubSrv.id) continue;
            try {
              if (destScan.exists) await backupTargetIfNeeded(destTarget, autoBackup);
              await writeTargetSafe(destTarget, {}, [name]);
              clearManagedOwner(state, destId, name);
              if (hubSrv) {
                hubSrv.targets = (hubSrv.targets ?? []).filter((id) => id !== destId);
              }
              destNames.push(destTarget.shortName || destTarget.name);
              propagated++;
              stateDirty = true;
            } catch {
              // Skip failing target
            }
          }
          if (destNames.length > 0) {
            pushAutoSyncLog({
              action: "remove",
              mcpName: name,
              sourceTargetId,
              sourceName: sourceTarget.shortName || sourceTarget.name,
              destNames,
              status: "synced",
              detail: "",
            });
          }
        }
      }

      if (stateDirty) {
        if (propagated > 0) state.lastSyncedAt = now;
        await store.save(state);
        revision++;
      }
      return { propagated };
    });
  }

  async function initAutoSync() {
    const state = await store.load();
    const scanned = await scanTargets(state);
    await syncWatchers(state, scanned);
  }

  async function setAutoSyncConfig(patch) {
    return serialize(async () => {
      const state = await store.load();
      const prev = normalizeAutoSyncConfig(state.autoSync);
      const next = normalizeAutoSyncConfig({ ...prev, ...(patch ?? {}) });
      state.autoSync = next;
      await store.save(state);
      const scanned = await scanTargets(state);
      // Reset baselines when enabling so existing differences never burst-sync
      if (next.enabled && !prev.enabled) {
        baselineByTarget.clear();
      }
      await syncWatchers(state, scanned);
      revision++;
      return buildOverview();
    });
  }

  async function clearAutoSyncLogs() {
    autoSyncLogs = [];
    revision++;
    return { ok: true, revision };
  }

  function getRevision() {
    return { revision };
  }

  function dispose() {
    watcher.dispose();
  }

  return {
    buildOverview,
    initAutoSync,
    setAutoSyncConfig,
    clearAutoSyncLogs,
    getRevision,
    handleWatchedTargetChange,
    dispose,
    saveServer,
    deleteServer,
    toggleServer,
    setServerTargets,
    applySingleServer,
    revertSingleServer,
    batchApplyTargets,
    batchUpdateTargets,
    importJson,
    importFromTarget,
    previewSync,
    applySync,
    setTargetEnabled,
    setTargetPath,
    addCustomTarget,
    removeCustomTarget,
    scanProject,
    syncProject,
    probeServer,
    listBackups,
    restoreBackup,
  };
}

export async function activate(ctx) {
  const controller = createHubController({
    dataDir: ctx.dataDir,
    readSettings: () => ctx.readSettings(),
  });
  await controller.initAutoSync();

  ctx.handle("overview", () => controller.buildOverview());
  ctx.handle("overview/revision", () => controller.getRevision());
  ctx.handle("autosync/set-config", (params) => controller.setAutoSyncConfig(params ?? {}));
  ctx.handle("autosync/clear-logs", () => controller.clearAutoSyncLogs());
  ctx.handle("servers/save", (params) => controller.saveServer(params));
  ctx.handle("servers/delete", (params) => controller.deleteServer(params ?? {}));
  ctx.handle("servers/toggle", (params) => controller.toggleServer(params ?? {}));
  ctx.handle("servers/set-targets", (params) => controller.setServerTargets(params ?? {}));
  ctx.handle("servers/apply-single", (params) => controller.applySingleServer(params ?? {}));
  ctx.handle("servers/revert-single", (params) => controller.revertSingleServer(params ?? {}));
  ctx.handle("servers/batch-apply", (params) => controller.batchApplyTargets(params ?? {}));
  ctx.handle("servers/batch-targets", (params) => controller.batchUpdateTargets(params ?? {}));
  ctx.handle("servers/import-json", (params) => controller.importJson(params ?? {}));
  ctx.handle("servers/import-from-target", (params) => controller.importFromTarget(params ?? {}));
  ctx.handle("servers/probe", (params) => controller.probeServer(params ?? {}));
  ctx.handle("sync/preview", (params) => controller.previewSync(params ?? {}));
  ctx.handle("sync/apply", (params) => controller.applySync(params ?? {}));
  ctx.handle("targets/set-enabled", (params) => controller.setTargetEnabled(params ?? {}));
  ctx.handle("targets/set-path", (params) => controller.setTargetPath(params ?? {}));
  ctx.handle("targets/custom-add", (params) => controller.addCustomTarget(params ?? {}));
  ctx.handle("targets/custom-remove", (params) => controller.removeCustomTarget(params ?? {}));
  ctx.handle("project/scan", (params) => controller.scanProject(params ?? {}));
  ctx.handle("project/sync", (params) => controller.syncProject(params ?? {}));
  ctx.handle("backups/list", () => controller.listBackups());
  ctx.handle("backups/restore", (params) => controller.restoreBackup(params ?? {}));

  return () => {
    controller.dispose();
  };
}
