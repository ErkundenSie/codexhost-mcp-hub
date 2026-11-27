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

/**
 * Built-in global AI Harness target descriptors.
 * `format`: "standard-json" | "antigravity-json" | "copilot-json" | "opencode-json" | "codex-toml" | "dsh-cordis-yaml"
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
      defaultPath: path.join(home, ".qoder-cn", "mcp.json"),
      detectFiles: [path.join(home, ".qoder-cn", "mcp.json"), path.join(home, ".qoder", "mcp.json")],
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

  // standard-json (Claude Code, Cursor, Copilot, CodeBuddy, Claude Desktop, Qwen, Gemini, Kiro, Kimi, etc.)
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
    return {
      exists: true,
      detected: true,
      servers: parseCodexMcpServers(rawText),
      rawText,
      error: null,
    };
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

  // JSON formats
  try {
    const trimmed = rawText.trim();
    const doc = trimmed ? JSON.parse(trimmed) : {};
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
    const section = doc[rootKey];
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
  } else {
    const trimmed = originalText.trim();
    let doc = {};
    if (trimmed) {
      doc = JSON.parse(trimmed);
      if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
        throw new Error(`Refusing to overwrite non-object JSON file: ${filePath}`);
      }
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
