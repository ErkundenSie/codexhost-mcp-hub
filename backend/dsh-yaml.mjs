/**
 * Surgical YAML parser & updater for DeepSeek (`@deepseek-ai/dsh`) Cordis patch files:
 *   - `~/.dsh/profiles/desktop/cordis.patch.yml` (DeepSeek Desktop)
 *   - `~/.dsh/profiles/web/cordis.patch.yml`     (DeepSeek Web)
 *
 * Supports BOTH official `@deepseek-ai/dsh` MCP representations without creating duplicate
 * `serverName` collisions:
 *   1. `- id: mcp-manager` (`@deepseek-ai/dsh-mcp-manager`) -> `config.servers.<name>`
 *   2. Standalone `- insert:` `@deepseek-ai/dsh-mcp-client` entries -> `config.serverName`
 *
 * Unrelated top-level Cordis patch entries (`ui-chat`, `llm-pi-ai`, `!!js` expressions, comments)
 * are preserved byte-for-byte. Zero external dependencies.
 */

import { cleanStringMap, normalizeTransport } from "../shared/models.mjs";

const YAML_BARE_KEY_RE = /^[A-Za-z0-9_-]+$/;
const YAML_SAFE_PLAIN_RE = /^[A-Za-z0-9_][A-Za-z0-9._/-]*$/;
const YAML_KEYWORD_RE = /^(?:true|false|null|yes|no|on|off|y|n|~)$/i;
const YAML_NUMBER_RE = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
const BLOCK_SCALAR_HEADER_RE = /^[|>][+-]?\d*$/;

const STDIO_TRANSPORT_KEYS = new Set(["command", "args", "env", "cwd"]);
const HTTP_TRANSPORT_KEYS = new Set(["url", "headers"]);

/**
 * Strip an unquoted `# ...` comment from a YAML line.
 * In YAML, `#` begins a comment only at column 0 or when preceded by whitespace.
 */
export function stripYamlInlineComment(line) {
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
      if (ch === "'") {
        if (line[i + 1] === "'") i++;
        else inSingle = false;
      }
    } else {
      if (ch === '"') inDouble = true;
      else if (ch === "'") inSingle = true;
      else if (ch === "#" && (i === 0 || line[i - 1] === " " || line[i - 1] === "\t")) {
        return line.slice(0, i);
      }
    }
  }
  return line;
}

/**
 * Count leading spaces on a line. Throws if a tab is used for YAML indentation.
 */
export function measureIndent(line, lineNo) {
  let indent = 0;
  while (indent < line.length) {
    const ch = line[indent];
    if (ch === " ") indent++;
    else if (ch === "\t") {
      throw new Error(`YAML parse error at line ${lineNo}: tab characters are not allowed for indentation`);
    } else {
      break;
    }
  }
  return indent;
}

export function isDashItemStart(trimmed) {
  return trimmed === "-" || trimmed.startsWith("- ") || trimmed.startsWith("-\t");
}

function hasUnclosedFlow(str) {
  let inDouble = false;
  let inSingle = false;
  let escaped = false;
  let sq = 0;
  let curly = 0;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (inDouble) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inDouble = false;
    } else if (inSingle) {
      if (ch === "'") {
        if (str[i + 1] === "'") i++;
        else inSingle = false;
      }
    } else {
      if (ch === '"') inDouble = true;
      else if (ch === "'") inSingle = true;
      else if (ch === "[") sq++;
      else if (ch === "]") sq--;
      else if (ch === "{") curly++;
      else if (ch === "}") curly--;
    }
  }
  return inDouble || inSingle || sq > 0 || curly > 0;
}

/**
 * Split a flow collection body by top-level delimiter (`,`).
 */
function splitFlowTopLevel(str, delimiter) {
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
      if (ch === "'") {
        if (str[i + 1] === "'") i++;
        else inSingle = false;
      }
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
 * Find the mapping colon separator `:` in a YAML line/pair (outside quotes & flow containers,
 * followed by whitespace or end-of-string, or immediately after a closing quote).
 */
function findMappingColon(str) {
  let inDouble = false;
  let inSingle = false;
  let escaped = false;
  let depth = 0;
  let justClosedQuote = false;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (inDouble) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') {
        inDouble = false;
        justClosedQuote = true;
      }
      continue;
    }
    if (inSingle) {
      if (ch === "'") {
        if (str[i + 1] === "'") i++;
        else {
          inSingle = false;
          justClosedQuote = true;
        }
      }
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      justClosedQuote = false;
    } else if (ch === "'") {
      inSingle = true;
      justClosedQuote = false;
    } else if (ch === "[" || ch === "{") {
      depth++;
      justClosedQuote = false;
    } else if (ch === "]" || ch === "}") {
      depth--;
      justClosedQuote = false;
    } else if (depth === 0 && ch === ":") {
      const next = str[i + 1];
      if (next === undefined || next === " " || next === "\t" || justClosedQuote) {
        return i;
      }
      justClosedQuote = false;
    } else if (ch !== " " && ch !== "\t") {
      justClosedQuote = false;
    }
  }
  return -1;
}

