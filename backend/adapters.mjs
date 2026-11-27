/**
 * Multi-AI native MCP config adapters.
 *
 * Uses `os.homedir()` (OS-native lookup) so every path resolves reliably even when
 * CodexHost strips `process.env` in `ExtensionBackendProcess`.
 */

import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { cleanStringMap, normalizeTransport } from "../shared/models.mjs";
import { parseDshCordisMcpServers, updateDshCordisYaml } from "./dsh-yaml.mjs";
import { parseHermesMcpServers, updateHermesYaml } from "./hermes-yaml.mjs";
import { parseCodexMcpServers, updateCodexToml } from "./toml.mjs";

function claudeDesktopDefaultPath(home, platform) {
  if (platform === "win32") {
    return path.join(home, "AppData", "Roaming", "Claude", "claude_desktop_config.json");
  }
  if (platform === "darwin") {
    return path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  }
  return path.join(home, ".config", "Claude", "claude_desktop_config.json");
}

function devinDefaultPath(home, platform) {
  if (platform === "win32") {
    return path.join(home, "AppData", "Roaming", "devin", "mcp_config.json");
  }
  return path.join(home, ".config", "devin", "mcp_config.json");
}

function vscodeDefaultPath(home, platform) {
  if (platform === "win32") {
    return path.join(home, "AppData", "Roaming", "Code", "User", "mcp.json");
  }
  if (platform === "darwin") {
    return path.join(home, "Library", "Application Support", "Code", "User", "mcp.json");
  }
  return path.join(home, ".config", "Code", "User", "mcp.json");
}

/**
 * Parse JSON or JSONC (supports `//` line comments, block comments, and trailing commas),
 * as written natively by VS Code `mcp.json`.
 */
export function parseJsonc(text) {
  const src = String(text ?? "").replace(/^\uFEFF/, "");
  let stripped = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    const next = src[i + 1];
    if (inString) {
      stripped += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      stripped += ch;
      continue;
    }
    if (ch === "/" && next === "/") {
      i += 2;
      while (i < src.length && src[i] !== "\n") i++;
      if (i < src.length) stripped += "\n";
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      if (i >= src.length) throw new Error("Unterminated block comment in JSONC");
      i++;
      continue;
    }
    stripped += ch;
  }

  let clean = "";
  inString = false;
  escaped = false;
  for (let i = 0; i < stripped.length; i++) {
    const ch = stripped[i];
    if (inString) {
      clean += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      clean += ch;
      continue;
    }
    if (ch === ",") {
      let j = i + 1;
      while (j < stripped.length && /\s/.test(stripped[j])) j++;
      if (stripped[j] === "}" || stripped[j] === "]") {
        continue;
      }
    }
    clean += ch;
  }

  return JSON.parse(clean);
}

function parseTargetJson(text, format) {
  const trimmed = text.replace(/^\uFEFF/, "").trim();
  if (!trimmed) return {};
  return format === "vscode-json" ? parseJsonc(trimmed) : JSON.parse(trimmed);
}

/**
 * Built-in global AI Harness target descriptors.
 * `format`: "standard-json" | "antigravity-json" | "copilot-json" | "opencode-json" | "zcode-json" | "vscode-json" | "codex-toml" | "dsh-cordis-yaml" | "hermes-yaml"
 * `detectFiles`: strict indicator files proving the AI is genuinely installed locally
 * (never match shared parent folders like `~/.gemini` or empty `logs/` dirs).
 */
