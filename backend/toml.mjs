/**
 * Surgical TOML parser & updater specifically for Codex's `~/.codex/config.toml`
 * `[mcp_servers.<name>]` sections.
 *
 * Preserves all unrelated sections, comments, formatting, and unmanaged `[mcp_servers.*]` blocks
 * byte-for-byte when updating or removing managed MCP server entries.
 */

import { cleanStringMap, normalizeTransport } from "../shared/models.mjs";

const BARE_KEY_RE = /^[A-Za-z0-9_-]+$/;

/**
 * Format a TOML key segment (quote if needed).
 */
export function formatTomlKey(key) {
  return BARE_KEY_RE.test(key) ? key : JSON.stringify(key);
}

/**
 * Parse a dotted TOML header path like:
 *   mcp_servers.node_repl.env
 *   mcp_servers."my.server".http_headers
 * Returns array of unescaped key segments.
 */
export function parseTomlHeaderPath(headerInner) {
  const segments = [];
  let i = 0;
  const s = headerInner.trim();
  while (i < s.length) {
    while (i < s.length && (s[i] === " " || s[i] === "\t")) i++;
    if (i >= s.length) break;
    if (s[i] === '"') {
      let end = i + 1;
      let val = "";
      while (end < s.length) {
        if (s[end] === "\\" && end + 1 < s.length) {
          const next = s[end + 1];
          if (next === '"') val += '"';
          else if (next === "\\") val += "\\";
          else if (next === "n") val += "\n";
          else if (next === "t") val += "\t";
          else val += next;
          end += 2;
        } else if (s[end] === '"') {
          break;
        } else {
          val += s[end++];
        }
      }
      segments.push(val);
      i = end + 1;
    } else if (s[i] === "'") {
      const end = s.indexOf("'", i + 1);
      if (end === -1) {
        segments.push(s.slice(i + 1));
        break;
      }
      segments.push(s.slice(i + 1, end));
      i = end + 1;
    } else {
      let end = i;
      while (end < s.length && s[end] !== "." && s[end] !== " " && s[end] !== "\t") end++;
      segments.push(s.slice(i, end));
      i = end;
    }
    while (i < s.length && (s[i] === " " || s[i] === "\t")) i++;
    if (s[i] === ".") i++;
  }
  return segments;
}

/**
 * Strip unquoted `# ...` comment from a single TOML line.
 */
function stripInlineComment(line) {
  let inDouble = false;
  let inSingle = false;
  let escaped = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inDouble) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inDouble = false;
    } else if (inSingle) {
      if (ch === "'") inSingle = false;
    } else {
      if (ch === '"') inDouble = true;
      else if (ch === "'") inSingle = true;
      else if (ch === "#") return line.slice(0, i);
    }
  }
  return line;
}

/**
 * Parse a basic TOML value (string, literal string, boolean, number, array, inline table).
 */
function parseTomlValue(raw) {
  const s = raw.trim();
  if (!s) return "";
  if (s === "true") return true;
  if (s === "false") return false;
  if (/^-?\d+(?:\.\d+)?$/.test(s)) return Number(s);
  if (s.startsWith('"') && s.endsWith('"')) {
    try {
      return JSON.parse(s);
    } catch {
      return s.slice(1, -1);
    }
  }
  if (s.startsWith("'") && s.endsWith("'")) {
    return s.slice(1, -1);
  }
  if (s.startsWith("[") && s.endsWith("]")) {
    const inner = s.slice(1, -1).trim();
    if (!inner) return [];
    return splitTopLevel(inner, ",").map((item) => parseTomlValue(item));
  }
  if (s.startsWith("{") && s.endsWith("}")) {
    const inner = s.slice(1, -1).trim();
    const obj = {};
    if (!inner) return obj;
    for (const pair of splitTopLevel(inner, ",")) {
      const eq = findTopLevelChar(pair, "=");
      if (eq === -1) continue;
      const keySegs = parseTomlHeaderPath(pair.slice(0, eq));
      const key = keySegs[0] ?? pair.slice(0, eq).trim();
      obj[key] = parseTomlValue(pair.slice(eq + 1));
    }
    return obj;
  }
  return s;
}

function findTopLevelChar(str, target) {
  let inDouble = false;
  let inSingle = false;
  let escaped = false;
  let depth = 0;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (inDouble) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inDouble = false;
    } else if (inSingle) {
      if (ch === "'") inSingle = false;
    } else {
      if (ch === '"') inDouble = true;
      else if (ch === "'") inSingle = true;
      else if (ch === "[" || ch === "{") depth++;
      else if (ch === "]" || ch === "}") depth--;
      else if (depth === 0 && ch === target) return i;
    }
  }
  return -1;
}