/**
 * Parse a YAML scalar or inline flow collection (`[...]`, `{...}`).
 */
function parseYamlScalar(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return null;

  // Preserve Cordis custom tags like `!!js "..."` as opaque strings
  if (s.startsWith("!")) {
    return s;
  }

  if (s.startsWith('"')) {
    if (s.length < 2 || !s.endsWith('"')) {
      throw new Error(`YAML parse error: unclosed double-quoted string (${s.slice(0, 32)})`);
    }
    try {
      return JSON.parse(s);
    } catch {
      // Fallback for non-JSON YAML double-quoted escapes (e.g. \/)
      return s.slice(1, -1).replace(/\\(.)/g, (_, ch) => {
        if (ch === "n") return "\n";
        if (ch === "r") return "\r";
        if (ch === "t") return "\t";
        return ch;
      });
    }
  }

  if (s.startsWith("'")) {
    if (s.length < 2 || !s.endsWith("'")) {
      throw new Error(`YAML parse error: unclosed single-quoted string (${s.slice(0, 32)})`);
    }
    return s.slice(1, -1).replace(/''/g, "'");
  }

  if (s.startsWith("[")) {
    if (!s.endsWith("]")) {
      throw new Error("YAML parse error: unclosed flow sequence '['");
    }
    const inner = s.slice(1, -1).trim();
    if (!inner) return [];
    return splitFlowTopLevel(inner, ",").map((part) => parseYamlScalar(part));
  }

  if (s.startsWith("{")) {
    if (!s.endsWith("}")) {
      throw new Error("YAML parse error: unclosed flow mapping '{'");
    }
    const inner = s.slice(1, -1).trim();
    const obj = {};
    if (!inner) return obj;
    for (const pair of splitFlowTopLevel(inner, ",")) {
      const colon = findMappingColon(pair);
      if (colon === -1) {
        throw new Error(`YAML parse error: invalid flow mapping entry "${pair.slice(0, 32)}"`);
      }
      const key = String(parseYamlKey(pair.slice(0, colon)));
      const valRaw = pair.slice(colon + 1).trim();
      obj[key] = valRaw ? parseYamlScalar(valRaw) : null;
    }
    return obj;
  }

  if (s === "true") return true;
  if (s === "false") return false;
  if (s === "null" || s === "~") return null;
  if (YAML_NUMBER_RE.test(s)) return Number(s);
  return s;
}

function parseYamlKey(rawKey) {
  const s = String(rawKey ?? "").trim();
  if (!s) throw new Error("YAML parse error: empty mapping key");
  if (s.startsWith('"') || s.startsWith("'")) {
    return String(parseYamlScalar(s));
  }
  return s;
}

export function splitKeyValue(trimmedLine) {
  if (!trimmedLine || trimmedLine.startsWith("{") || trimmedLine.startsWith("[")) return null;
  const colon = findMappingColon(trimmedLine);
  if (colon === -1) return null;
  const keyPart = trimmedLine.slice(0, colon).trim();
  if (!keyPart) return null;
  const key = parseYamlKey(keyPart);
  const valueRaw = trimmedLine.slice(colon + 1).trim();
  return { key, valueRaw };
}

/**
 * Parse a YAML block (sequence or mapping) from an array of lines.
 * Returns `{ value, nextIndex }`.
 */
export function parseYamlBlock(lines, startIdx, baseLineOffset = 1) {
  const nextContent = (idx) => {
    while (idx < lines.length) {
      const stripped = stripYamlInlineComment(lines[idx]);
      if (stripped.trim() !== "") return idx;
      idx++;
    }
    return lines.length;
  };

  const firstIdx = nextContent(startIdx);
  if (firstIdx >= lines.length) return { value: null, nextIndex: lines.length };

  const firstLine = stripYamlInlineComment(lines[firstIdx]);
  const baseIndent = measureIndent(firstLine, baseLineOffset + firstIdx);
  const firstTrimmed = firstLine.trim();

  if (isDashItemStart(firstTrimmed)) {
    return parseSequence(lines, firstIdx, baseIndent, baseLineOffset);
  }
  if (splitKeyValue(firstTrimmed)) {
    return parseMapping(lines, firstIdx, baseIndent, baseLineOffset);
  }

  // Single scalar or flow value
  const { value, nextIndex } = consumeInlineOrFlowValue(lines, firstIdx, firstTrimmed, baseIndent, baseLineOffset);
  return { value, nextIndex };
}

