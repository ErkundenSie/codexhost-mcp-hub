/**
 * Persistent state & backup store inside `$CODEXHOST_DATA_DIR/host-extension-data/mcp-hub/`.
 */

import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { atomicWriteText } from "./adapters.mjs";

const STATE_FILE = "hub-state.json";
const AUTOSYNC_LOGS_FILE = "autosync-logs.json";
const BACKUPS_DIR = "backups";
const MAX_BACKUPS = 40;

export function createDefaultAutoSync() {
  return {
    enabled: false,
    mode: "bidirectional",
    primaryTargetId: "",
    updateScope: "existing-only",
    mcpScope: "all",
    selectedMcpNames: [],
    targetIds: null,
    syncAdditions: true,
    syncUpdates: true,
    syncRemovals: false,
  };
}

export function normalizeAutoSyncConfig(raw) {
  const base = createDefaultAutoSync();
  if (!raw || typeof raw !== "object") return base;
  return {
    enabled: Boolean(raw.enabled),
    mode: raw.mode === "primary" ? "primary" : "bidirectional",
    primaryTargetId: typeof raw.primaryTargetId === "string" ? raw.primaryTargetId.trim() : "",
    updateScope: raw.updateScope === "all-selected" ? "all-selected" : "existing-only",
    mcpScope: raw.mcpScope === "selected" ? "selected" : "all",
    selectedMcpNames: Array.isArray(raw.selectedMcpNames)
      ? [...new Set(raw.selectedMcpNames.map((x) => String(x).trim()).filter(Boolean))]
      : [],
    targetIds: Array.isArray(raw.targetIds)
      ? [...new Set(raw.targetIds.map((x) => String(x).trim()).filter(Boolean))]
      : null,
    syncAdditions: raw.syncAdditions !== false,
    syncUpdates: raw.syncUpdates !== false,
    syncRemovals: raw.syncRemovals === true,
  };
}

export function createEmptyState() {
  return {
    version: 1,
    servers: [],
    enabledTargets: null,
    targetPathOverrides: {},
    customTargets: [],
    managedKeysByTarget: {},
    managedOwnersByTarget: {},
    autoSync: createDefaultAutoSync(),
    lastSyncedAt: null,
  };
}

export class HubStore {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.statePath = path.join(dataDir, STATE_FILE);
    this.autoSyncLogsPath = path.join(dataDir, AUTOSYNC_LOGS_FILE);
    this.backupsDir = path.join(dataDir, BACKUPS_DIR);
  }

  async loadAutoSyncLogs() {
    try {
      const text = await readFile(this.autoSyncLogsPath, "utf8");
      const parsed = JSON.parse(text);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  async saveAutoSyncLogs(logs) {
    const safe = Array.isArray(logs) ? logs : [];
    await atomicWriteText(this.autoSyncLogsPath, JSON.stringify(safe, null, 2) + "\n");
    return safe;
  }

  async load() {
    try {
      const text = await readFile(this.statePath, "utf8");
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== "object") return createEmptyState();
      return {
        version: 1,
        servers: Array.isArray(parsed.servers) ? parsed.servers : [],
        enabledTargets: Array.isArray(parsed.enabledTargets) ? parsed.enabledTargets : null,
        targetPathOverrides:
          parsed.targetPathOverrides && typeof parsed.targetPathOverrides === "object"
            ? parsed.targetPathOverrides
            : {},
        customTargets: Array.isArray(parsed.customTargets) ? parsed.customTargets : [],
        managedKeysByTarget:
          parsed.managedKeysByTarget && typeof parsed.managedKeysByTarget === "object"
            ? parsed.managedKeysByTarget
            : {},
        managedOwnersByTarget:
          parsed.managedOwnersByTarget && typeof parsed.managedOwnersByTarget === "object"
            ? parsed.managedOwnersByTarget
            : {},
        autoSync: normalizeAutoSyncConfig(parsed.autoSync),
        lastSyncedAt: typeof parsed.lastSyncedAt === "string" ? parsed.lastSyncedAt : null,
      };
    } catch {
      return createEmptyState();
    }
  }

  async save(state) {
    await atomicWriteText(this.statePath, JSON.stringify(state, null, 2) + "\n");
    return state;
  }

  async createBackup({ targetId, targetName, configPath, content }) {
    await mkdir(this.backupsDir, { recursive: true });
    const now = new Date();
    const stamp = now.toISOString().replace(/[:.]/g, "-");
    const suffix = randomBytes(2).toString("hex");
    const safeTarget = String(targetId).replace(/[^a-zA-Z0-9_-]/g, "_");
    const id = `${stamp}_${suffix}_${safeTarget}`;
    const ext = configPath.endsWith(".toml") ? ".toml" : ".json";
    const payloadFile = `${id}${ext}`;
    const metaFile = `${id}.meta.json`;

    await writeFile(path.join(this.backupsDir, payloadFile), content, "utf8");
    const meta = {
      id,
      targetId,
      targetName,
      configPath,
      payloadFile,
      createdAt: now.toISOString(),
      sizeBytes: Buffer.byteLength(content, "utf8"),
    };
    await writeFile(path.join(this.backupsDir, metaFile), JSON.stringify(meta, null, 2) + "\n", "utf8");
    await this.#pruneBackups();
    return meta;
  }

  async listBackups() {
    try {
      const files = await readdir(this.backupsDir);
      const metas = [];
      for (const f of files) {
        if (!f.endsWith(".meta.json")) continue;
        try {
          const parsed = JSON.parse(await readFile(path.join(this.backupsDir, f), "utf8"));
          if (parsed && parsed.id && parsed.payloadFile) metas.push(parsed);
        } catch {
          // skip corrupt metadata
        }
      }
      metas.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
      return metas;
    } catch {
      return [];
    }
  }

  async restoreBackup(backupId) {
    const safeId = String(backupId ?? "").trim();
    if (!safeId || safeId.includes("/") || safeId.includes("\\") || safeId.includes("..")) {
      throw new Error("Invalid backup ID");
    }
    const metaPath = path.join(this.backupsDir, `${safeId}.meta.json`);
    const meta = JSON.parse(await readFile(metaPath, "utf8"));
    const payloadPath = path.join(this.backupsDir, path.basename(meta.payloadFile));
    const content = await readFile(payloadPath, "utf8");
    await atomicWriteText(meta.configPath, content);
    return meta;
  }

  async #pruneBackups() {
    const metas = await this.listBackups();
    if (metas.length <= MAX_BACKUPS) return;
    for (const old of metas.slice(MAX_BACKUPS)) {
      await rm(path.join(this.backupsDir, `${old.id}.meta.json`), { force: true }).catch(() => {});
      await rm(path.join(this.backupsDir, path.basename(old.payloadFile)), { force: true }).catch(() => {});
    }
  }
}
