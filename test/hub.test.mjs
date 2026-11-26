import assert from "node:assert/strict";
import http from "node:http";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { crc32, inflateRawSync } from "node:zlib";

import { atomicWriteText } from "../backend/adapters.mjs";
import { activate, createHubController } from "../backend/index.mjs";
import { probeMcpServer } from "../backend/probe.mjs";
import { parseCodexMcpServers, updateCodexToml } from "../backend/toml.mjs";
import { McpFileWatcher } from "../backend/watcher.mjs";
import { MESSAGES } from "../shared/i18n.mjs";
import { detectBuiltinMcp, isCodexhostLoopbackServer, parseMcpJsonInput } from "../shared/models.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

test("manifest.json conforms to codexhost manifestVersion 2 contract and assets are valid PNGs", async () => {
  const manifest = JSON.parse(await readFile(path.join(rootDir, "manifest.json"), "utf8"));
  assert.equal(manifest.manifestVersion, 2);
  assert.match(manifest.id, /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/);
  assert.ok(manifest.name.en && manifest.name["zh-CN"]);
  assert.ok(manifest.description.en && manifest.description["zh-CN"]);
  assert.ok(manifest.details.en && manifest.details["zh-CN"]);
  assert.ok(Array.isArray(manifest.categories) && manifest.categories.length > 0);
  assert.equal(manifest.page.apiVersion, 1);
  assert.equal(manifest.widget, undefined);
  assert.equal(manifest.backend.apiVersion, 1);
  assert.notEqual(manifest.backend.entry, manifest.page.entry);

  const pngSig = Buffer.from("89504e470d0a1a0a", "hex");
  const icon = await readFile(path.join(rootDir, manifest.icon));
  assert.ok(icon.subarray(0, 8).equals(pngSig), "icon.png must have valid PNG signature");
  assert.ok(icon.length <= 128 * 1024, "icon.png must be <= 128 KiB");

  for (const s of manifest.screenshots) {
    const buf = await readFile(path.join(rootDir, s));
    assert.ok(buf.subarray(0, 8).equals(pngSig), `${s} must have valid PNG signature`);
    assert.ok(buf.length <= 512 * 1024, `${s} must be <= 512 KiB`);
  }

  // Ensure all frontend & shared modules obey CSP / Desktop linker rules
  for (const rel of [
    manifest.page.entry,
    "page/dom.mjs",
    "page/modals.mjs",
    "page/tabs/servers.mjs",
    "page/tabs/targets.mjs",
    "page/tabs/autosync.mjs",
    "page/tabs/project-backups.mjs",
    "shared/models.mjs",
    "shared/i18n.mjs",
  ]) {
    const src = await readFile(path.join(rootDir, rel), "utf8");
    assert.doesNotMatch(src, /\beval\s*\(/, `${rel} must not use eval()`);
    assert.doesNotMatch(src, /\bnew\s+Function\s*\(/, `${rel} must not use new Function()`);
    assert.doesNotMatch(src, /\bimport\s*\(/, `${rel} must not use dynamic import()`);
  }
});

test("parseMcpJsonInput handles standard mcpServers, OpenCode mcp, bare objects, and loopback detection", () => {
  const fromStd = parseMcpJsonInput(
    JSON.stringify({
      mcpServers: {
        filesystem: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "D:\\Work"] },
        remoteApi: { type: "http", url: "https://example.com/mcp", headers: { Authorization: "Bearer tok" } },
      },
    }),
  );
  assert.equal(fromStd.length, 2);
  assert.equal(fromStd[0].transport.type, "stdio");
  assert.equal(fromStd[1].transport.type, "http");

  const fromOpenCode = parseMcpJsonInput(
    JSON.stringify({
      mcp: {
        localTool: { type: "local", command: ["uvx", "mcp-server-git"], environment: { GIT_DIR: "/tmp" } },
      },
    }),
  );
  assert.equal(fromOpenCode.length, 1);
  assert.equal(fromOpenCode[0].transport.command, "uvx");
  assert.deepEqual(fromOpenCode[0].transport.args, ["mcp-server-git"]);
  assert.deepEqual(fromOpenCode[0].transport.env, { GIT_DIR: "/tmp" });

  assert.equal(
    isCodexhostLoopbackServer("codexhost", { type: "http", url: "http://127.0.0.1:4398/mcp" }),
    true,
  );
  assert.equal(
    isCodexhostLoopbackServer("github", { type: "http", url: "https://api.githubcopilot.com/mcp/" }),
    false,
  );

  const codexRepl = detectBuiltinMcp("node_repl", {
    type: "stdio",
    command: "C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.1120.5083.0_x64__2p2nqsd0c76g0\\app\\resources\\cua_node\\bin\\node_repl.exe",
    args: [],
  });
  assert.equal(codexRepl.isBuiltin, true);
  assert.equal(codexRepl.vendor, "Codex");
  assert.equal(codexRepl.ownerTargetId, "codex");

  const magpie = detectBuiltinMcp("magpie-artifacts", {
    type: "stdio",
    command: "D:\\magpie\\magpie.exe",
    args: ["mcp", "artifacts"],
  });
  assert.equal(magpie.isBuiltin, false);
});

test("builtin vendor MCPs like Codex node_repl are excluded on import and protected from deletion on Codex", async () => {
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "mcp-hub-builtin-"));
  const fakeHome = path.join(tmpRoot, "home");
  const dataDir = path.join(tmpRoot, "data");
  await mkdir(path.join(fakeHome, ".codex"), { recursive: true });
  await mkdir(path.join(fakeHome, ".cursor"), { recursive: true });

  await writeFile(
    path.join(fakeHome, ".codex", "config.toml"),
    [
      "[mcp_servers.node_repl]",
      'command = "C:\\\\Program Files\\\\WindowsApps\\\\OpenAI.Codex_26.1120.5083.0_x64__2p2nqsd0c76g0\\\\app\\\\resources\\\\cua_node\\\\bin\\\\node_repl.exe"',
      "",
      "[mcp_servers.magpie-artifacts]",
      'command = "D:\\\\magpie\\\\magpie.exe"',
      'args = ["mcp", "artifacts"]',
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    path.join(fakeHome, ".cursor", "mcp.json"),
    JSON.stringify({
      mcpServers: {
        node_repl: {
          command: "C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.1120.5083.0_x64__2p2nqsd0c76g0\\app\\resources\\cua_node\\bin\\node_repl.exe",
        },
      },
    }),
    "utf8",
  );

  try {
    const hub = createHubController({
      dataDir,
      readSettings: async () => ({ excludeBuiltinMcp: true, autoBackup: false }),
      home: fakeHome,
      platform: "win32",
    });

    // Import from Codex skips node_repl automatically
    const imp = await hub.importFromTarget({
      sourceTargetId: "codex",
      assignTargets: ["codex", "cursor"],
    });
    assert.equal(imp.added, 1);
    assert.equal(imp.skippedBuiltin, 1);
    assert.deepEqual(
      imp.overview.servers.map((s) => s.name),
      ["magpie-artifacts"],
    );

    // Even if node_repl was previously marked managed on BOTH codex and cursor (e.g. from v1.0.0),
    // syncing should remove it from cursor while protecting it in codex!
    const statePath = path.join(dataDir, "hub-state.json");
    const rawState = JSON.parse(await readFile(statePath, "utf8"));
    rawState.managedKeysByTarget.codex = ["node_repl", "magpie-artifacts"];
    rawState.managedKeysByTarget.cursor = ["node_repl"];
    await writeFile(statePath, JSON.stringify(rawState, null, 2), "utf8");

    const preview = await hub.previewSync();
    const codexDiff = preview.diffs.find((d) => d.targetId === "codex");
    const cursorDiff = preview.diffs.find((d) => d.targetId === "cursor");
    assert.deepEqual(codexDiff.removes, []);
    assert.ok(codexDiff.preservedUnmanaged.includes("node_repl"));
    assert.deepEqual(cursorDiff.removes, ["node_repl"]);

    await hub.applySync();
    const codexAfter = parseCodexMcpServers(
      await readFile(path.join(fakeHome, ".codex", "config.toml"), "utf8"),
    );
    const cursorAfter = JSON.parse(
      await readFile(path.join(fakeHome, ".cursor", "mcp.json"), "utf8"),
    );
    assert.ok(codexAfter.node_repl, "node_repl must remain intact in Codex config.toml");
    assert.equal(cursorAfter.mcpServers.node_repl, undefined, "node_repl should be cleaned from Cursor");
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
});

test("v1.1.0 as-is import produces 0 pending changes, scopes managed targets to existing files, and computes 4-state targetStatuses", async () => {
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "mcp-hub-v110-"));
  const fakeHome = path.join(tmpRoot, "home");
  const dataDir = path.join(tmpRoot, "data");
  await mkdir(path.join(fakeHome, ".codex"), { recursive: true });
  await mkdir(path.join(fakeHome, ".gemini", "config"), { recursive: true });
  // Empty dir only (no settings.json) -> should NOT be auto-enabled as managed target!
  await mkdir(path.join(fakeHome, ".qoder-cn"), { recursive: true });

  await writeFile(
    path.join(fakeHome, ".codex", "config.toml"),
    [
      "[mcp_servers.ssh-mcp]",
      'command = "node"',
      'args = ["ssh.mjs"]',
      "",
      "[mcp_servers.notion]",
      'url = "https://mcp.notion.com/mcp"',
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    path.join(fakeHome, ".gemini", "config", "mcp_config.json"),
    JSON.stringify({
      mcpServers: {
        "ssh-mcp": { command: "node", args: ["ssh.mjs"] },
      },
    }),
    "utf8",
  );

  try {
    const hub = createHubController({
      dataDir,
      readSettings: async () => ({ excludeBuiltinMcp: true, autoBackup: false }),
      home: fakeHome,
      platform: "win32",
    });

    const ov0 = await hub.buildOverview();
    const enabledIds = ov0.targets.filter((t) => t.enabled).map((t) => t.id).sort();
    assert.deepEqual(enabledIds, ["antigravity", "codex"]);
    assert.equal(ov0.targets.find((t) => t.id === "qoder").enabled, false);
    assert.equal(ov0.summary.newImportableCount, 2);

    // As-is import without assignTargets -> 0 unexpected pending changes!
    const imp = await hub.importFromTarget({ sourceTargetId: "all" });
    assert.equal(imp.added, 2);
    assert.equal(imp.overview.summary.pendingChanges, 0);

    const ssh = imp.overview.servers.find((s) => s.name === "ssh-mcp");
    const notion = imp.overview.servers.find((s) => s.name === "notion");
    assert.deepEqual([...ssh.targets].sort(), ["antigravity", "codex"]);
    assert.deepEqual(notion.targets, ["codex"]);
    assert.equal(ssh.targetStatuses.codex, "synced");
    assert.equal(ssh.targetStatuses.antigravity, "synced");
    assert.equal(notion.targetStatuses.codex, "synced");
    assert.equal(notion.targetStatuses.antigravity, "off");

    // Toggle notion ON for antigravity -> pending-add; toggle ssh OFF for antigravity -> pending-remove
    await hub.setServerTargets({ id: notion.id, targets: ["codex", "antigravity"] });
    const ov1 = await hub.setServerTargets({ id: ssh.id, targets: ["codex"] });
    assert.equal(ov1.servers.find((s) => s.id === notion.id).targetStatuses.antigravity, "pending-add");
    assert.equal(ov1.servers.find((s) => s.id === ssh.id).targetStatuses.antigravity, "pending-remove");
    assert.equal(ov1.summary.pendingChanges, 2);

    // Strict detection: ~/.gemini/config exists, so antigravity is detected, NOT gemini-cli;
    // ~/.qoder-cn empty dir does NOT falsely detect qoder!
    assert.equal(ov1.targets.find((t) => t.id === "gemini-cli").detected, false);
    assert.equal(ov1.targets.find((t) => t.id === "qoder").detected, false);

    // Adding Pi and Grok configs causes them to auto-detect and become active automatically on next scan
    await mkdir(path.join(fakeHome, ".pi", "agent"), { recursive: true });
    await writeFile(
      path.join(fakeHome, ".pi", "agent", "mcp.json"),
      JSON.stringify({ mcpServers: { playwright: { command: "npx", args: ["-y", "pw-mcp"] } } }),
      "utf8",
    );
    await mkdir(path.join(fakeHome, ".grok"), { recursive: true });
    await writeFile(
      path.join(fakeHome, ".grok", "config.toml"),
      '[mcp_servers.grok_tool]\ncommand = "node"\nargs = ["g.js"]\n',
      "utf8",
    );
    const ov3 = await hub.buildOverview();
    const pi = ov3.targets.find((t) => t.id === "pi");
    const grok = ov3.targets.find((t) => t.id === "grok");
    assert.equal(pi.detected, true);
    assert.equal(pi.enabled, true);
    assert.equal(pi.nativeCount, 1);
    assert.equal(grok.detected, true);
    assert.equal(grok.enabled, true);
    assert.equal(grok.nativeCount, 1);

    // v1.3.0: auto-enable when assigning targets to a disabled MCP + batch-targets add/remove
    await hub.toggleServer({ id: ssh.id, enabled: false });
    const afterSingle = await hub.setServerTargets({
      id: ssh.id,
      targets: ["codex", "pi"],
      autoEnable: true,
    });
    const sshReenabled = afterSingle.servers.find((s) => s.id === ssh.id);
    assert.equal(sshReenabled.enabled, true);
    assert.deepEqual([...sshReenabled.targets].sort(), ["codex", "pi"]);

    const batchAdd = await hub.batchUpdateTargets({
      ids: [ssh.id, notion.id],
      targetIds: ["antigravity", "pi"],
      mode: "add",
    });
    assert.equal(batchAdd.affected, 2);
    assert.ok(batchAdd.overview.servers.find((s) => s.id === notion.id).targets.includes("pi"));
    assert.ok(batchAdd.overview.servers.find((s) => s.id === notion.id).targets.includes("antigravity"));

    const batchRemove = await hub.batchUpdateTargets({
      ids: [ssh.id, notion.id],
      targetIds: ["pi"],
      mode: "remove",
    });
    assert.equal(batchRemove.affected, 2);
    assert.equal(batchRemove.overview.servers.find((s) => s.id === ssh.id).targets.includes("pi"), false);
    assert.equal(batchRemove.overview.servers.find((s) => s.id === notion.id).targets.includes("pi"), false);
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
});

test("v2.0.0 applySingleServer, revertSingleServer, and batchApplyTargets with skipExisting overwrite guard", async () => {
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "mcp-hub-v200-"));
  const fakeHome = path.join(tmpRoot, "home");
  const dataDir = path.join(tmpRoot, "data");
  await mkdir(path.join(fakeHome, ".codex"), { recursive: true });
  await mkdir(path.join(fakeHome, ".cursor"), { recursive: true });
  await mkdir(path.join(fakeHome, ".pi", "agent"), { recursive: true });

  await writeFile(
    path.join(fakeHome, ".codex", "config.toml"),
    [
      "[mcp_servers.notion]",
      'url = "https://mcp.notion.com/mcp"',
      "",
      "[mcp_servers.ssh-mcp]",
      'command = "node"',
      'args = ["ssh.mjs"]',
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    path.join(fakeHome, ".cursor", "mcp.json"),
    JSON.stringify({ mcpServers: { keep_native: { command: "node", args: ["keep.js"] } } }),
    "utf8",
  );
  // Pi already has a DIFFERENTLY configured `notion`!
  await writeFile(
    path.join(fakeHome, ".pi", "agent", "mcp.json"),
    JSON.stringify({ mcpServers: { notion: { command: "npx", args: ["-y", "custom-notion-local"] } } }),
    "utf8",
  );

  try {
    const hub = createHubController({
      dataDir,
      readSettings: async () => ({ autoBackup: true, excludeBuiltinMcp: true }),
      home: fakeHome,
      platform: "win32",
    });

    const imp = await hub.importFromTarget({ sourceTargetId: "codex" });
    const notion = imp.overview.servers.find((s) => s.name === "notion");
    const ssh = imp.overview.servers.find((s) => s.name === "ssh-mcp");

    // Stage pending edits on BOTH notion and ssh, then apply ONLY notion!
    await hub.setServerTargets({ id: notion.id, targets: ["codex", "cursor"] });
    await hub.setServerTargets({ id: ssh.id, targets: ["codex", "cursor"] });

    const singleRes = await hub.applySingleServer({ id: notion.id });
    assert.equal(singleRes.updatedCount, 1);
    const cursorAfterSingle = JSON.parse(
      await readFile(path.join(fakeHome, ".cursor", "mcp.json"), "utf8"),
    );
    assert.ok(cursorAfterSingle.mcpServers.notion, "notion should be written to Cursor");
    assert.equal(cursorAfterSingle.mcpServers["ssh-mcp"], undefined, "ssh-mcp must NOT be written yet");
    assert.ok(cursorAfterSingle.mcpServers.keep_native, "unmanaged native entry must be preserved");

    // Revert ssh back to synced-only
    const afterRevert = await hub.revertSingleServer({ id: ssh.id });
    assert.deepEqual(afterRevert.servers.find((s) => s.id === ssh.id).targets, ["codex"]);

    // Batch Add both notion & ssh to Cursor & Pi with skipExisting = true:
    // Pi's differently-configured `notion` must be SKIPPED and preserved!
    const batchSafe = await hub.batchApplyTargets({
      ids: [notion.id, ssh.id],
      targetIds: ["cursor", "pi"],
      mode: "add",
      skipExisting: true,
    });
    assert.equal(batchSafe.skippedCount, 1);
    const piAfterSafe = JSON.parse(
      await readFile(path.join(fakeHome, ".pi", "agent", "mcp.json"), "utf8"),
    );
    assert.equal(piAfterSafe.mcpServers.notion.command, "npx", "Pi custom notion must be preserved");
    assert.equal(piAfterSafe.mcpServers["ssh-mcp"].command, "node", "ssh-mcp should be added to Pi");

    // Batch Add with skipExisting = false overwrites Pi's notion (with backup)
    const batchForce = await hub.batchApplyTargets({
      ids: [notion.id],
      targetIds: ["pi"],
      mode: "add",
      skipExisting: false,
    });
    assert.equal(batchForce.updatedCount, 1);
    const piAfterForce = JSON.parse(
      await readFile(path.join(fakeHome, ".pi", "agent", "mcp.json"), "utf8"),
    );
    assert.equal(piAfterForce.mcpServers.notion.url, "https://mcp.notion.com/mcp");

    // Batch Remove removes selected servers from Cursor while preserving keep_native
    const batchRm = await hub.batchApplyTargets({
      ids: [notion.id, ssh.id],
      targetIds: ["cursor"],
      mode: "remove",
    });
    assert.equal(batchRm.updatedCount, 1);
    const cursorAfterRm = JSON.parse(
      await readFile(path.join(fakeHome, ".cursor", "mcp.json"), "utf8"),
    );
    assert.equal(cursorAfterRm.mcpServers.notion, undefined);
    assert.equal(cursorAfterRm.mcpServers["ssh-mcp"], undefined);
    assert.ok(cursorAfterRm.mcpServers.keep_native);
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
});

test("v2.1.0 imports all same-name MCP config variants with automatic aliases and clean ownership transfer", async () => {
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "mcp-hub-v210-"));
  const fakeHome = path.join(tmpRoot, "home");
  const dataDir = path.join(tmpRoot, "data");
  await mkdir(path.join(fakeHome, ".codex"), { recursive: true });
  await mkdir(path.join(fakeHome, ".pi", "agent"), { recursive: true });
  await mkdir(path.join(fakeHome, ".cursor"), { recursive: true });

  // Codex has HTTP `github`, Pi has stdio `github` (same name, DIFFERENT config!)
  await writeFile(
    path.join(fakeHome, ".codex", "config.toml"),
    '[mcp_servers.github]\nurl = "https://api.githubcopilot.com/mcp/"\n',
    "utf8",
  );
  await writeFile(
    path.join(fakeHome, ".pi", "agent", "mcp.json"),
    JSON.stringify({
      mcpServers: {
        github: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] },
      },
    }),
    "utf8",
  );
  await writeFile(
    path.join(fakeHome, ".cursor", "mcp.json"),
    JSON.stringify({ mcpServers: {} }),
    "utf8",
  );

  try {
    const hub = createHubController({
      dataDir,
      readSettings: async () => ({ autoBackup: true, excludeBuiltinMcp: true }),
      home: fakeHome,
      platform: "win32",
    });

    // 1. Overview discovers BOTH variants of `github` with suggested aliases!
    const ov0 = await hub.buildOverview();
    const ghCandidates = ov0.importCandidates.filter((c) => c.name === "github");
    assert.equal(ghCandidates.length, 2);
    assert.ok(ghCandidates.every((c) => c.hasVariants === true));
    assert.deepEqual(ghCandidates.map((c) => c.suggestedAlias).sort(), ["Codex", "Pi"]);

    // 2. Import ALL variants -> creates 2 cards with aliases, 0 pending changes!
    const imp = await hub.importFromTarget({
      sourceTargetId: "all",
      selectedVariants: ghCandidates.map((c) => c.variantKey),
    });
    assert.equal(imp.added, 2);
    assert.equal(imp.overview.summary.pendingChanges, 0);

    const ghCodex = imp.overview.servers.find((s) => s.name === "github" && s.alias === "Codex");
    const ghPi = imp.overview.servers.find((s) => s.name === "github" && s.alias === "Pi");
    assert.ok(ghCodex && ghPi);
    // Same-name variants must be grouped adjacently in overview.servers
    await hub.saveServer({
      name: "alpha-tool",
      enabled: true,
      transport: { type: "http", url: "https://alpha.example.com/mcp" },
      targets: [],
    });
    const ovGrouped = await hub.saveServer({
      name: "zeta-tool",
      enabled: true,
      transport: { type: "http", url: "https://zeta.example.com/mcp" },
      targets: [],
    });
    assert.deepEqual(
      ovGrouped.servers.map((s) => s.name),
      ["alpha-tool", "github", "github", "zeta-tool"],
      "Same-name MCP variants must be sorted and grouped adjacently",
    );
    assert.equal(ghCodex.targetStatuses.codex, "synced");
    assert.equal(ghCodex.targetStatuses.pi, "off");
    assert.equal(ghPi.targetStatuses.pi, "synced");
    assert.equal(ghPi.targetStatuses.codex, "off");

    // 3. Apply Codex variant to Cursor -> Cursor gets HTTP, Pi keeps stdio untouched!
    await hub.setServerTargets({ id: ghCodex.id, targets: ["codex", "cursor"] });
    const applyCursor = await hub.applySingleServer({ id: ghCodex.id });
    assert.equal(applyCursor.updatedCount, 1);
    const cursorCfg = JSON.parse(await readFile(path.join(fakeHome, ".cursor", "mcp.json"), "utf8"));
    const piCfg = JSON.parse(await readFile(path.join(fakeHome, ".pi", "agent", "mcp.json"), "utf8"));
    assert.equal(cursorCfg.mcpServers.github.url, "https://api.githubcopilot.com/mcp/");
    assert.equal(piCfg.mcpServers.github.command, "npx");

    // 4. Explicitly choose Pi on Codex variant -> shows amber `pending-update`, applying transfers ownership,
    //    auto-removes the superseded empty Pi variant, and clears the redundant auto-alias on the sole survivor!
    const stagedOverwrite = await hub.setServerTargets({
      id: ghCodex.id,
      targets: ["codex", "cursor", "pi"],
    });
    assert.equal(
      stagedOverwrite.servers.find((s) => s.id === ghCodex.id).targetStatuses.pi,
      "pending-update",
    );
    const appliedTransfer = await hub.applySingleServer({ id: ghCodex.id });
    assert.equal(appliedTransfer.updatedCount, 1);
    assert.equal(appliedTransfer.overview.summary.pendingChanges, 0);
    const survivor = appliedTransfer.overview.servers.find((s) => s.id === ghCodex.id);
    assert.equal(survivor.targetStatuses.pi, "synced");
    assert.equal(survivor.alias, "", "Sole surviving variant should clear redundant auto-alias");
    assert.equal(
      appliedTransfer.overview.servers.find((s) => s.id === ghPi.id),
      undefined,
      "Superseded empty same-name variant should be auto-removed",
    );
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
});