function consumeBlockScalar(lines, startIdx, parentIndent, header, baseLineOffset) {
  const folded = header.startsWith(">");
  const chompStrip = header.includes("-");
  let idx = startIdx + 1;
  let contentIndent = null;
  const collected = [];

  while (idx < lines.length) {
    const raw = lines[idx];
    if (raw.trim() === "") {
      collected.push("");
      idx++;
      continue;
    }
    const ind = measureIndent(raw, baseLineOffset + idx);
    if (ind <= parentIndent) break;
    if (contentIndent === null) contentIndent = ind;
    collected.push(raw.slice(Math.min(contentIndent, ind)));
    idx++;
  }

  while (chompStrip && collected.length > 0 && collected[collected.length - 1] === "") {
    collected.pop();
  }
  const text = folded ? collected.join(" ").trim() : collected.join("\n");
  return { value: text, nextIndex: idx };
}

function consumeInlineOrFlowValue(lines, idx, valueRaw, parentIndent, baseLineOffset) {
  if (BLOCK_SCALAR_HEADER_RE.test(valueRaw)) {
    return consumeBlockScalar(lines, idx, parentIndent, valueRaw, baseLineOffset);
  }
  let acc = valueRaw;
  let nextIdx = idx + 1;
  while (hasUnclosedFlow(acc)) {
    if (nextIdx >= lines.length) {
      throw new Error(`YAML parse error at line ${baseLineOffset + idx}: unclosed quote or flow bracket`);
    }
    const cont = stripYamlInlineComment(lines[nextIdx]).trim();
    if (cont) acc += " " + cont;
    nextIdx++;
  }
  return { value: parseYamlScalar(acc), nextIndex: nextIdx };
}

function parseSequence(lines, startIdx, seqIndent, baseLineOffset) {
  const arr = [];
  let idx = startIdx;

  while (idx < lines.length) {
    const stripped = stripYamlInlineComment(lines[idx]);
    if (stripped.trim() === "") {
      idx++;
      continue;
    }
    const indent = measureIndent(stripped, baseLineOffset + idx);
    if (indent < seqIndent) break;
    if (indent > seqIndent) {
      throw new Error(`YAML parse error at line ${baseLineOffset + idx}: unexpected indentation inside sequence`);
    }
    const trimmed = stripped.trim();
    if (!isDashItemStart(trimmed)) break;

    const afterDash = stripped.slice(seqIndent + 1);
    if (afterDash.trim() === "") {
      // Bare `-`, value starts on next indented line
      let peek = idx + 1;
      while (peek < lines.length && stripYamlInlineComment(lines[peek]).trim() === "") peek++;
      if (peek < lines.length && measureIndent(stripYamlInlineComment(lines[peek]), baseLineOffset + peek) > seqIndent) {
        const child = parseYamlBlock(lines, peek, baseLineOffset);
        arr.push(child.value);
        idx = child.nextIndex;
      } else {
        arr.push(null);
        idx = peek;
      }
      continue;
    }

    const leadingSpaces = afterDash.match(/^ */)[0].length;
    const inlineIndent = seqIndent + 1 + leadingSpaces;
    const rest = afterDash.slice(leadingSpaces).trim();

    if (isDashItemStart(rest)) {
      // Compact nested sequence `- - item`
      const syntheticLines = lines.slice();
      syntheticLines[idx] = " ".repeat(inlineIndent) + rest;
      const child = parseSequence(syntheticLines, idx, inlineIndent, baseLineOffset);
      arr.push(child.value);
      idx = child.nextIndex;
      continue;
    }

    if (splitKeyValue(rest)) {
      // Compact mapping starting on the `- ` line
      const syntheticLines = lines.slice();
      syntheticLines[idx] = " ".repeat(inlineIndent) + rest;
      const child = parseMapping(syntheticLines, idx, inlineIndent, baseLineOffset);
      arr.push(child.value);
      idx = child.nextIndex;
      continue;
    }

    const res = consumeInlineOrFlowValue(lines, idx, rest, seqIndent, baseLineOffset);
    arr.push(res.value);
    idx = res.nextIndex;
  }

  return { value: arr, nextIndex: idx };
}