function splitTopLevel(str, delimiter) {
  const parts = [];
  let start = 0;
  let inDouble = false;
  let inSingle = false;
  let escaped = false;
  let depth = 0;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (inDouble) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inDouble = false;
    } else if (inSingle) {
      if (ch === "'") inSingle = false;
    } else {
      if (ch === '"') inDouble = true;
      else if (ch === "'") inSingle = true;
      else if (ch === "[" || ch === "{") depth++;
      else if (ch === "]" || ch === "}") depth--;
      else if (depth === 0 && ch === delimiter) {
        const piece = str.slice(start, i).trim();
        if (piece) parts.push(piece);
        start = i + 1;
      }
    }
  }
  const tail = str.slice(start).trim();
  if (tail) parts.push(tail);
  return parts;
}

/**
 * Parse all `[mcp_servers.<name>]` entries from a Codex `config.toml` text.
 * Returns Map-like plain object: `{ [name]: { enabled, transport } }`.
 */
export function parseCodexMcpServers(tomlText) {
  const lines = String(tomlText ?? "").split(/\r?\n/);
  const rawMap = {};
  let currentPath = [];

  for (let idx = 0; idx < lines.length; idx++) {
    const { text: line, end } = readTomlStatement(lines, idx);
    idx = end;
    if (!line) continue;

    if (line.startsWith("[")) {
      // Skip array-of-tables and leave the previous MCP section.
      currentPath = line.startsWith("[[") ? [] : parseTomlHeaderPath(line.slice(1, -1));
      if (currentPath[0] === "mcp_servers" && currentPath.length >= 2) {
        const serverName = currentPath[1];
        rawMap[serverName] ??= {};
        if (currentPath.length === 3) {
          rawMap[serverName][currentPath[2]] ??= {};
        }
      }
      continue;
    }

    if (currentPath[0] !== "mcp_servers" || currentPath.length < 2) continue;

    const eq = findTopLevelChar(line, "=");
    if (eq === -1) continue;

    const keySegments = parseTomlHeaderPath(line.slice(0, eq));
    const key = keySegments[0];
    if (!key) continue;

    const val = parseTomlValue(line.slice(eq + 1));
    const serverName = currentPath[1];
    rawMap[serverName] ??= {};
    if (currentPath.length === 2) {
      if (keySegments.length === 2) {
        rawMap[serverName][key] =
          rawMap[serverName][key] && typeof rawMap[serverName][key] === "object"
            ? rawMap[serverName][key]
            : {};
        rawMap[serverName][key][keySegments[1]] = val;
      } else {
        rawMap[serverName][key] = val;
      }
    } else if (currentPath.length === 3) {
      const subKey = currentPath[2];
      rawMap[serverName][subKey] ??= {};
      if (typeof rawMap[serverName][subKey] === "object") {
        rawMap[serverName][subKey][key] = val;
      }
    }
  }

  const servers = {};
  for (const [name, obj] of Object.entries(rawMap)) {
    try {
      const transport = normalizeTransport({
        command: obj.command,
        args: obj.args,
        env: obj.env,
        cwd: obj.cwd,
        url: obj.url,
        http_headers: obj.http_headers,
        bearer_token_env_var: obj.bearer_token_env_var,
      });
      servers[name] = {
        name,
        enabled: obj.enabled !== false,
        transport,
      };
    } catch {
      // Skip incomplete or non-standard entries gracefully.
    }
  }
  return servers;
}