export function getBuiltinTargets(home = os.homedir(), platform = process.platform) {
  return [
    {
      id: "codex",
      name: "Codex",
      shortName: "Codex",
      format: "codex-toml",
      rootKey: "mcp_servers",
      defaultPath: path.join(home, ".codex", "config.toml"),
      detectFiles: [path.join(home, ".codex", "config.toml"), path.join(home, ".codex", "auth.json")],
    },
    {
      id: "pi",
      name: "Pi",
      shortName: "Pi",
      format: "standard-json",
      rootKey: "mcpServers",
      defaultPath: path.join(home, ".pi", "agent", "mcp.json"),
      detectFiles: [
        path.join(home, ".pi", "agent", "mcp.json"),
        path.join(home, ".pi", "agent", "settings.json"),
      ],
    },
    {
      id: "claude-code",
      name: "Claude Code",
      shortName: "Claude Code",
      format: "standard-json",
      rootKey: "mcpServers",
      defaultPath: path.join(home, ".claude.json"),
      detectFiles: [path.join(home, ".claude.json"), path.join(home, ".claude", "settings.json")],
    },
    {
      id: "antigravity",
      name: "Antigravity (agy)",
      shortName: "Antigravity",
      format: "antigravity-json",
      rootKey: "mcpServers",
      defaultPath: path.join(home, ".gemini", "config", "mcp_config.json"),
      detectFiles: [
        path.join(home, ".gemini", "config", "mcp_config.json"),
        path.join(home, ".gemini", "antigravity-cli", "settings.json"),
      ],
    },
    {
      id: "grok",
      name: "Grok",
      shortName: "Grok",
      format: "codex-toml",
      rootKey: "mcp_servers",
      defaultPath: path.join(home, ".grok", "config.toml"),
      detectFiles: [path.join(home, ".grok", "config.toml"), path.join(home, ".grok", "auth.json")],
    },
    {
      id: "cursor",
      name: "Cursor / Cursor CLI",
      shortName: "Cursor",
      format: "standard-json",
      rootKey: "mcpServers",
      defaultPath: path.join(home, ".cursor", "mcp.json"),
      detectFiles: [path.join(home, ".cursor", "mcp.json"), path.join(home, ".cursor", "argv.json")],
    },
    {
      id: "copilot",
      name: "GitHub Copilot CLI",
      shortName: "Copilot",
      format: "copilot-json",
      rootKey: "mcpServers",
      defaultPath: path.join(home, ".copilot", "mcp-config.json"),
      detectFiles: [
        path.join(home, ".copilot", "mcp-config.json"),
        path.join(home, ".copilot", "config.json"),
      ],
    },
    {
      id: "codebuddy",
      name: "CodeBuddy",
      shortName: "CodeBuddy",
      format: "standard-json",
      rootKey: "mcpServers",
      defaultPath: path.join(home, ".codebuddy", "mcp.json"),
      detectFiles: [
        path.join(home, ".codebuddy", "mcp.json"),
        path.join(home, ".codebuddy", "settings.json"),
      ],
    },
    {
      id: "claude-desktop",
      name: "Claude Desktop",
      shortName: "Claude Desktop",
      format: "standard-json",
      rootKey: "mcpServers",
      defaultPath: claudeDesktopDefaultPath(home, platform),
      detectFiles: [claudeDesktopDefaultPath(home, platform)],
    },
    {
      id: "opencode",
      name: "OpenCode",
      shortName: "OpenCode",
      format: "opencode-json",
      rootKey: "mcp",
      defaultPath: path.join(home, ".config", "opencode", "opencode.json"),
      detectFiles: [
        path.join(home, ".config", "opencode", "opencode.json"),
        path.join(home, ".local", "share", "opencode", "auth.json"),
      ],
    },
    {
      id: "qwen-code",
      name: "Qwen Code",
      shortName: "Qwen Code",
      format: "standard-json",
      rootKey: "mcpServers",
      defaultPath: path.join(home, ".qwen", "settings.json"),
      detectFiles: [path.join(home, ".qwen", "settings.json")],
    },
    {
      id: "gemini-cli",
      name: "Gemini CLI",
      shortName: "Gemini CLI",
      format: "standard-json",
      rootKey: "mcpServers",
      defaultPath: path.join(home, ".gemini", "settings.json"),
      detectFiles: [path.join(home, ".gemini", "settings.json")],
    },
    {
      id: "kiro",
      name: "Kiro CLI",
      shortName: "Kiro",
      format: "standard-json",
      rootKey: "mcpServers",
      defaultPath: path.join(home, ".kiro", "settings", "mcp.json"),
      detectFiles: [
        path.join(home, ".kiro", "settings", "mcp.json"),
        path.join(home, ".kiro", "settings", "cli.json"),
      ],
    },
    {
      id: "kimi",
      name: "Kimi Code",
      shortName: "Kimi",
      format: "standard-json",
      rootKey: "mcpServers",
      defaultPath: path.join(home, ".kimi", "mcp.json"),
      detectFiles: [path.join(home, ".kimi", "mcp.json"), path.join(home, ".kimi", "config.toml")],
    },
    {
      id: "workbuddy",
      name: "WorkBuddy",
      shortName: "WorkBuddy",
      format: "standard-json",
      rootKey: "mcpServers",
      defaultPath: path.join(home, ".workbuddy", "mcp.json"),
      detectFiles: [
        path.join(home, ".workbuddy", "mcp.json"),
        path.join(home, ".workbuddy", "settings.json"),
      ],
    },
    {
      id: "qoder",
      name: "Qoder",
      shortName: "Qoder",
      format: "standard-json",
      rootKey: "mcpServers",
      defaultPath: path.join(home, ".qoder", "settings.json"),
      detectFiles: [path.join(home, ".qoder", "settings.json"), path.join(home, ".qoder", "mcp.json")],
    },
    {
      id: "qoder-cn",
      name: "Qoder CN",
      shortName: "Qoder CN",
      format: "standard-json",
      rootKey: "mcpServers",
      defaultPath: path.join(home, ".qoder-cn", "settings.json"),
      detectFiles: [path.join(home, ".qoder-cn", "settings.json"), path.join(home, ".qoder-cn", "mcp.json")],
    },
    {
      id: "omp",
      name: "Oh My Pi",
      shortName: "OMP",
      format: "standard-json",
      rootKey: "mcpServers",
      defaultPath: path.join(home, ".omp", "agent", "mcp.json"),
      detectFiles: [
        path.join(home, ".omp", "agent", "mcp.json"),
        path.join(home, ".omp", "agent", "settings.json"),
        path.join(home, ".omp", "mcp.json"),
      ],
    },
    {
      id: "zcode",
      name: "ZCode",
      shortName: "ZCode",
      format: "zcode-json",
      rootKey: "mcp.servers",
      defaultPath: path.join(home, ".zcode", "cli", "config.json"),
      detectFiles: [path.join(home, ".zcode", "cli", "config.json"), path.join(home, ".zcode", "config.json")],
    },
    {
      id: "hermes",
      name: "Hermes",
      shortName: "Hermes",
      format: "hermes-yaml",
      rootKey: "mcp_servers",
      defaultPath: path.join(home, ".hermes", "config.yaml"),
      detectFiles: [path.join(home, ".hermes", "config.yaml"), path.join(home, ".hermes", ".env")],
    },
    {
      id: "devin",
      name: "Devin CLI",
      shortName: "Devin",
      format: "standard-json",
      rootKey: "mcpServers",
      defaultPath: devinDefaultPath(home, platform),
      detectFiles: [
        devinDefaultPath(home, platform),
        path.join(path.dirname(devinDefaultPath(home, platform)), "config.json"),
      ],
    },
    {
      id: "deepseek-desktop",
      name: "DeepSeek Desktop",
      shortName: "DeepSeek",
      format: "dsh-cordis-yaml",
      rootKey: "mcp-manager",
      defaultPath: path.join(home, ".dsh", "profiles", "desktop", "cordis.patch.yml"),
      detectFiles: [
        path.join(home, ".dsh", "profiles", "desktop", "cordis.patch.yml"),
        path.join(home, ".dsh", "profiles", "desktop", "package.json"),
      ],
    },
    {
      id: "deepseek-web",
      name: "DeepSeek Web",
      shortName: "DS Web",
      format: "dsh-cordis-yaml",
      rootKey: "mcp-manager",
      defaultPath: path.join(home, ".dsh", "profiles", "web", "cordis.patch.yml"),
      detectFiles: [
        path.join(home, ".dsh", "profiles", "web", "cordis.patch.yml"),
        path.join(home, ".dsh", "profiles", "web", "package.json"),
      ],
    },
    {
      id: "vscode",
      name: "VS Code",
      shortName: "VS Code",
      format: "vscode-json",
      rootKey: "servers",
      defaultPath: vscodeDefaultPath(home, platform),
      detectFiles: [
        vscodeDefaultPath(home, platform),
        path.join(path.dirname(vscodeDefaultPath(home, platform)), "settings.json"),
      ],
    },
  ];
}