function parseMapping(lines, startIdx, mapIndent, baseLineOffset) {
  const obj = {};
  let idx = startIdx;

  while (idx < lines.length) {
    const stripped = stripYamlInlineComment(lines[idx]);
    if (stripped.trim() === "") {
      idx++;
      continue;
    }
    const indent = measureIndent(stripped, baseLineOffset + idx);
    if (indent < mapIndent) break;
    if (indent > mapIndent) {
      throw new Error(`YAML parse error at line ${baseLineOffset + idx}: unexpected indentation inside mapping`);
    }
    const trimmed = stripped.trim();
    if (isDashItemStart(trimmed)) break;

    const kv = splitKeyValue(trimmed);
    if (!kv) {
      throw new Error(`YAML parse error at line ${baseLineOffset + idx}: expected "key: value"`);
    }

    if (kv.valueRaw === "") {
      let peek = idx + 1;
      while (peek < lines.length && stripYamlInlineComment(lines[peek]).trim() === "") peek++;
      if (peek < lines.length) {
        const peekStripped = stripYamlInlineComment(lines[peek]);
        const peekIndent = measureIndent(peekStripped, baseLineOffset + peek);
        const peekTrimmed = peekStripped.trim();
        if (peekIndent > mapIndent) {
          const child = parseYamlBlock(lines, peek, baseLineOffset);
          obj[kv.key] = child.value;
          idx = child.nextIndex;
          continue;
        }
        // YAML allows a block sequence at the same indent as its parent mapping key
        if (peekIndent === mapIndent && isDashItemStart(peekTrimmed)) {
          const child = parseSequence(lines, peek, mapIndent, baseLineOffset);
          obj[kv.key] = child.value;
          idx = child.nextIndex;
          continue;
        }
      }
      obj[kv.key] = null;
      idx++;
      continue;
    }

    const res = consumeInlineOrFlowValue(lines, idx, kv.valueRaw, mapIndent, baseLineOffset);
    obj[kv.key] = res.value;
    idx = res.nextIndex;
  }

  return { value: obj, nextIndex: idx };
}

/**
 * Split a Cordis `cordis.patch.yml` file into lossless top-level sequence segments:
 *   `{ eol, preamble, items: [{ leadingTrivia, rawLines, startLineNo }], trailingTrivia }`
 * Throws if the file is non-empty and its root is not a YAML sequence.
 */
function splitTopLevelCordisItems(yamlText) {
  let text = String(yamlText ?? "");
  if (text.startsWith("\uFEFF")) text = text.slice(1);
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  if (!text.trim()) {
    return { eol, preamble: [], items: [], trailingTrivia: [] };
  }

  const lines = text.split(/\r?\n/);
  // Remove a single synthetic empty string caused by trailing newline
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }

  const preamble = [];
  let i = 0;

  // Collect leading blank lines, comments, and optional `---`
  while (i < lines.length) {
    const trimmed = lines[i].trim();
    if (trimmed === "" || trimmed.startsWith("#") || trimmed === "---") {
      preamble.push(lines[i]);
      i++;
      continue;
    }
    break;
  }

  // All comments / blank lines
  if (i >= lines.length) {
    return { eol, preamble, items: [], trailingTrivia: [] };
  }

  // Handle empty flow sequence `[]` (optionally with trailing comments/blanks)
  const firstContent = stripYamlInlineComment(lines[i]).trim();
  if (firstContent === "[]") {
    const trailing = lines.slice(i + 1);
    for (let k = 0; k < trailing.length; k++) {
      const tr = trailing[k].trim();
      if (tr !== "" && !tr.startsWith("#") && tr !== "...") {
        throw new Error(`YAML parse error at line ${i + 2 + k}: unexpected content after empty sequence []`);
      }
    }
    return { eol, preamble, items: [], trailingTrivia: trailing };
  }

  // Must start a top-level sequence item at column 0
  if (measureIndent(lines[i], i + 1) !== 0 || !isDashItemStart(firstContent)) {
    throw new Error(
      `YAML parse error at line ${i + 1}: Cordis patch root must be a YAML sequence (expected "- ...")`,
    );
  }

  const rawSegments = [];
  let current = null;
  let pendingTrivia = [];

  for (; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed === "...") {
      // Document end marker
      pendingTrivia.push(line);
      continue;
    }

    if (trimmed === "" || line.startsWith("#")) {
      // Column-0 comment or blank line: buffer as trivia; if more indented lines follow
      // inside the same item, we flush it back into current.rawLines.
      pendingTrivia.push(line);
      continue;
    }

    const indent = measureIndent(line, i + 1);
    const stripped = stripYamlInlineComment(line).trim();

    if (indent === 0) {
      if (!isDashItemStart(stripped)) {
        throw new Error(
          `YAML parse error at line ${i + 1}: unexpected top-level entry (expected "- ...")`,
        );
      }
      if (current) rawSegments.push(current);
      current = {
        leadingTrivia: pendingTrivia,
        rawLines: [line],
        startLineNo: i + 1,
      };
      pendingTrivia = [];
    } else {
      if (!current) {
        throw new Error(`YAML parse error at line ${i + 1}: unexpected indentation before first sequence item`);
      }
      if (pendingTrivia.length > 0) {
        current.rawLines.push(...pendingTrivia);
        pendingTrivia = [];
      }
      current.rawLines.push(line);
    }
  }

  if (current) rawSegments.push(current);

  return {
    eol,
    preamble,
    items: rawSegments,
    trailingTrivia: pendingTrivia,
  };
}