test("surgical Codex TOML parser & updater preserves comments, model settings, and unmanaged MCPs", () => {
  const original = [
    "# Top comment must survive",
    'model = "gpt-5.4"',
    "",
    "[mcp_servers.keep_me]",
    'command = "node"',
    'args = ["keep.js"]',
    "",
    '[mcp_servers."ssh-mcp-server"]',
    'command = "npx"',
    'args = ["-y", "ssh-mcp"]',
    "",
    '[mcp_servers."ssh-mcp-server".env]',
    'SSH_HOST = "10.0.0.1"',
    "",
    "[profiles.fast]",
    'model_reasoning_effort = "low"',
    "",
  ].join("\n");

  const parsed = parseCodexMcpServers(original);
  assert.equal(Object.keys(parsed).length, 2);
  assert.equal(parsed["ssh-mcp-server"].transport.env.SSH_HOST, "10.0.0.1");

  const updated = updateCodexToml(
    original,
    {
      "ssh-mcp-server": {
        enabled: true,
        transport: { type: "stdio", command: "npx", args: ["-y", "ssh-mcp@2"], env: { SSH_HOST: "10.0.0.2" } },
      },
      notion: {
        enabled: true,
        transport: { type: "http", url: "https://mcp.notion.com/mcp", headers: { "X-Team": "eng" } },
      },
    },
    [],
  );

  assert.ok(updated.includes("# Top comment must survive"));
  assert.ok(updated.includes('model = "gpt-5.4"'));
  assert.ok(updated.includes("[profiles.fast]"));
  assert.ok(updated.includes("[mcp_servers.keep_me]"));
  assert.ok(updated.includes('SSH_HOST = "10.0.0.2"'));
  assert.ok(updated.includes('url = "https://mcp.notion.com/mcp"'));

  const reparsed = parseCodexMcpServers(updated);
  assert.equal(Object.keys(reparsed).length, 3);
  assert.deepEqual(reparsed["ssh-mcp-server"].transport.args, ["-y", "ssh-mcp@2"]);
  assert.equal(reparsed.notion.transport.url, "https://mcp.notion.com/mcp");
  assert.equal(reparsed.notion.transport.headers["X-Team"], "eng");

  // Removing managed entry must not touch keep_me
  const afterRemove = updateCodexToml(updated, {}, ["notion"]);
  const reparsed2 = parseCodexMcpServers(afterRemove);
  assert.equal(reparsed2.notion, undefined);
  assert.ok(reparsed2.keep_me);
});