export function getProjectTargetDescriptors(projectDir) {
  const dir = path.resolve(String(projectDir));
  return [
    {
      id: "project-mcp-json",
      name: "Claude / Standard (.mcp.json)",
      format: "standard-json",
      rootKey: "mcpServers",
      configPath: path.join(dir, ".mcp.json"),
    },
    {
      id: "project-cursor",
      name: "Cursor (.cursor/mcp.json)",
      format: "standard-json",
      rootKey: "mcpServers",
      configPath: path.join(dir, ".cursor", "mcp.json"),
    },
    {
      id: "project-codex",
      name: "Codex (.codex/config.toml)",
      format: "codex-toml",
      rootKey: "mcp_servers",
      configPath: path.join(dir, ".codex", "config.toml"),
    },
    {
      id: "project-opencode",
      name: "OpenCode (opencode.json)",
      format: "opencode-json",
      rootKey: "mcp",
      configPath: path.join(dir, "opencode.json"),
    },
    {
      id: "project-vscode",
      name: "VS Code (.vscode/mcp.json)",
      format: "vscode-json",
      rootKey: "servers",
      configPath: path.join(dir, ".vscode", "mcp.json"),
    },
  ];
}

async function pathExists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

export async function atomicWriteText(filePath, content) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.mcphub.tmp.${process.pid}.${Date.now()}`;
  await writeFile(tempPath, content, "utf8");
  try {
    await rename(tempPath, filePath);
  } catch {
    // Fallback on Windows if rename collides with a locked file
    try {
      await writeFile(filePath, content, "utf8");
    } finally {
      await rm(tempPath, { force: true }).catch(() => {});
    }
  }
}

/**
 * Convert canonical MCP Hub server to target-specific JSON entry.
 */
function serializeJsonEntry(server, format, existingEntry = null) {
  const t = server.transport;
  if (format === "opencode-json") {
    if (t.type === "stdio") {
      const env = cleanStringMap(t.env);
      return {
        type: "local",
        command: [t.command, ...(t.args ?? [])],
        ...(Object.keys(env).length ? { environment: env } : {}),
        enabled: server.enabled !== false,
      };
    }
    const headers = cleanStringMap(t.headers);
    return {
      type: "remote",
      url: t.url,
      ...(Object.keys(headers).length ? { headers } : {}),
      enabled: server.enabled !== false,
    };
  }

  if (format === "copilot-json") {
    const preservedTools =
      Array.isArray(existingEntry?.tools) && existingEntry.tools.length > 0
        ? existingEntry.tools
        : ["*"];
    if (t.type === "stdio") {
      const env = cleanStringMap(t.env);
      return {
        type: "local",
        command: t.command,
        ...(t.args?.length ? { args: t.args } : {}),
        ...(Object.keys(env).length ? { env } : {}),
        ...(t.cwd ? { cwd: t.cwd } : {}),
        tools: preservedTools,
      };
    }
    const headers = cleanStringMap(t.headers);
    return {
      type: t.type === "sse" ? "sse" : "http",
      url: t.url,
      ...(Object.keys(headers).length ? { headers } : {}),
      tools: preservedTools,
    };
  }

  if (format === "antigravity-json") {
    if (t.type === "stdio") {
      const env = cleanStringMap(t.env);
      return {
        command: t.command,
        ...(t.args?.length ? { args: t.args } : {}),
        ...(Object.keys(env).length ? { env } : {}),
        ...(t.cwd ? { cwd: t.cwd } : {}),
      };
    }
    const headers = cleanStringMap(t.headers);
    return {
      serverUrl: t.url,
      ...(Object.keys(headers).length ? { headers } : {}),
    };
  }

  if (format === "vscode-json") {
    const preserved = {};
    if (existingEntry && typeof existingEntry === "object" && !Array.isArray(existingEntry)) {
      for (const k of ["gallery", "version", "envFile", "oauth", "sandbox", "dev"]) {
        if (existingEntry[k] !== undefined) preserved[k] = existingEntry[k];
      }
    }
    if (t.type === "stdio") {
      const env = cleanStringMap(t.env);
      return {
        type: "stdio",
        command: t.command,
        ...(t.args?.length ? { args: t.args } : {}),
        ...(Object.keys(env).length ? { env } : {}),
        ...(t.cwd ? { cwd: t.cwd } : {}),
        ...preserved,
      };
    }
    const headers = cleanStringMap(t.headers);
    return {
      type: t.type === "sse" ? "sse" : "http",
      url: t.url,
      ...(Object.keys(headers).length ? { headers } : {}),
      ...preserved,
    };
  }

  if (format === "zcode-json") {
    if (t.type === "stdio") {
      const env = cleanStringMap(t.env);
      return {
        type: "stdio",
        command: t.command,
        ...(t.args?.length ? { args: t.args } : {}),
        ...(Object.keys(env).length ? { env } : {}),
        ...(t.cwd ? { cwd: t.cwd } : {}),
      };
    }
    const headers = cleanStringMap(t.headers);
    return {
      type: t.type === "sse" ? "sse" : "http",
      url: t.url,
      ...(Object.keys(headers).length ? { headers } : {}),
    };
  }

  // standard-json (Claude Code, Cursor, CodeBuddy, Claude Desktop, Qwen, Gemini, Kiro, Kimi, OMP, Devin, Qoder, etc.)
  if (t.type === "stdio") {
    const env = cleanStringMap(t.env);
    return {
      command: t.command,
      ...(t.args?.length ? { args: t.args } : {}),
      ...(Object.keys(env).length ? { env } : {}),
      ...(t.cwd ? { cwd: t.cwd } : {}),
    };
  }
  const headers = cleanStringMap(t.headers);
  return {
    type: t.type === "sse" ? "sse" : "http",
    url: t.url,
    ...(Object.keys(headers).length ? { headers } : {}),
  };
}

/**
 * Read a target config file and return normalized native MCP servers map.
 */
export async function readTargetConfig(target) {
  const filePath = target.configPath;
  const fileExists = await pathExists(filePath);
  let detected = fileExists;
  if (!detected && Array.isArray(target.detectFiles)) {
    for (const f of target.detectFiles) {
      if (await pathExists(f)) {
        detected = true;
        break;
      }
    }
  }

  if (!fileExists) {
    return {
      exists: false,
      detected,
      servers: {},
      rawText: "",
      error: null,
    };
  }

  let rawText = "";
  try {
    rawText = await readFile(filePath, "utf8");
  } catch (err) {
    return {
      exists: true,
      detected: true,
      servers: {},
      rawText: "",
      error: err instanceof Error ? err.message : String(err),
    };
  }

  if (target.format === "codex-toml") {
    try {
      return {
        exists: true,
        detected: true,
        servers: parseCodexMcpServers(rawText),
        rawText,
        error: null,
      };
    } catch (err) {
      return {
        exists: true,
        detected: true,
        servers: {},
        rawText,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  if (target.format === "dsh-cordis-yaml") {
    try {
      return {
        exists: true,
        detected: true,
        servers: parseDshCordisMcpServers(rawText),
        rawText,
        error: null,
      };
    } catch (err) {
      return {
        exists: true,
        detected: true,
        servers: {},
        rawText,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  if (target.format === "hermes-yaml") {
    try {
      return {
        exists: true,
        detected: true,
        servers: parseHermesMcpServers(rawText),
        rawText,
        error: null,
      };
    } catch (err) {
      return {
        exists: true,
        detected: true,
        servers: {},
        rawText,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // JSON / JSONC formats
  try {
    const doc = parseTargetJson(rawText, target.format);
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
      return {
        exists: true,
        detected: true,
        servers: {},
        rawText,
        error: "Config file root is not a JSON object",
      };
    }
    const rootKey = target.rootKey || "mcpServers";
    const section =
      target.format === "zcode-json"
        ? doc.mcp && typeof doc.mcp === "object" && !Array.isArray(doc.mcp) && doc.mcp.servers
          ? doc.mcp.servers
          : doc.mcpServers
        : doc[rootKey];
    const servers = {};
    if (section && typeof section === "object" && !Array.isArray(section)) {
      for (const [name, entry] of Object.entries(section)) {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
        try {
          servers[name] = {
            name,
            enabled: entry.enabled !== false && entry.disabled !== true,
            transport: normalizeTransport(entry),
          };
        } catch {
          // Ignore malformed single entry without breaking the rest of the file
        }
      }
    }
    return {
      exists: true,
      detected: true,
      servers,
      rawText,
      error: null,
    };
  } catch (err) {
    return {
      exists: true,
      detected: true,
      servers: {},
      rawText,
      error: `JSON parse error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Surgically write `upserts` (object `{ [name]: server }`) and `removals` (array of names)
 * to a target config file, preserving all unrelated keys/sections/comments.
 * Returns `{ nextText, hadOriginal, originalText }`.
 */