/**
 * Quickly check if a top-level raw item is MCP-related so we parse MCP blocks strictly
 * while never risking failure on exotic non-MCP Cordis plugin blocks.
 */
function itemMentionsMcp(rawLines) {
  const joined = rawLines.map((line) => stripYamlInlineComment(line)).join("\n");
  return (
    joined.includes("mcp-manager") ||
    joined.includes("@deepseek-ai/dsh-mcp-manager") ||
    joined.includes("@deepseek-ai/dsh-mcp-client")
  );
}

function parseTopLevelItem(seg) {
  const parsed = parseYamlBlock(seg.rawLines, 0, seg.startLineNo);
  if (!Array.isArray(parsed.value) || parsed.value.length !== 1) {
    throw new Error(`YAML parse error at line ${seg.startLineNo}: invalid Cordis patch item`);
  }
  return parsed.value[0];
}

function isMcpManagerItem(obj) {
  return Boolean(
    obj &&
      typeof obj === "object" &&
      !Array.isArray(obj) &&
      (obj.id === "mcp-manager" || obj.name === "@deepseek-ai/dsh-mcp-manager"),
  );
}

function isMcpClientItem(obj) {
  return Boolean(
    obj &&
      typeof obj === "object" &&
      !Array.isArray(obj) &&
      obj.name === "@deepseek-ai/dsh-mcp-client" &&
      obj.config &&
      typeof obj.config === "object" &&
      !Array.isArray(obj.config),
  );
}

function normalizeDshEntry(name, entry, parentDisabled = false) {
  const rawType = typeof entry.transport === "string" ? entry.transport.trim().toLowerCase() : "";
  const transport = normalizeTransport({
    type: rawType || undefined,
    command: entry.command,
    args: entry.args,
    env: entry.env,
    cwd: entry.cwd,
    url: entry.url,
    headers: entry.headers,
  });
  return {
    name,
    enabled: !parentDisabled && entry.enabled !== false && entry.disabled !== true,
    transport,
  };
}

/**
 * Parse all MCP servers from a DeepSeek (`@deepseek-ai/dsh`) `cordis.patch.yml` file.
 * Reads BOTH:
 *   - `- id: mcp-manager` (`config.servers.<name>`)
 *   - Standalone `- insert:` (or direct top-level) `@deepseek-ai/dsh-mcp-client` entries
 *
 * Returns `{ [name]: { name, enabled, transport } }`.
 * Throws on invalid YAML root / malformed MCP blocks so Auto-Sync syntax breaker can protect the file.
 */
export function parseDshCordisMcpServers(yamlText) {
  const { items } = splitTopLevelCordisItems(yamlText);
  const servers = {};

  for (const seg of items) {
    if (!itemMentionsMcp(seg.rawLines)) continue;
    const item = parseTopLevelItem(seg);
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;

    // 1. `- insert:` containing `@deepseek-ai/dsh-mcp-client` rows
    if (Array.isArray(item.insert)) {
      for (const sub of item.insert) {
        if (!isMcpClientItem(sub)) continue;
        const name = typeof sub.config.serverName === "string" ? sub.config.serverName.trim() : "";
        if (!name) continue;
        try {
          servers[name] = normalizeDshEntry(name, sub.config, sub.disabled === true);
        } catch {
          // Skip malformed single server entry without breaking the rest
        }
      }
      continue;
    }

    // 2. Direct top-level `@deepseek-ai/dsh-mcp-client` row
    if (isMcpClientItem(item)) {
      const name = typeof item.config.serverName === "string" ? item.config.serverName.trim() : "";
      if (name) {
        try {
          servers[name] = normalizeDshEntry(name, item.config, item.disabled === true);
        } catch {
          // Skip malformed single entry
        }
      }
      continue;
    }

    // 3. `- id: mcp-manager` (`@deepseek-ai/dsh-mcp-manager`)
    if (isMcpManagerItem(item)) {
      const map = item.config?.servers;
      if (map && typeof map === "object" && !Array.isArray(map)) {
        for (const [name, entry] of Object.entries(map)) {
          if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
          try {
            servers[name] = normalizeDshEntry(name, entry, item.disabled === true);
          } catch {
            // Skip malformed single entry
          }
        }
      }
    }
  }

  return servers;
}