test("end-to-end HubController: scan, import, sync across Codex/Claude/AGY/OpenCode, preserve unmanaged, backup & restore", async () => {
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "mcp-hub-test-"));
  const fakeHome = path.join(tmpRoot, "home");
  const dataDir = path.join(tmpRoot, "data");
  const projectDir = path.join(tmpRoot, "project");
  await mkdir(path.join(fakeHome, ".codex"), { recursive: true });
  await mkdir(path.join(fakeHome, ".gemini", "config"), { recursive: true });
  await mkdir(path.join(fakeHome, ".cursor"), { recursive: true });
  await mkdir(path.join(fakeHome, ".config", "opencode"), { recursive: true });
  await mkdir(projectDir, { recursive: true });

  // Seed existing native files with unmanaged entries and unrelated fields
  const origCodex = '# My Codex\nmodel = "o3"\n\n[mcp_servers.handcrafted]\ncommand = "node"\nargs = ["hand.js"]\n';
  await writeFile(path.join(fakeHome, ".codex", "config.toml"), origCodex, "utf8");
  await writeFile(
    path.join(fakeHome, ".claude.json"),
    JSON.stringify(
      {
        userID: "u-123",
        mcpServers: {
          "existing-tool": { command: "npx", args: ["-y", "existing-mcp"] },
          codexhost: { type: "http", url: "http://127.0.0.1:4398/mcp" },
        },
      },
      null,
      2,
    ),
    "utf8",
  );
  await writeFile(
    path.join(fakeHome, ".gemini", "config", "mcp_config.json"),
    JSON.stringify({ mcpServers: {} }, null, 2),
    "utf8",
  );
  await writeFile(
    path.join(fakeHome, ".config", "opencode", "opencode.json"),
    JSON.stringify({ theme: "dark", mcp: {} }, null, 2),
    "utf8",
  );

  try {
    const settings = { autoBackup: true, skipLoopbackCodexhost: true, httpProbeTimeoutMs: 2000 };
    const hub = createHubController({
      dataDir,
      readSettings: async () => settings,
      home: fakeHome,
      platform: "win32",
    });

    // 1. Scan & import from Claude Code
    const imported = await hub.importFromTarget({
      sourceTargetId: "claude-code",
      assignTargets: ["codex", "claude-code", "antigravity", "opencode"],
    });
    assert.equal(imported.added, 2);

    // Loopback server should NOT be auto-assigned to codex/antigravity/opencode
    const loopback = imported.overview.servers.find((s) => s.name === "codexhost");
    assert.equal(loopback.isLoopback, true);
    assert.deepEqual(loopback.targets, ["claude-code"]);

    // 2. Add a new HTTP MCP assigned to Codex, Antigravity, OpenCode
    await hub.saveServer({
      name: "docs-http",
      description: "Remote docs",
      enabled: true,
      transport: { type: "http", url: "https://docs.example.com/mcp", headers: { "X-Key": "abc" } },
      targets: ["codex", "antigravity", "opencode"],
    });

    // 3. Preview & apply sync
    const preview = await hub.previewSync();
    const codexDiff = preview.diffs.find((d) => d.targetId === "codex");
    assert.deepEqual(codexDiff.adds.sort(), ["docs-http", "existing-tool"]);
    assert.deepEqual(codexDiff.preservedUnmanaged, ["handcrafted"]);

    const syncRes = await hub.applySync();
    assert.equal(syncRes.errorCount, 0);
    assert.ok(syncRes.updatedCount >= 3);

    // Verify files written on disk
    const nextCodex = await readFile(path.join(fakeHome, ".codex", "config.toml"), "utf8");
    assert.ok(nextCodex.includes("# My Codex"));
    assert.ok(nextCodex.includes("[mcp_servers.handcrafted]"));
    assert.ok(nextCodex.includes("[mcp_servers.docs-http]"));

    const nextAgy = JSON.parse(
      await readFile(path.join(fakeHome, ".gemini", "config", "mcp_config.json"), "utf8"),
    );
    assert.equal(nextAgy.mcpServers["docs-http"].serverUrl, "https://docs.example.com/mcp");
    assert.equal(nextAgy.mcpServers["existing-tool"].command, "npx");

    const nextOpenCode = JSON.parse(
      await readFile(path.join(fakeHome, ".config", "opencode", "opencode.json"), "utf8"),
    );
    assert.equal(nextOpenCode.theme, "dark");
    assert.equal(nextOpenCode.mcp["existing-tool"].type, "local");
    assert.deepEqual(nextOpenCode.mcp["existing-tool"].command, ["npx", "-y", "existing-mcp"]);
    assert.equal(nextOpenCode.mcp["docs-http"].type, "remote");
    assert.equal(nextOpenCode.mcp["docs-http"].url, "https://docs.example.com/mcp");

    // 4. Disable `docs-http` and sync -> should remove managed key, keep unmanaged `handcrafted`
    const docsServer = syncRes.overview.servers.find((s) => s.name === "docs-http");
    await hub.toggleServer({ id: docsServer.id, enabled: false });
    await hub.applySync();

    const codexAfterDisable = parseCodexMcpServers(
      await readFile(path.join(fakeHome, ".codex", "config.toml"), "utf8"),
    );
    assert.equal(codexAfterDisable["docs-http"], undefined);
    assert.ok(codexAfterDisable.handcrafted);
    assert.ok(codexAfterDisable["existing-tool"]);

    // 5. Backups & restore
    const { backups } = await hub.listBackups();
    const codexBackups = backups.filter((b) => b.targetId === "codex");
    assert.ok(codexBackups.length >= 1);
    const oldestCodex = codexBackups[codexBackups.length - 1];
    await hub.restoreBackup({ backupId: oldestCodex.id });
    const restoredCodex = await readFile(path.join(fakeHome, ".codex", "config.toml"), "utf8");
    assert.equal(restoredCodex, origCodex);

    // 6. Project-level sync
    const projRes = await hub.syncProject({
      projectDir,
      formatIds: ["project-mcp-json", "project-codex", "project-opencode"],
    });
    assert.equal(projRes.results.filter((r) => r.status === "updated").length, 3);
    const projJson = JSON.parse(await readFile(path.join(projectDir, ".mcp.json"), "utf8"));
    assert.ok(projJson.mcpServers["existing-tool"]);
    assert.equal(projJson.mcpServers.codexhost, undefined, "Loopback MCP should not be exported to project");

    // 7. HTTP probe with ephemeral server
    const server = http.createServer((req, res) => {
      if (req.url === "/auth") {
        res.writeHead(401);
        res.end("unauthorized");
      } else {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }));
      }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    try {
      const okProbe = await hub.probeServer({
        server: { transport: { type: "http", url: `http://127.0.0.1:${port}/mcp` } },
      });
      assert.equal(okProbe.ok, true);
      assert.equal(okProbe.needsAuth, false);

      const authProbe = await hub.probeServer({
        server: { transport: { type: "http", url: `http://127.0.0.1:${port}/auth` } },
      });
      assert.equal(authProbe.ok, true);
      assert.equal(authProbe.needsAuth, true);
    } finally {
      server.close();
    }

    // 8. Backend activate(ctx) contract check
    const registered = new Map();
    const dispose = await activate({
      extensionId: "mcp-sync-hub",
      extensionDir: rootDir,
      dataDir,
      readSettings: async () => settings,
      writeSettings: async (v) => v,
      handle: (method, fn) => registered.set(method, fn),
    });
    assert.ok(registered.has("overview"));
    assert.ok(registered.has("sync/apply"));
    assert.equal(typeof dispose, "function");
    await dispose();
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
});

