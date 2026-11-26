/**
 * Parent-directory `fs.watch` manager for real-time AI MCP config auto-sync.
 *
 * Watches parent directories rather than individual files so atomic rename saves
 * (used by editors, CLI tools, and MCP Sync Hub itself) never detach watchers on
 * Windows or macOS. Includes per-target debouncing and self-write echo suppression.
 */

import { watch } from "node:fs";
import path from "node:path";

const IS_WIN = process.platform === "win32";

function normName(name) {
  return IS_WIN ? String(name).toLowerCase() : String(name);
}

export class McpFileWatcher {
  constructor({ onTargetChanged, debounceMs = 750 } = {}) {
    this.onTargetChanged = onTargetChanged;
    this.debounceMs = Math.max(50, Number(debounceMs) || 750);
    /** @type {Map<string, { watcher: import("node:fs").FSWatcher, targets: Map<string, string> }>} */
    this.dirWatchers = new Map();
    /** @type {Map<string, ReturnType<typeof setTimeout>>} */
    this.pendingTimers = new Map();
    /** @type {Map<string, number>} */
    this.suppressedUntil = new Map();
    this.disposed = false;
  }

  /**
   * Suppress watch notifications for `targetId` briefly while MCP Sync Hub itself writes the file.
   */
  markSelfWrite(targetId, holdMs = 1500) {
    if (!targetId) return;
    const until = Date.now() + Math.max(200, holdMs);
    const prev = this.suppressedUntil.get(targetId) ?? 0;
    if (until > prev) this.suppressedUntil.set(targetId, until);
    const pending = this.pendingTimers.get(targetId);
    if (pending) {
      clearTimeout(pending);
      this.pendingTimers.delete(targetId);
    }
  }

  isSuppressed(targetId) {
    const until = this.suppressedUntil.get(targetId) ?? 0;
    if (until === 0) return false;
    if (Date.now() < until) return true;
    this.suppressedUntil.delete(targetId);
    return false;
  }

  /**
   * Synchronize active directory watchers to match the provided list of `{ id, configPath }` targets.
   */
  setTargets(targets) {
    if (this.disposed) return;
    /** @type {Map<string, { rawDir: string, targets: Map<string, string> }>} */
    const desiredDirs = new Map();

    for (const tg of targets ?? []) {
      if (!tg?.id || !tg?.configPath) continue;
      const abs = path.resolve(tg.configPath);
      const rawDir = path.dirname(abs);
      const dirKey = normName(rawDir);
      const baseKey = normName(path.basename(abs));
      let entry = desiredDirs.get(dirKey);
      if (!entry) {
        entry = { rawDir, targets: new Map() };
        desiredDirs.set(dirKey, entry);
      }
      entry.targets.set(tg.id, baseKey);
    }

    // Close watchers for directories no longer needed
    for (const [dirKey, rec] of [...this.dirWatchers.entries()]) {
      if (!desiredDirs.has(dirKey)) {
        try {
          rec.watcher.close();
        } catch {
          // Ignore close errors
        }
        this.dirWatchers.delete(dirKey);
      }
    }

    // Open or update watchers for desired directories
    for (const [dirKey, desired] of desiredDirs.entries()) {
      const existing = this.dirWatchers.get(dirKey);
      if (existing) {
        existing.targets = desired.targets;
        continue;
      }
      try {
        const w = watch(desired.rawDir, { persistent: false }, (_eventType, filename) => {
          this.#handleDirEvent(dirKey, filename);
        });
        w.on("error", () => {
          // Directory might have been deleted; drop cleanly without crashing host backend
          try {
            w.close();
          } catch {}
          this.dirWatchers.delete(dirKey);
        });
        this.dirWatchers.set(dirKey, { watcher: w, targets: desired.targets });
      } catch {
        // Parent directory does not exist yet — skip silently until created
      }
    }
  }

  #handleDirEvent(dirKey, filename) {
    if (this.disposed) return;
    const rec = this.dirWatchers.get(dirKey);
    if (!rec) return;
    const changedName = filename ? normName(String(filename)) : null;

    for (const [targetId, expectedBase] of rec.targets.entries()) {
      if (changedName && changedName !== expectedBase) continue;
      if (this.isSuppressed(targetId)) continue;
      this.#scheduleTarget(targetId);
    }
  }

  #scheduleTarget(targetId) {
    const prev = this.pendingTimers.get(targetId);
    if (prev) clearTimeout(prev);
    const timer = setTimeout(() => {
      this.pendingTimers.delete(targetId);
      if (this.disposed || this.isSuppressed(targetId)) return;
      Promise.resolve(this.onTargetChanged?.(targetId)).catch(() => {
        // Errors are captured and logged inside controller
      });
    }, this.debounceMs);
    if (typeof timer.unref === "function") timer.unref();
    this.pendingTimers.set(targetId, timer);
  }

  stopAll() {
    for (const timer of this.pendingTimers.values()) {
      clearTimeout(timer);
    }
    this.pendingTimers.clear();
    for (const rec of this.dirWatchers.values()) {
      try {
        rec.watcher.close();
      } catch {}
    }
    this.dirWatchers.clear();
  }

  dispose() {
    this.disposed = true;
    this.stopAll();
    this.suppressedUntil.clear();
  }
}