/**
 * Format a YAML mapping key safely.
 */
function formatYamlKey(key) {
  const s = String(key);
  if (YAML_BARE_KEY_RE.test(s) && !YAML_KEYWORD_RE.test(s) && !YAML_NUMBER_RE.test(s)) {
    return s;
  }
  return JSON.stringify(s);
}

/**
 * Format a YAML scalar value safely.
 * Uses double-quoted JSON strings whenever quoting is needed (valid YAML 1.2, handles Windows paths cleanly).
 */
function formatYamlScalar(value) {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "null";
  const s = String(value);
  if (s.startsWith("!!")) return s;
  if (
    s.length > 0 &&
    YAML_SAFE_PLAIN_RE.test(s) &&
    !s.startsWith("@") &&
    !s.startsWith("-") &&
    !YAML_KEYWORD_RE.test(s) &&
    !YAML_NUMBER_RE.test(s)
  ) {
    return s;
  }
  return JSON.stringify(s);
}

/**
 * Serialize a JS value to YAML lines at the given indentation level.
 */
export function serializeYamlNode(value, indent = 0) {
  const pad = " ".repeat(indent);
  if (value === null || value === undefined || typeof value !== "object") {
    return [`${pad}${formatYamlScalar(value)}`];
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return [`${pad}[]`];
    const out = [];
    for (const elem of value) {
      if (elem && typeof elem === "object" && !Array.isArray(elem)) {
        const entries = Object.entries(elem).filter(([, v]) => v !== undefined);
        if (entries.length === 0) {
          out.push(`${pad}- {}`);
          continue;
        }
        const [firstKey, firstVal] = entries[0];
        const firstLines = serializeEntryLines(firstKey, firstVal, indent + 2);
        out.push(`${pad}- ${firstLines[0].slice(indent + 2)}`);
        for (let k = 1; k < firstLines.length; k++) out.push(firstLines[k]);
        for (let j = 1; j < entries.length; j++) {
          const [ek, ev] = entries[j];
          out.push(...serializeEntryLines(ek, ev, indent + 2));
        }
      } else if (Array.isArray(elem)) {
        if (elem.length === 0) {
          out.push(`${pad}- []`);
        } else {
          out.push(`${pad}-`);
          out.push(...serializeYamlNode(elem, indent + 2));
        }
      } else {
        out.push(`${pad}- ${formatYamlScalar(elem)}`);
      }
    }
    return out;
  }

  // Plain object
  const entries = Object.entries(value).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return [`${pad}{}`];
  const out = [];
  for (const [k, v] of entries) {
    out.push(...serializeEntryLines(k, v, indent));
  }
  return out;
}