test("packed dist zip passes CodexHost ZIP structure and CRC verification", async () => {
  const manifest = JSON.parse(await readFile(path.join(rootDir, "manifest.json"), "utf8"));
  const zipPath = path.join(rootDir, "dist", `${manifest.id}-${manifest.version}.zip`);
  const zip = await readFile(zipPath);
  const u16 = (off) => zip.readUInt16LE(off);
  const u32 = (off) => zip.readUInt32LE(off);

  // Locate EOCD
  let eocd = zip.length - 22;
  while (eocd >= 0 && u32(eocd) !== 0x06054b50) eocd--;
  assert.ok(eocd >= 0, "EOCD signature missing");
  const count = u16(eocd + 10);
  const cdStart = u32(eocd + 16);
  const cdSize = u32(eocd + 12);
  assert.equal(cdStart + cdSize, eocd, "Central directory bounds invalid");
  assert.ok(count >= 10);

  const names = new Set();
  let cur = cdStart;
  for (let i = 0; i < count; i++) {
    assert.equal(u32(cur), 0x02014b50);
    const method = u16(cur + 10);
    const crc = u32(cur + 16);
    const compSize = u32(cur + 20);
    const uncompSize = u32(cur + 24);
    const nameLen = u16(cur + 28);
    const localOff = u32(cur + 42);
    const name = zip.subarray(cur + 46, cur + 46 + nameLen).toString("utf8");
    assert.ok(!name.includes("\\"), `Backslash in ZIP entry: ${name}`);
    names.add(name);

    assert.equal(u32(localOff), 0x04034b50);
    const dataOff = localOff + 30 + nameLen + u16(localOff + 28);
    const comp = zip.subarray(dataOff, dataOff + compSize);
    const raw = method === 0 ? comp : inflateRawSync(comp);
    assert.equal(raw.length, uncompSize);
    assert.equal(crc32(raw) >>> 0, crc);
    cur += 46 + nameLen + u16(cur + 30) + u16(cur + 32);
  }

  assert.ok(names.has("manifest.json"), "manifest.json must be at ZIP root");
  assert.ok(names.has("page/index.mjs"));
  assert.ok(names.has("page/dom.mjs"));
  assert.ok(names.has("page/modals.mjs"));
  assert.ok(names.has("page/tabs/servers.mjs"));
  assert.ok(names.has("page/tabs/targets.mjs"));
  assert.ok(names.has("page/tabs/autosync.mjs"));
  assert.ok(names.has("page/tabs/project-backups.mjs"));
  assert.equal(names.has("widget/index.mjs"), false);
  assert.ok(names.has("backend/index.mjs"));
  assert.ok(names.has("backend/watcher.mjs"));
  assert.ok(names.has("assets/icon.png"));
  assert.ok(names.has("assets/preview.png"));
});

