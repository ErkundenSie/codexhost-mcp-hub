/**
 * Surgical YAML parser & updater for Hermes Agent (`~/.hermes/config.yaml`) `mcp_servers` mapping.
 *
 * Preserves every unrelated top-level setting, comment, anchor, and formatting byte-for-byte
 * while updating only the `mcp_servers:` section. Zero external dependencies.
 */

import { cleanStringMap, normalizeTransport } from "../shared/models.mjs";
import {
  isDashItemStart,
  measureIndent,
  parseYamlBlock,
  serializeYamlNode,
  splitKeyValue,
  stripYamlInlineComment,
} from "./dsh-yaml.mjs";

const STDIO_KEYS = new Set(["command", "args", "env", "cwd"]);
const HTTP_KEYS = new Set(["url", "headers"]);

/**
 * Split a top-level YAML mapping document (`~/.hermes/config.yaml`) into lossless sections,
 * locating the `mcp_servers` block (if any) without parsing unrelated top-level keys.
 * Throws if the non-empty file is not a YAML mapping (e.g. a sequence or tab-indented syntax).
 */
function locateHermesMcpSection(yamlText) {
  let text = String(yamlText ?? "");
  if (text.startsWith("\uFEFF")) text = text.slice(1);
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  if (!text.trim()) {
    return { eol, lines: [], sectionStart: -1, sectionEnd: -1, isEmptyFlow: false };
  }

  const lines = text.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }

  let firstContentIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed === "" || trimmed.startsWith("#") || trimmed === "---") continue;
    firstContentIdx = i;
    break;
  }

  if (firstContentIdx === -1) {
    return { eol, lines, sectionStart: -1, sectionEnd: -1, isEmptyFlow: false };
  }

  const firstStripped = stripYamlInlineComment(lines[firstContentIdx]).trim();
  if (firstStripped === "{}") {
    for (let k = firstContentIdx + 1; k < lines.length; k++) {
      const tr = lines[k].trim();
      if (tr !== "" && !tr.startsWith("#") && tr !== "...") {
        throw new Error(`YAML parse error at line ${k + 1}: unexpected content after empty mapping {}`);
      }
    }
    return {
      eol,
      lines: lines.slice(0, firstContentIdx),
      sectionStart: -1,
      sectionEnd: -1,
      isEmptyFlow: true,
    };
  }

  const firstIndent = measureIndent(lines[firstContentIdx], firstContentIdx + 1);
  if (firstIndent !== 0 || isDashItemStart(firstStripped) || !splitKeyValue(firstStripped)) {
    throw new Error(
      `YAML parse error at line ${firstContentIdx + 1}: Hermes config.yaml root must be a YAML mapping`,
    );
  }

  let sectionStart = -1;
  let sectionEnd = -1;
  let lastContentInSection = -1;

  for (let i = firstContentIdx; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed === "" || line.startsWith("#") || trimmed === "...") {
      continue;
    }

    const indent = measureIndent(line, i + 1);
    const stripped = stripYamlInlineComment(line).trim();

    if (indent === 0) {
      if (sectionStart !== -1 && sectionEnd === -1) {
        sectionEnd = lastContentInSection + 1;
      }
      if (isDashItemStart(stripped)) {
        throw new Error(`YAML parse error at line ${i + 1}: unexpected top-level sequence item in YAML mapping`);
      }
      const kv = splitKeyValue(stripped);
      if (!kv) {
        throw new Error(`YAML parse error at line ${i + 1}: expected top-level "key: value" mapping`);
      }
      if (kv.key === "mcp_servers") {
        sectionStart = i;
        sectionEnd = -1;
        lastContentInSection = i;
      }
    } else if (sectionStart !== -1 && sectionEnd === -1) {
      lastContentInSection = i;
    }
  }

  if (sectionStart !== -1 && sectionEnd === -1) {
    sectionEnd = lastContentInSection + 1;
  }

  return { eol, lines, sectionStart, sectionEnd, isEmptyFlow: false };
}

/**
 * Parse all `mcp_servers.<name>` entries from a Hermes `~/.hermes/config.yaml` file.
 * Returns `{ [name]: { name, enabled, transport } }`.
 */