export async function applyTargetMutations(target, upserts, removals) {
  const filePath = target.configPath;
  const exists = await pathExists(filePath);
  const originalText = exists ? await readFile(filePath, "utf8") : "";

  let nextText;
  if (target.format === "codex-toml") {
    nextText = updateCodexToml(originalText, upserts, removals);
  } else if (target.format === "dsh-cordis-yaml") {
    nextText = updateDshCordisYaml(originalText, upserts, removals);
  } else if (target.format === "hermes-yaml") {
    nextText = updateHermesYaml(originalText, upserts, removals);
  } else if (target.format === "zcode-json") {
    const doc = parseTargetJson(originalText, target.format);
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
      throw new Error(`Refusing to overwrite non-object JSON file: ${filePath}`);
    }
    const existingMcp =
      doc.mcp && typeof doc.mcp === "object" && !Array.isArray(doc.mcp) ? { ...doc.mcp } : {};
    const section =
      existingMcp.servers && typeof existingMcp.servers === "object" && !Array.isArray(existingMcp.servers)
        ? { ...existingMcp.servers }
        : {};
    for (const name of removals) {
      delete section[name];
    }
    for (const [name, server] of Object.entries(upserts)) {
      section[name] = serializeJsonEntry(server, target.format, section[name]);
    }
    const nextDoc = { ...doc, mcp: { ...existingMcp, servers: section } };
    nextText = JSON.stringify(nextDoc, null, 2) + "\n";
  } else {
    const doc = parseTargetJson(originalText, target.format);
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
      throw new Error(`Refusing to overwrite non-object JSON file: ${filePath}`);
    }
    const rootKey = target.rootKey || "mcpServers";
    const section =
      doc[rootKey] && typeof doc[rootKey] === "object" && !Array.isArray(doc[rootKey])
        ? { ...doc[rootKey] }
        : {};

    for (const name of removals) {
      delete section[name];
    }
    for (const [name, server] of Object.entries(upserts)) {
      section[name] = serializeJsonEntry(server, target.format, section[name]);
    }

    const nextDoc = { ...doc, [rootKey]: section };
    nextText = JSON.stringify(nextDoc, null, 2) + "\n";
  }

  await atomicWriteText(filePath, nextText);
  return { nextText, hadOriginal: exists, originalText };
}