test("v2.3.0 regression checks: unique same-ms backups, custom target owner cleanup, and project sync variant deduplication", async () => {
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "mcp-hub-v230-"));
  const fakeHome = path.join(tmpRoot, "home");
  const dataDir = path.join(tmpRoot, "data");
  const projectDir = path.join(tmpRoot, "project");
  const customPath = path.join(tmpRoot, "custom-agent.json");
  await mkdir(fakeHome, { recursive: true });
  await mkdir(projectDir, { recursive: true });
  await writeFile(customPath, JSON.stringify({ mcpServers: {} }), "utf8");

  try {
    const hub = createHubController({
      dataDir,
      readSettings: async () => ({ autoBackup: true, excludeBuiltinMcp: true }),
      home: fakeHome,
      platform: "win32",
    });

    // 1. Add custom target, apply an MCP, then remove custom target -> managedOwnersByTarget must be cleaned
    const ov1 = await hub.addCustomTarget({ name: "MyAgent", configPath: customPath, rootKey: "mcpServers" });
    const customTarget = ov1.targets.find((t) => t.custom);
    assert.ok(customTarget);

    await hub.saveServer({
      name: "shared-tool",
      alias: "Alt",
      enabled: true,
      transport: { type: "http", url: "https://alt.example.com/mcp" },
      targets: [],
    });
    const ov2 = await hub.saveServer({
      name: "shared-tool",
      alias: "",
      enabled: true,
      transport: { type: "http", url: "https://primary.example.com/mcp" },
      targets: [customTarget.id],
    });
    const primarySrv = ov2.servers.find((s) => s.name === "shared-tool" && !s.alias);
    await hub.applySingleServer({ id: primarySrv.id });

    // Rapid consecutive project syncs produce distinct backup IDs
    await hub.syncProject({ projectDir, formatIds: ["project-mcp-json"] });
    const projRes2 = await hub.syncProject({ projectDir, formatIds: ["project-mcp-json"] });
    const projRes3 = await hub.syncProject({ projectDir, formatIds: ["project-mcp-json"] });
    assert.deepEqual(projRes2.duplicateNames, ["shared-tool"]);
    assert.deepEqual(projRes3.duplicateNames, ["shared-tool"]);

    const projJson = JSON.parse(await readFile(path.join(projectDir, ".mcp.json"), "utf8"));
    assert.equal(
      projJson.mcpServers["shared-tool"].url,
      "https://primary.example.com/mcp",
      "Project sync should prefer unaliased primary variant deterministically",
    );

    const { backups } = await hub.listBackups();
    const projBackups = backups.filter((b) => b.targetId === "project-mcp-json");
    assert.ok(projBackups.length >= 2, "Consecutive backups must not overwrite each other");
    assert.equal(new Set(projBackups.map((b) => b.id)).size, projBackups.length);

    // Removing custom target cleans managedKeysByTarget and managedOwnersByTarget
    await hub.removeCustomTarget({ targetId: customTarget.id });
    const rawState = JSON.parse(await readFile(path.join(dataDir, "hub-state.json"), "utf8"));
    assert.equal(rawState.managedKeysByTarget[customTarget.id], undefined);
    assert.equal(rawState.managedOwnersByTarget[customTarget.id], undefined);
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
});