function serializeEntryLines(key, value, indent) {
  const pad = " ".repeat(indent);
  const k = formatYamlKey(key);
  if (value === null || value === undefined || typeof value !== "object") {
    return [`${pad}${k}: ${formatYamlScalar(value)}`];
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${pad}${k}: []`];
    return [`${pad}${k}:`, ...serializeYamlNode(value, indent + 2)];
  }
  const entries = Object.entries(value).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return [`${pad}${k}: {}`];
  return [`${pad}${k}:`, ...serializeYamlNode(value, indent + 2)];
}

/**
 * Build a `dsh-mcp-manager` `config.servers.<name>` entry, preserving any extra vendor keys
 * (e.g. `toolCallTimeoutMs`, `reconnect`) while strictly stripping cross-transport fields.
 */
function buildMcpManagerServerEntry(server, existing = null) {
  const t = server.transport;
  const extras = {};
  if (existing && typeof existing === "object" && !Array.isArray(existing)) {
    for (const [k, v] of Object.entries(existing)) {
      if (k === "transport" || k === "enabled" || k === "disabled") continue;
      if (STDIO_TRANSPORT_KEYS.has(k) || HTTP_TRANSPORT_KEYS.has(k)) continue;
      extras[k] = v;
    }
  }

  if (t.type === "stdio") {
    const env = cleanStringMap(t.env);
    return {
      transport: "stdio",
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
    transport: "streamable-http",
    url: t.url,
    ...(Object.keys(headers).length ? { headers } : {}),
    enabled: server.enabled !== false,
    ...extras,
  };
}

/**
 * Update an existing standalone `@deepseek-ai/dsh-mcp-client` item in-place, preserving `id`,
 * `name`, and extra `config` fields (such as `toolCallTimeoutMs`).
 */
function buildUpdatedMcpClientItem(existingItem, serverName, server) {
  const t = server.transport;
  const existingConfig =
    existingItem.config && typeof existingItem.config === "object" ? existingItem.config : {};
  const extras = {};
  for (const [k, v] of Object.entries(existingConfig)) {
    if (k === "serverName" || k === "transport" || k === "enabled" || k === "disabled") continue;
    if (STDIO_TRANSPORT_KEYS.has(k) || HTTP_TRANSPORT_KEYS.has(k)) continue;
    extras[k] = v;
  }

  let nextConfig;
  if (t.type === "stdio") {
    const env = cleanStringMap(t.env);
    nextConfig = {
      serverName,
      transport: "stdio",
      command: t.command,
      ...(t.args?.length ? { args: [...t.args] } : {}),
      ...(Object.keys(env).length ? { env } : {}),
      ...(t.cwd ? { cwd: t.cwd } : {}),
      ...extras,
    };
  } else {
    const headers = cleanStringMap(t.headers);
    nextConfig = {
      serverName,
      transport: "streamable-http",
      url: t.url,
      ...(Object.keys(headers).length ? { headers } : {}),
      ...extras,
    };
  }

  const nextItem = { ...existingItem, config: nextConfig };
  if (server.enabled === false) {
    nextItem.disabled = true;
  } else {
    delete nextItem.disabled;
  }
  return nextItem;
}

/**
 * Surgically update a DeepSeek (`@deepseek-ai/dsh`) `cordis.patch.yml` file:
 *  - `upserts`: `{ [name]: canonicalServer }`
 *  - `removals`: iterable of server names to remove
 *
 * Collision-safe strategy:
 *  - If a server already exists in a standalone `- insert:` (or direct top-level)
 *    `@deepseek-ai/dsh-mcp-client` entry, update it in-place and never duplicate it in `mcp-manager`.
 *  - Otherwise, upsert it inside `- id: mcp-manager` -> `config.servers` (appending the
 *    `- id: mcp-manager` block if absent).
 *  - Every unrelated top-level Cordis patch entry is preserved byte-for-byte.
 */
export function updateDshCordisYaml(originalText, upserts, removals) {
  const parsedDoc = splitTopLevelCordisItems(originalText);
  const { eol, preamble, trailingTrivia } = parsedDoc;
  const removeSet = new Set(removals ?? []);
  const upsertEntries = Object.entries(upserts ?? {});
  const upsertMap = new Map(upsertEntries);

  // Clone segment list so we can mutate only MCP-touched blocks
  const segments = parsedDoc.items.map((seg) => ({
    leadingTrivia: [...seg.leadingTrivia],
    rawLines: [...seg.rawLines],
    startLineNo: seg.startLineNo,
    parsed: null,
    modified: false,
    dropped: false,
  }));

  let managerSeg = null;
  const standaloneOwners = new Map(); // serverName -> { kind: "insert"|"direct", seg, insertIdx? }

  for (const seg of segments) {
    if (!itemMentionsMcp(seg.rawLines)) continue;
    const obj = parseTopLevelItem(seg);
    seg.parsed = obj;

    if (isMcpManagerItem(obj)) {
      managerSeg = seg;
    } else if (obj && typeof obj === "object" && Array.isArray(obj.insert)) {
      for (let k = 0; k < obj.insert.length; k++) {
        const sub = obj.insert[k];
        if (!isMcpClientItem(sub)) continue;
        const name = typeof sub.config.serverName === "string" ? sub.config.serverName.trim() : "";
        if (name) {
          standaloneOwners.set(name, { kind: "insert", seg, insertIdx: k });
        }
      }
    } else if (isMcpClientItem(obj)) {
      const name = typeof obj.config.serverName === "string" ? obj.config.serverName.trim() : "";
      if (name) {
        standaloneOwners.set(name, { kind: "direct", seg });
      }
    }
  }

  // 1. Apply removals across standalone entries and mcp-manager
  for (const name of removeSet) {
    if (upsertMap.has(name)) continue; // Upsert wins if listed in both
    const owner = standaloneOwners.get(name);
    if (owner) {
      if (owner.kind === "direct") {
        owner.seg.dropped = true;
      } else if (owner.kind === "insert") {
        owner.seg.parsed.insert = owner.seg.parsed.insert.filter(
          (sub) => !(isMcpClientItem(sub) && String(sub.config.serverName ?? "").trim() === name),
        );
        if (owner.seg.parsed.insert.length === 0) {
          owner.seg.dropped = true;
        } else {
          owner.seg.modified = true;
        }
      }
      standaloneOwners.delete(name);
    }

    if (managerSeg?.parsed?.config?.servers && Object.prototype.hasOwnProperty.call(managerSeg.parsed.config.servers, name)) {
      delete managerSeg.parsed.config.servers[name];
      managerSeg.modified = true;
    }
  }

  // 2. Apply upserts: in-place for standalone owners, mcp-manager for everything else
  const managerUpserts = [];
  for (const [name, server] of upsertEntries) {
    const owner = standaloneOwners.get(name);
    if (owner && !owner.seg.dropped) {
      if (owner.kind === "direct") {
        owner.seg.parsed = buildUpdatedMcpClientItem(owner.seg.parsed, name, server);
        owner.seg.modified = true;
      } else if (owner.kind === "insert") {
        const idx = owner.seg.parsed.insert.findIndex(
          (sub) => isMcpClientItem(sub) && String(sub.config.serverName ?? "").trim() === name,
        );
        if (idx !== -1) {
          owner.seg.parsed.insert[idx] = buildUpdatedMcpClientItem(owner.seg.parsed.insert[idx], name, server);
          owner.seg.modified = true;
        }
      }
      // Guarantee no duplicate serverName in mcp-manager
      if (managerSeg?.parsed?.config?.servers && Object.prototype.hasOwnProperty.call(managerSeg.parsed.config.servers, name)) {
        delete managerSeg.parsed.config.servers[name];
        managerSeg.modified = true;
      }
    } else {
      managerUpserts.push([name, server]);
    }
  }

  if (managerUpserts.length > 0) {
    if (!managerSeg) {
      const serversObj = {};
      for (const [name, server] of managerUpserts) {
        serversObj[name] = buildMcpManagerServerEntry(server, null);
      }
      segments.push({
        leadingTrivia: segments.length > 0 ? [""] : [],
        rawLines: [],
        parsed: {
          id: "mcp-manager",
          name: "@deepseek-ai/dsh-mcp-manager",
          config: {
            servers: serversObj,
          },
        },
        modified: true,
        dropped: false,
      });
    } else {
      const cfg =
        managerSeg.parsed.config && typeof managerSeg.parsed.config === "object" && !Array.isArray(managerSeg.parsed.config)
          ? { ...managerSeg.parsed.config }
          : {};
      const serversObj =
        cfg.servers && typeof cfg.servers === "object" && !Array.isArray(cfg.servers)
          ? { ...cfg.servers }
          : {};
      for (const [name, server] of managerUpserts) {
        serversObj[name] = buildMcpManagerServerEntry(server, serversObj[name]);
      }
      cfg.servers = serversObj;
      managerSeg.parsed = { ...managerSeg.parsed, config: cfg };
      managerSeg.modified = true;
    }
  }

  // 3. Reassemble output preserving all untouched blocks byte-for-byte
  const outLines = [...preamble];
  const kept = segments.filter((s) => !s.dropped);

  for (let idx = 0; idx < kept.length; idx++) {
    const seg = kept[idx];
    // Avoid leading blank lines at the very start of file if first item was dropped
    if (idx === 0 && outLines.length === 0) {
      const trimmedTrivia = [...seg.leadingTrivia];
      while (trimmedTrivia.length > 0 && trimmedTrivia[0].trim() === "") trimmedTrivia.shift();
      outLines.push(...trimmedTrivia);
    } else {
      outLines.push(...seg.leadingTrivia);
    }

    if (seg.modified) {
      outLines.push(...serializeYamlNode([seg.parsed], 0));
    } else {
      outLines.push(...seg.rawLines);
    }
  }

  // Keep any non-empty trailing comments (trim redundant trailing blank lines)
  const cleanTrailing = [...trailingTrivia];
  while (cleanTrailing.length > 0 && cleanTrailing[cleanTrailing.length - 1].trim() === "") {
    cleanTrailing.pop();
  }
  outLines.push(...cleanTrailing);

  // If file became completely empty of items (and no preamble comments), emit valid empty YAML sequence
  const hasNonTrivia = outLines.some((l) => l.trim() !== "" && !l.trim().startsWith("#") && l.trim() !== "---");
  if (!hasNonTrivia) {
    if (outLines.length === 0) return `[]${eol}`;
    outLines.push("[]");
  }

  return outLines.join(eol) + eol;
}