export function parseHermesMcpServers(yamlText) {
  const { lines, sectionStart, sectionEnd } = locateHermesMcpSection(yamlText);
  if (sectionStart === -1) return {};

  const blockLines = lines.slice(sectionStart, sectionEnd);
  const parsed = parseYamlBlock(blockLines, 0, sectionStart + 1);
  const section = parsed.value?.mcp_servers;
  if (!section || typeof section !== "object" || Array.isArray(section)) {
    return {};
  }

  const servers = {};
  for (const [name, entry] of Object.entries(section)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    try {
      const transport = normalizeTransport({
        type: typeof entry.type === "string" ? entry.type : entry.transport,
        command: entry.command,
        args: entry.args,
        env: entry.env,
        cwd: entry.cwd,
        url: entry.url,
        headers: entry.headers,
      });
      servers[name] = {
        name,
        enabled: entry.enabled !== false && entry.disabled !== true,
        transport,
      };
    } catch {
      // Skip malformed single server entry without breaking the rest
    }
  }
  return servers;
}

/**
 * Build a Hermes `mcp_servers.<name>` entry while preserving extra Hermes-specific fields
 * (e.g. `timeout`, `tools`, `auth`, `connect_timeout`) and stripping cross-transport fields.
 */
function buildHermesServerEntry(server, existing = null) {
  const t = server.transport;
  const extras = {};
  if (existing && typeof existing === "object" && !Array.isArray(existing)) {
    for (const [k, v] of Object.entries(existing)) {
      if (k === "enabled" || k === "disabled" || k === "type" || k === "transport") continue;
      if (STDIO_KEYS.has(k) || HTTP_KEYS.has(k)) continue;
      extras[k] = v;
    }
  }

  if (t.type === "stdio") {
    const env = cleanStringMap(t.env);
    return {
      command: t.command,
      ...(t.args?.length ? { args: [...t.args] } : {}),
      ...(Object.keys(env).length ? { env } : {}),
      ...(t.cwd ? { cwd: t.cwd } : {}),
      enabled: server.enabled !== false,
      ...extras,
    };
  }

  const headers = cleanStringMap(t.headers);
  return {
    url: t.url,
    ...(Object.keys(headers).length ? { headers } : {}),
    enabled: server.enabled !== false,
    ...extras,
  };
}

/**
 * Surgically update Hermes `~/.hermes/config.yaml` `mcp_servers` section:
 *  - `upserts`: `{ [name]: canonicalServer }`
 *  - `removals`: iterable of server names to remove
 * Leaves all unrelated top-level keys, comments, and formatting untouched byte-for-byte.
 */
export function updateHermesYaml(originalText, upserts, removals) {
  const { eol, lines, sectionStart, sectionEnd } = locateHermesMcpSection(originalText);
  const removeSet = new Set(removals ?? []);
  const upsertEntries = Object.entries(upserts ?? {});
  const upsertMap = new Map(upsertEntries);

  let existingMap = {};
  if (sectionStart !== -1) {
    const blockLines = lines.slice(sectionStart, sectionEnd);
    const parsed = parseYamlBlock(blockLines, 0, sectionStart + 1);
    if (
      parsed.value?.mcp_servers &&
      typeof parsed.value.mcp_servers === "object" &&
      !Array.isArray(parsed.value.mcp_servers)
    ) {
      existingMap = { ...parsed.value.mcp_servers };
    }
  }

  let changed = false;
  for (const name of removeSet) {
    if (upsertMap.has(name)) continue;
    if (Object.prototype.hasOwnProperty.call(existingMap, name)) {
      delete existingMap[name];
      changed = true;
    }
  }
  for (const [name, server] of upsertEntries) {
    existingMap[name] = buildHermesServerEntry(server, existingMap[name]);
    changed = true;
  }

  // No-op: return original text untouched (preserving exact trailing newline)
  if (!changed && sectionStart !== -1) {
    return lines.join(eol) + eol;
  }
  if (!changed && sectionStart === -1) {
    return lines.length > 0 ? lines.join(eol) + eol : `{}${eol}`;
  }

  const nextSectionLines = serializeYamlNode({ mcp_servers: existingMap }, 0);

  let outLines;
  if (sectionStart !== -1) {
    outLines = [...lines.slice(0, sectionStart), ...nextSectionLines, ...lines.slice(sectionEnd)];
  } else {
    outLines = [...lines];
    while (outLines.length > 0 && outLines[outLines.length - 1].trim() === "") {
      outLines.pop();
    }
    if (outLines.length > 0) outLines.push("");
    outLines.push(...nextSectionLines);
  }

  return outLines.join(eol) + eol;
}