test("v2.4.0 auto-sync: existing-only scope, selected MCP filter, primary mode, builtin guard, and mass-wipe breaker", async () => {
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "mcp-hub-v240-"));
  const fakeHome = path.join(tmpRoot, "home");
  const dataDir = path.join(tmpRoot, "data");
  await mkdir(path.join(fakeHome, ".codex"), { recursive: true });
  await mkdir(path.join(fakeHome, ".cursor"), { recursive: true });
  await mkdir(path.join(fakeHome, ".pi", "agent"), { recursive: true });

  const codexFile = path.join(fakeHome, ".codex", "config.toml");
  const cursorFile = path.join(fakeHome, ".cursor", "mcp.json");
  const piFile = path.join(fakeHome, ".pi", "agent", "mcp.json");

  await writeFile(
    codexFile,
    [
      "[mcp_servers.notion]",
      'url = "https://mcp.notion.com/mcp"',
      "",
      "[mcp_servers.ssh-mcp]",
      'command = "node"',
      'args = ["ssh-v1.mjs"]',
      "",
    ].join("\n"),
    "utf8",
  );
  // Cursor has BOTH notion and ssh-mcp; Pi ONLY has ssh-mcp (no notion)
  await writeFile(
    cursorFile,
    JSON.stringify(
      {
        mcpServers: {
          notion: { url: "https://mcp.notion.com/mcp" },
          "ssh-mcp": { command: "node", args: ["ssh-v1.mjs"] },
        },
      },
      null,
      2,
    ),
    "utf8",
  );
  await writeFile(
    piFile,
    JSON.stringify(
      {
        mcpServers: {
          "ssh-mcp": { command: "node", args: ["ssh-v1.mjs"] },
        },
      },
      null,
      2,
    ),
    "utf8",
  );

  const hub = createHubController({
    dataDir,
    readSettings: async () => ({ autoBackup: true, excludeBuiltinMcp: true }),
    home: fakeHome,
    platform: "win32",
    watchDebounceMs: 80,
  });

  try {
    await hub.importFromTarget({ sourceTargetId: "all" });

    // Enable bidirectional auto-sync with existing-only updateScope & all MCPs
    await hub.setAutoSyncConfig({
      enabled: true,
      mode: "bidirectional",
      updateScope: "existing-only",
      mcpScope: "all",
      targetIds: ["codex", "cursor", "pi"],
      syncAdditions: true,
      syncUpdates: true,
      syncRemovals: false,
    });

    // 1. Edit `notion` in Codex -> should update Cursor (already has notion), NOT install into Pi!
    await writeFile(
      codexFile,
      [
        "[mcp_servers.notion]",
        'url = "https://mcp.notion.com/mcp-v2"',
        "",
        "[mcp_servers.ssh-mcp]",
        'command = "node"',
        'args = ["ssh-v1.mjs"]',
        "",
      ].join("\n"),
      "utf8",
    );
    const res1 = await hub.handleWatchedTargetChange("codex");
    assert.equal(res1.propagated, 1);

    const cursorAfter1 = JSON.parse(await readFile(cursorFile, "utf8"));
    const piAfter1 = JSON.parse(await readFile(piFile, "utf8"));
    assert.equal(cursorAfter1.mcpServers.notion.url, "https://mcp.notion.com/mcp-v2");
    assert.equal(piAfter1.mcpServers.notion, undefined, "existing-only must NOT add notion to Pi");

    // 2. Restrict mcpScope to ONLY `notion` -> editing `ssh-mcp` in Codex must NOT propagate
    await hub.setAutoSyncConfig({ mcpScope: "selected", selectedMcpNames: ["notion"] });
    await writeFile(
      codexFile,
      [
        "[mcp_servers.notion]",
        'url = "https://mcp.notion.com/mcp-v2"',
        "",
        "[mcp_servers.ssh-mcp]",
        'command = "node"',
        'args = ["ssh-v2.mjs"]',
        "",
      ].join("\n"),
      "utf8",
    );
    const res2 = await hub.handleWatchedTargetChange("codex");
    assert.equal(res2.propagated, 0);
    const cursorAfter2 = JSON.parse(await readFile(cursorFile, "utf8"));
    assert.deepEqual(cursorAfter2.mcpServers["ssh-mcp"].args, ["ssh-v1.mjs"]);

    // 3. Primary mode (codex) -> editing `notion` in Cursor must NOT propagate back to Codex
    await hub.setAutoSyncConfig({ mode: "primary", primaryTargetId: "codex", mcpScope: "all" });
    cursorAfter2.mcpServers.notion.url = "https://mcp.notion.com/cursor-only";
    await writeFile(cursorFile, JSON.stringify(cursorAfter2, null, 2), "utf8");
    const res3 = await hub.handleWatchedTargetChange("cursor");
    assert.equal(res3.propagated, 0);
    const codexAfter3 = parseCodexMcpServers(await readFile(codexFile, "utf8"));
    assert.equal(codexAfter3.notion.transport.url, "https://mcp.notion.com/mcp-v2");

    // 4. Add a new MCP `figma` AND vendor builtin `node_repl` in Codex -> figma propagates, node_repl is skipped
    await writeFile(
      codexFile,
      [
        "[mcp_servers.notion]",
        'url = "https://mcp.notion.com/mcp-v2"',
        "",
        "[mcp_servers.ssh-mcp]",
        'command = "node"',
        'args = ["ssh-v2.mjs"]',
        "",
        "[mcp_servers.figma]",
        'url = "https://mcp.figma.com/mcp"',
        "",
        "[mcp_servers.node_repl]",
        'command = "C:\\\\Program Files\\\\WindowsApps\\\\OpenAI.Codex_26.1\\\\app\\\\resources\\\\cua_node\\\\bin\\\\node_repl.exe"',
        "",
      ].join("\n"),
      "utf8",
    );
    const res4 = await hub.handleWatchedTargetChange("codex");
    assert.equal(res4.propagated, 2);
    const piAfter4 = JSON.parse(await readFile(piFile, "utf8"));
    assert.equal(piAfter4.mcpServers.figma.url, "https://mcp.figma.com/mcp");
    assert.equal(piAfter4.mcpServers.node_repl, undefined, "Builtin node_repl must never propagate");

    // 5. Broken JSON in Cursor is blocked cleanly without throwing or overwriting peers
    await hub.setAutoSyncConfig({ mode: "bidirectional", syncRemovals: true });
    await writeFile(cursorFile, "{ broken json !!!", "utf8");
    const resBroken = await hub.handleWatchedTargetChange("cursor");
    assert.equal(resBroken.blocked, "parse-error");

    // 6. Mass-wipe circuit breaker: emptying all MCPs in Codex at once must be blocked
    await writeFile(codexFile, '# wiped\nmodel = "gpt-5"\n', "utf8");
    const resWipe = await hub.handleWatchedTargetChange("codex");
    assert.equal(resWipe.blocked, "mass-wipe-guard");
    const piAfterWipe = JSON.parse(await readFile(piFile, "utf8"));
    assert.ok(piAfterWipe.mcpServers.figma, "Mass-wipe guard must protect peer AIs");
  } finally {
    hub.dispose();
    await rm(tmpRoot, { recursive: true, force: true });
  }
});

test("McpFileWatcher: real fs.watch debounce coalescing, atomic rename saves, self-write suppression, and target updates", async () => {
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "mcp-hub-watcher-"));
  const dirA = path.join(tmpRoot, "dirA");
  const dirB = path.join(tmpRoot, "dirB");
  await mkdir(dirA, { recursive: true });
  await mkdir(dirB, { recursive: true });
  const fileA = path.join(dirA, "mcp.json");
  const fileB = path.join(dirB, "config.json");
  await writeFile(fileA, "{}", "utf8");
  await writeFile(fileB, "{}", "utf8");

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (pred, timeoutMs = 2000) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (pred()) return true;
      await sleep(30);
    }
    return false;
  };

  const events = [];
  const watcher = new McpFileWatcher({
    debounceMs: 80,
    onTargetChanged: (id) => {
      events.push(id);
    },
  });

  try {
    watcher.setTargets([{ id: "alpha", configPath: fileA }]);
    assert.equal(watcher.dirWatchers.size, 1);

    // 1. Rapid burst writes + atomic rename coalesce into 1 notification; unrelated sibling files are ignored
    await writeFile(path.join(dirA, "unrelated.json"), '{"x":1}', "utf8");
    await writeFile(fileA, '{"v":1}', "utf8");
    await atomicWriteText(fileA, '{"v":2}');
    const gotFirst = await waitFor(() => events.length >= 1);
    assert.equal(gotFirst, true, "Watcher should trigger on atomic rename write");
    await sleep(140);
    assert.deepEqual(events, ["alpha"], "Burst writes should coalesce into a single debounced event");

    // 2. Self-write suppression ignores writes during holdMs window
    events.length = 0;
    watcher.markSelfWrite("alpha", 500);
    await atomicWriteText(fileA, '{"v":3}');
    await sleep(220);
    assert.deepEqual(events, [], "Suppressed self-write must not trigger callback");

    // 3. Dynamically updating targets adds dirB and closes dirA cleanly
    watcher.setTargets([{ id: "beta", configPath: fileB }]);
    assert.equal(watcher.dirWatchers.size, 1);
    await atomicWriteText(fileB, '{"b":1}');
    const gotBeta = await waitFor(() => events.includes("beta"));
    assert.equal(gotBeta, true, "Updated target directory should trigger watcher");

    // Verify no leftover .mcphub.tmp.* files exist after atomic writes
    const filesInA = await readdir(dirA);
    const filesInB = await readdir(dirB);
    assert.equal(filesInA.some((f) => f.includes(".mcphub.tmp.")), false);
    assert.equal(filesInB.some((f) => f.includes(".mcphub.tmp.")), false);
  } finally {
    watcher.dispose();
    assert.equal(watcher.dirWatchers.size, 0);
    await rm(tmpRoot, { recursive: true, force: true });
  }
});