// Check delimiters across logical statements without treating comments or string
// contents as syntax. Full TOML value validation is outside this parser's scope.
function readTomlStatement(lines, start) {
  const header = lines[start].trimStart().startsWith("[");
  const closing = [];
  const parts = [];
  let quote = "";
  const fail = (line, detail) => {
    throw new Error(`TOML parse error at line ${line + 1}: ${detail}`);
  };

  for (let end = start; end < lines.length; end++) {
    const line = lines[end];
    let i = 0;
    while (i < line.length) {
      const ch = line[i];
      if (quote) {
        if (quote[0] === '"' && ch === "\\") {
          i += 2;
          continue;
        }
        if (line.startsWith(quote, i)) {
          i += quote.length;
          if (quote.length === 3) {
            // A closing triple quote can be preceded by up to two literal quotes.
            for (let extra = 0; extra < 2 && line[i] === quote[0]; extra++) i++;
          }
          quote = "";
          continue;
        }
      } else if (ch === "#") {
        break;
      } else if (ch === '"' || ch === "'") {
        quote = line.startsWith(ch.repeat(3), i) ? ch.repeat(3) : ch;
        i += quote.length;
        continue;
      } else if (ch === "[" || ch === "{") {
        closing.push(ch === "[" ? "]" : "}");
      } else if ((ch === "]" || ch === "}") && closing.pop() !== ch) {
        fail(end, `unexpected "${ch}"`);
      }
      i++;
    }

    if (quote.length === 1 || (header && quote)) fail(end, "unclosed quoted string");
    parts.push(line.slice(0, i));
    if (header) {
      const text = parts[0].trim();
      if (closing.length || !text.endsWith(text.startsWith("[[") ? "]]" : "]")) {
        fail(end, "malformed section header");
      }
      return { text, end };
    }
    if (!quote && closing.length === 0) return { text: parts.join("\n").trim(), end };
  }

  fail(start, quote ? "unclosed multiline string" : `missing closing "${closing.at(-1)}"`);
}

/**
 * Serialize a single MCP server into Codex TOML table block(s).
 */
export function serializeCodexMcpServer(name, server, eol = "\n") {
  const key = formatTomlKey(name);
  const t = server.transport;
  const lines = [`[mcp_servers.${key}]`];

  if (server.enabled === false) {
    lines.push("enabled = false");
  }

  if (t.type === "stdio") {
    lines.push(`command = ${JSON.stringify(t.command)}`);
    if (t.args && t.args.length > 0) {
      lines.push(`args = [${t.args.map((a) => JSON.stringify(a)).join(", ")}]`);
    }
    if (t.cwd) {
      lines.push(`cwd = ${JSON.stringify(t.cwd)}`);
    }
    const env = cleanStringMap(t.env);
    const envKeys = Object.keys(env);
    if (envKeys.length > 0) {
      lines.push("");
      lines.push(`[mcp_servers.${key}.env]`);
      for (const ek of envKeys) {
        lines.push(`${formatTomlKey(ek)} = ${JSON.stringify(env[ek])}`);
      }
    }
  } else {
    lines.push(`url = ${JSON.stringify(t.url)}`);
    if (t.bearerTokenEnvVar) {
      lines.push(`bearer_token_env_var = ${JSON.stringify(t.bearerTokenEnvVar)}`);
    }
    const headers = cleanStringMap(t.headers);
    const headerKeys = Object.keys(headers);
    if (headerKeys.length > 0) {
      lines.push("");
      lines.push(`[mcp_servers.${key}.http_headers]`);
      for (const hk of headerKeys) {
        lines.push(`${formatTomlKey(hk)} = ${JSON.stringify(headers[hk])}`);
      }
    }
  }

  return lines.join(eol);
}

/**
 * Surgically update Codex `config.toml`:
 *  - `upserts`: Map/Object of `{ [name]: server }` to add or replace
 *  - `removals`: Set/Array of server names to remove
 * Leaves every unrelated section, comment, and unmanaged `[mcp_servers.*]` intact.
 */
export function updateCodexToml(originalText, upserts, removals) {
  const text = String(originalText ?? "");
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const removeSet = new Set([...removals, ...Object.keys(upserts)]);
  const lines = text ? text.split(/\r?\n/) : [];

  const kept = [];
  let skipping = false;

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const trimmed = stripInlineComment(rawLine).trim();
    if (trimmed.startsWith("[") && !trimmed.startsWith("[[") && trimmed.endsWith("]")) {
      const segs = parseTomlHeaderPath(trimmed.slice(1, -1));
      if (segs[0] === "mcp_servers" && segs.length >= 2 && removeSet.has(segs[1])) {
        skipping = true;
        // Trim one trailing blank line right before a removed block so we don't accumulate gaps
        if (kept.length > 0 && kept[kept.length - 1].trim() === "") {
          kept.pop();
        }
        continue;
      }
      skipping = false;
    } else if (trimmed.startsWith("[[") && trimmed.endsWith("]]")) {
      skipping = false;
    }

    if (!skipping) {
      kept.push(rawLine);
    }
  }

  // Trim trailing blank lines
  while (kept.length > 0 && kept[kept.length - 1].trim() === "") {
    kept.pop();
  }

  const upsertEntries = Object.entries(upserts);
  for (const [name, server] of upsertEntries) {
    if (kept.length > 0) kept.push("");
    kept.push(serializeCodexMcpServer(name, server, eol));
  }

  return kept.length > 0 ? kept.join(eol) + eol : "";
}