test("auto-sync advanced branches & regressions: single removal, broadcast scope, variant isolation, dynamic watcher refresh, and backup suffix matching", async () => {
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "mcp-hub-adv-"));
  const fakeHome = path.join(tmpRoot, "home");
  const dataDir = path.join(tmpRoot, "data");
  await mkdir(path.join(fakeHome, ".codex"), { recursive: true });
  await mkdir(path.join(fakeHome, ".pi", "agent"), { recursive: true });
  await mkdir(path.join(fakeHome, ".copilot"), { recursive: true });

  const codexFile = path.join(fakeHome, ".codex", "config.toml");
  const piFile = path.join(fakeHome, ".pi", "agent", "mcp.json");
  const copilotFile = path.join(fakeHome, ".copilot", "mcp-config.json");

  // Codex and Pi share `shared_mcp` (same config) AND have DIFFERENT variants of `github`;
  // Copilot initially has neither.
  await writeFile(
    codexFile,
    [
      "[mcp_servers.shared_mcp]",
      'url = "https://shared.example.com/v1"',
      "",
      "[mcp_servers.github]",
      'url = "https://github.codex.example.com/mcp"',
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    piFile,
    JSON.stringify(
      {
        mcpServers: {
          shared_mcp: { url: "https://shared.example.com/v1" },
          github: { command: "npx", args: ["-y", "local-github-mcp"] },
        },
      },
      null,
      2,
    ),
    "utf8",
  );
  await writeFile(copilotFile, JSON.stringify({ mcpServers: {} }, null, 2), "utf8");

  const hub = createHubController({
    dataDir,
    readSettings: async () => ({ autoBackup: true, excludeBuiltinMcp: true }),
    home: fakeHome,
    platform: "win32",
    watchDebounceMs: 60,
  });

  try {
    await hub.importFromTarget({ sourceTargetId: "all" });

    // Enable auto-sync with broadcast scope (all-selected) and syncRemovals = true
    const ovOn = await hub.setAutoSyncConfig({
      enabled: true,
      mode: "bidirectional",
      updateScope: "all-selected",
      mcpScope: "all",
      targetIds: ["codex", "pi", "copilot"],
      syncAdditions: true,
      syncUpdates: true,
      syncRemovals: true,
    });
    assert.equal(ovOn.autoSync.watchingCount, 3);

    // 1. Update `shared_mcp` in Codex with `all-selected` -> updates Pi AND broadcasts to Copilot!
    await writeFile(
      codexFile,
      [
        "[mcp_servers.shared_mcp]",
        'url = "https://shared.example.com/v2"',
        "",
        "[mcp_servers.github]",
        'url = "https://github.codex.example.com/mcp-v2"',
        "",
      ].join("\n"),
      "utf8",
    );
    await hub.handleWatchedTargetChange("codex");

    const piAfterUpdate = JSON.parse(await readFile(piFile, "utf8"));
    const copilotAfterUpdate = JSON.parse(await readFile(copilotFile, "utf8"));
    assert.equal(piAfterUpdate.mcpServers.shared_mcp.url, "https://shared.example.com/v2");
    assert.equal(copilotAfterUpdate.mcpServers.shared_mcp.url, "https://shared.example.com/v2");
    // Variant isolation: Pi's distinct stdio `github` must NOT be overwritten by Codex's HTTP `github`!
    assert.equal(
      piAfterUpdate.mcpServers.github.command,
      "npx",
      "Distinct same-name variant on Pi must remain isolated",
    );

    // 2. Single-MCP removal (`syncRemovals: true`): remove `shared_mcp` from Codex -> removes from Pi & Copilot
    await writeFile(
      codexFile,
      [
        "[mcp_servers.github]",
        'url = "https://github.codex.example.com/mcp-v2"',
        "",
      ].join("\n"),
      "utf8",
    );
    const rmRes = await hub.handleWatchedTargetChange("codex");
    assert.equal(rmRes.propagated, 2);
    const piAfterRm = JSON.parse(await readFile(piFile, "utf8"));
    const copilotAfterRm = JSON.parse(await readFile(copilotFile, "utf8"));
    assert.equal(piAfterRm.mcpServers.shared_mcp, undefined);
    assert.equal(copilotAfterRm.mcpServers.shared_mcp, undefined);
    assert.equal(piAfterRm.mcpServers.github.command, "npx");

    // 3. Adding & removing a custom target dynamically updates active watcher count
    const customDir = path.join(tmpRoot, "custom-agent-dir");
    await mkdir(customDir, { recursive: true });
    const customFile = path.join(customDir, "mcp.json");
    await writeFile(customFile, JSON.stringify({ mcpServers: {} }), "utf8");
    await hub.setAutoSyncConfig({ targetIds: null });
    const ovAddCustom = await hub.addCustomTarget({ name: "CustomWatch", configPath: customFile });
    assert.equal(ovAddCustom.autoSync.watchingCount, 4);
    const customId = ovAddCustom.targets.find((t) => t.custom).id;
    const ovRmCustom = await hub.removeCustomTarget({ targetId: customId });
    assert.equal(ovRmCustom.autoSync.watchingCount, 3);

    // 4. Restoring a `copilot` backup succeeds cleanly without falsely matching `pi` substring
    const { backups } = await hub.listBackups();
    const copilotBackup = backups.find((b) => b.targetId === "copilot");
    assert.ok(copilotBackup);
    const restored = await hub.restoreBackup({ backupId: copilotBackup.id });
    assert.equal(restored.restored.targetId, "copilot");
  } finally {
    hub.dispose();
    await rm(tmpRoot, { recursive: true, force: true });
  }
});

test("i18n dictionaries have 1:1 zh-CN/en key parity and all frontend t() calls resolve to defined keys", async () => {
  const zhKeys = new Set(Object.keys(MESSAGES["zh-CN"]));
  const enKeys = new Set(Object.keys(MESSAGES.en));

  const missingInEn = [...zhKeys].filter((k) => !enKeys.has(k));
  const missingInZh = [...enKeys].filter((k) => !zhKeys.has(k));
  assert.deepEqual(missingInEn, [], `Keys missing in en dictionary: ${missingInEn.join(", ")}`);
  assert.deepEqual(missingInZh, [], `Keys missing in zh-CN dictionary: ${missingInZh.join(", ")}`);

  const pageFiles = [
    "page/index.mjs",
    "page/modals.mjs",
    "page/tabs/servers.mjs",
    "page/tabs/targets.mjs",
    "page/tabs/autosync.mjs",
    "page/tabs/project-backups.mjs",
  ];
  const unknownKeys = [];
  for (const rel of pageFiles) {
    const src = await readFile(path.join(rootDir, rel), "utf8");
    for (const m of src.matchAll(/\bt\(\s*["']([a-zA-Z0-9_]+)["']/g)) {
      const key = m[1];
      if (!zhKeys.has(key) || !enKeys.has(key)) {
        unknownKeys.push(`${rel}: ${key}`);
      }
    }
  }
  assert.deepEqual(unknownKeys, [], `Undefined i18n keys referenced in page/: ${unknownKeys.join(", ")}`);
});

test("v2.5.0: copilot-json format (type:local + tools preservation), persistent auto-sync logs, target raw viewer, and stdio arg path probe", async () => {
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "mcp-hub-v250-"));
  const fakeHome = path.join(tmpRoot, "home");
  const dataDir = path.join(tmpRoot, "data");
  await mkdir(path.join(fakeHome, ".copilot"), { recursive: true });
  await mkdir(path.join(fakeHome, ".codex"), { recursive: true });

  const copilotFile = path.join(fakeHome, ".copilot", "mcp-config.json");
  const codexFile = path.join(fakeHome, ".codex", "config.toml");
  const fakeScript = path.join(tmpRoot, "server-entry.js");
  const missingScript = path.join(tmpRoot, "does-not-exist.js");
  await writeFile(fakeScript, "// ok\n", "utf8");

  // Seed Copilot with an existing entry that has custom `tools: ["read_only"]`
  await writeFile(
    copilotFile,
    JSON.stringify(
      {
        mcpServers: {
          custom_tools_mcp: {
            type: "local",
            command: process.execPath,
            args: [fakeScript],
            tools: ["read_only"],
          },
        },
      },
      null,
      2,
    ),
    "utf8",
  );
  await writeFile(codexFile, '# Codex header\nmodel = "gpt-5"\n', "utf8");

  const hub1 = createHubController({
    dataDir,
    readSettings: async () => ({ autoBackup: false, excludeBuiltinMcp: true }),
    home: fakeHome,
    platform: "win32",
  });

  try {
    await hub1.importFromTarget({ sourceTargetId: "all" });

    // 1. Add stdio + http MCPs targeting Copilot -> writes official type: "local"/"http" + tools: ["*"]
    const ov1 = await hub1.saveServer({
      name: "new_stdio",
      enabled: true,
      transport: { type: "stdio", command: process.execPath, args: [fakeScript] },
      targets: ["copilot"],
    });
    const ov2 = await hub1.saveServer({
      name: "new_remote",
      enabled: true,
      transport: { type: "http", url: "https://mcp.example.com/v1" },
      targets: ["copilot"],
    });
    // Update existing `custom_tools_mcp` args while expecting custom `tools: ["read_only"]` to survive
    const existingSrv = ov2.servers.find((s) => s.name === "custom_tools_mcp");
    await hub1.saveServer({
      id: existingSrv.id,
      name: existingSrv.name,
      enabled: true,
      transport: { type: "stdio", command: process.execPath, args: [fakeScript, "--flag"] },
      targets: ["copilot"],
    });

    await hub1.applySync();
    const copilotAfter = JSON.parse(await readFile(copilotFile, "utf8"));
    assert.equal(copilotAfter.mcpServers.new_stdio.type, "local");
    assert.deepEqual(copilotAfter.mcpServers.new_stdio.tools, ["*"]);
    assert.equal(copilotAfter.mcpServers.new_remote.type, "http");
    assert.deepEqual(copilotAfter.mcpServers.new_remote.tools, ["*"]);
    assert.equal(copilotAfter.mcpServers.custom_tools_mcp.type, "local");
    assert.deepEqual(
      copilotAfter.mcpServers.custom_tools_mcp.tools,
      ["read_only"],
      "Existing custom Copilot tools allowlist must be preserved on update",
    );

    // 2. Read raw config via targets/read-raw
    const rawCodex = await hub1.readTargetRaw({ targetId: "codex" });
    assert.equal(rawCodex.exists, true);
    assert.ok(rawCodex.rawText.includes("# Codex header"));
    await assert.rejects(() => hub1.readTargetRaw({ targetId: "nonexistent-target" }));

    // 3. Persistent auto-sync logs survive controller restart
    await hub1.setAutoSyncConfig({
      enabled: true,
      mode: "bidirectional",
      targetIds: ["codex", "copilot"],
      syncAdditions: true,
      syncUpdates: true,
    });
    await writeFile(
      codexFile,
      '# Codex header\nmodel = "gpt-5"\n\n[mcp_servers.fresh_mcp]\nurl = "https://fresh.example.com/mcp"\n',
      "utf8",
    );
    await hub1.handleWatchedTargetChange("codex");
    hub1.dispose();

    const hub2 = createHubController({
      dataDir,
      readSettings: async () => ({ autoBackup: false, excludeBuiltinMcp: true }),
      home: fakeHome,
      platform: "win32",
    });
    try {
      const ovReloaded = await hub2.buildOverview();
      assert.ok(
        ovReloaded.autoSyncLogs.some((l) => l.mcpName === "fresh_mcp" && l.action === "add"),
        "Auto-sync logs must persist across backend restarts",
      );
      await hub2.clearAutoSyncLogs();
      const ovCleared = await hub2.buildOverview();
      assert.equal(ovCleared.autoSyncLogs.length, 0);
    } finally {
      hub2.dispose();
    }

    // 4. Enhanced stdio probe checks local absolute file paths inside `args`
    const probeOk = await hub1.probeServer({
      server: { transport: { type: "stdio", command: process.execPath, args: [fakeScript] } },
    });
    assert.equal(probeOk.ok, true);
    assert.ok(probeOk.detail.includes("1 local file(s) verified"));

    const probeMissingArg = await hub1.probeServer({
      server: { transport: { type: "stdio", command: process.execPath, args: ["--config", missingScript] } },
    });
    assert.equal(probeMissingArg.ok, false);
    assert.ok(probeMissingArg.error.includes("Referenced file not found"));
  } finally {
    hub1.dispose();
    await rm(tmpRoot, { recursive: true, force: true });
  }
});

test("v2.5.1: probeMcpServer reports toolCount & toolNames for Streamable HTTP (JSON + SSE + session) and stdio MCP handshakes", async () => {
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "mcp-hub-v251-"));
  const mockStdioScript = path.join(tmpRoot, "mock-mcp-stdio.mjs");
  await writeFile(
    mockStdioScript,
    [
      'process.stdin.setEncoding("utf8");',
      'let buf = "";',
      'process.stdin.on("data", (chunk) => {',
      '  buf += chunk;',
      '  let idx;',
      '  while ((idx = buf.indexOf("\\n")) !== -1) {',
      '    const line = buf.slice(0, idx).trim();',
      '    buf = buf.slice(idx + 1);',
      '    if (!line) continue;',
      '    const msg = JSON.parse(line);',
      '    if (msg.method === "initialize") {',
      '      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "mock" } } }) + "\\n");',
      '    } else if (msg.method === "tools/list") {',
      '      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "alpha_tool" }, { name: "beta_tool" }, { name: "gamma_tool" }] } }) + "\\n");',
      '    }',
      '  }',
      '});',
    ].join("\n"),
    "utf8",
  );

  // Ephemeral Streamable HTTP server supporting both JSON and SSE responses with mcp-session-id
  const httpServer = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
    });
    req.on("end", () => {
      const msg = raw ? JSON.parse(raw) : {};
      if (req.url === "/mcp-json") {
        if (msg.method === "initialize") {
          res.writeHead(200, { "Content-Type": "application/json", "mcp-session-id": "sess-123" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05" } }));
        } else if (msg.method === "notifications/initialized") {
          res.writeHead(202);
          res.end();
        } else if (msg.method === "tools/list") {
          assert.equal(req.headers["mcp-session-id"], "sess-123");
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: msg.id,
              result: { tools: [{ name: "http_search" }, { name: "http_fetch" }] },
            }),
          );
        }
      } else if (req.url === "/mcp-sse") {
        if (msg.method === "initialize") {
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} })}\n\n`);
        } else if (msg.method === "notifications/initialized") {
          res.writeHead(202);
          res.end();
        } else if (msg.method === "tools/list") {
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          res.end(
            `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "sse_tool_1" }] } })}\n\n`,
          );
        }
      }
    });
  });

  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const port = httpServer.address().port;

  try {
    // 1. stdio real MCP handshake returns exact toolCount & toolNames
    const stdioRes = await probeMcpServer(
      { transport: { type: "stdio", command: process.execPath, args: [mockStdioScript] } },
      4000,
    );
    assert.equal(stdioRes.ok, true);
    assert.equal(stdioRes.toolCount, 3);
    assert.deepEqual(stdioRes.toolNames, ["alpha_tool", "beta_tool", "gamma_tool"]);

    // 2. Streamable HTTP JSON response with session header
    const httpJsonRes = await probeMcpServer(
      { transport: { type: "http", url: `http://127.0.0.1:${port}/mcp-json` } },
      4000,
    );
    assert.equal(httpJsonRes.ok, true);
    assert.equal(httpJsonRes.toolCount, 2);
    assert.deepEqual(httpJsonRes.toolNames, ["http_search", "http_fetch"]);

    // 3. Streamable HTTP SSE-formatted response
    const httpSseRes = await probeMcpServer(
      { transport: { type: "http", url: `http://127.0.0.1:${port}/mcp-sse` } },
      4000,
    );
    assert.equal(httpSseRes.ok, true);
    assert.equal(httpSseRes.toolCount, 1);
    assert.deepEqual(httpSseRes.toolNames, ["sse_tool_1"]);
  } finally {
    httpServer.close();
    await rm(tmpRoot, { recursive: true, force: true });
  }
});
