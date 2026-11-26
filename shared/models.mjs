/**
 * Shared MCP data normalization, JSON import parsing, and comparison helpers.
 * Zero dependencies — safe for both Node backend and Browser/Desktop ESM frontend.
 */

export const TRANSPORT_TYPES = ["stdio", "http", "sse"];

/**
 * Clean a string-to-string map (env or headers).
 */
export function cleanStringMap(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const out = {};
  for (const [k, v] of Object.entries(input)) {
    const key = String(k).trim();
    if (!key || v === undefined || v === null) continue;
    out[key] = String(v);
  }
  return out;
}

/**
 * Normalize a raw transport definition (from JSON import, Codex TOML, OpenCode, Antigravity, etc.)
 * into canonical MCP Hub transport format.
 */
export function normalizeTransport(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Invalid MCP server configuration object");
  }

  // OpenCode style: { type: "local", command: ["npx", "-y", "..."], environment: {...} }
  if (raw.type === "local" && Array.isArray(raw.command) && raw.command.length > 0) {
    const [cmd, ...rest] = raw.command.map((x) => String(x));
    return {
      type: "stdio",
      command: cmd.trim(),
      args: rest,
      env: cleanStringMap(raw.environment ?? raw.env),
      ...(typeof raw.cwd === "string" && raw.cwd.trim() ? { cwd: raw.cwd.trim() } : {}),
    };
  }

  // OpenCode remote style or standard http/sse/streamable_http/streamable-http
  const rawType = typeof raw.type === "string" ? raw.type.trim().toLowerCase() : "";
  const urlCandidate =
    (typeof raw.url === "string" && raw.url.trim()) ||
    (typeof raw.serverUrl === "string" && raw.serverUrl.trim()) ||
    (typeof raw.httpUrl === "string" && raw.httpUrl.trim()) ||
    "";

  if (
    urlCandidate &&
    (!raw.command ||
      rawType === "http" ||
      rawType === "sse" ||
      rawType === "remote" ||
      rawType === "streamable_http" ||
      rawType === "streamable-http")
  ) {
    const type = rawType === "sse" ? "sse" : "http";
    const headers = cleanStringMap(raw.headers ?? raw.http_headers);
    const result = { type, url: urlCandidate };
    if (Object.keys(headers).length > 0) result.headers = headers;
    if (typeof raw.bearer_token_env_var === "string" && raw.bearer_token_env_var.trim()) {
      result.bearerTokenEnvVar = raw.bearer_token_env_var.trim();
    } else if (typeof raw.bearerTokenEnvVar === "string" && raw.bearerTokenEnvVar.trim()) {
      result.bearerTokenEnvVar = raw.bearerTokenEnvVar.trim();
    }
    return result;
  }

  // Standard stdio: { command: "npx", args: [...], env: {...}, cwd?: "..." }
  if (typeof raw.command === "string" && raw.command.trim()) {
    const args = Array.isArray(raw.args) ? raw.args.map((a) => String(a)) : [];
    const env = cleanStringMap(raw.env ?? raw.environment);
    const result = {
      type: "stdio",
      command: raw.command.trim(),
      args,
    };
    if (Object.keys(env).length > 0) result.env = env;
    if (typeof raw.cwd === "string" && raw.cwd.trim()) result.cwd = raw.cwd.trim();
    return result;
  }

  // Array command without explicit type: "local"
  if (Array.isArray(raw.command) && raw.command.length > 0) {
    const [cmd, ...rest] = raw.command.map((x) => String(x));
    const env = cleanStringMap(raw.env ?? raw.environment);
    const result = { type: "stdio", command: cmd.trim(), args: rest };
    if (Object.keys(env).length > 0) result.env = env;
    if (typeof raw.cwd === "string" && raw.cwd.trim()) result.cwd = raw.cwd.trim();
    return result;
  }

  throw new Error("MCP config must specify either 'command' (stdio) or 'url'/'serverUrl' (http/sse)");
}

/**
 * Validate and normalize an MCP server name.
 */
export function normalizeServerName(name) {
  const trimmed = String(name ?? "").trim();
  if (!trimmed) throw new Error("Server name cannot be empty");
  if (trimmed.length > 100) throw new Error("Server name is too long (max 100 chars)");
  if (/[\r\n\t/\\]/.test(trimmed)) {
    throw new Error("Server name must not contain slashes or line breaks");
  }
  return trimmed;
}

/**
 * Detect whether an MCP server is an AI-vendor built-in / bundled internal tool
 * (e.g. OpenAI Codex Desktop's `node_repl` inside WindowsApps\OpenAI.Codex_* or openai-bundled)
 * that should be excluded from cross-AI import/distribution by default.
 */
export function detectBuiltinMcp(name, transport) {
  const lowerName = String(name ?? "").trim().toLowerCase();
  const cmd = String(transport?.command ?? "");
  const args = Array.isArray(transport?.args) ? transport.args.map(String) : [];
  const joined = [cmd, ...args].join(" ");

  // OpenAI Codex Desktop bundled MCPs (Windows MSIX, macOS app bundle, openai-bundled plugin cache)
  if (
    /WindowsApps[\\/]+OpenAI\.Codex_/i.test(joined) ||
    /Codex\.app[\\/]+Contents[\\/]+Resources/i.test(joined) ||
    /\.codex[\\/]+plugins[\\/]+cache[\\/]+openai-bundled/i.test(joined) ||
    /cua_node[\\/]+bin[\\/]+node_repl/i.test(joined) ||
    (lowerName === "node_repl" && /node_repl(?:\.exe)?$/i.test(cmd.trim()))
  ) {
    return { isBuiltin: true, vendor: "Codex", ownerTargetId: "codex" };
  }

  // Claude plugin-managed bundled cache
  if (/\.claude[\\/]+plugins[\\/]+cache[\\/]/i.test(joined)) {
    return { isBuiltin: true, vendor: "Claude", ownerTargetId: "claude-code" };
  }

  // Antigravity bundled builtin MCPs
  if (/\.gemini[\\/]+antigravity(?:-cli)?[\\/]+builtin[\\/]/i.test(joined)) {
    return { isBuiltin: true, vendor: "Antigravity", ownerTargetId: "antigravity" };
  }

  return { isBuiltin: false, vendor: null, ownerTargetId: null };
}

/**
 * Detect whether an MCP server looks like CodexHost's own loopback MCP endpoint.
 */
export function isCodexhostLoopbackServer(name, transport) {
  const lowerName = String(name ?? "").toLowerCase();
  if (transport?.type === "http" || transport?.type === "sse") {
    const url = String(transport.url ?? "").toLowerCase();
    if (/^https?:\/\/(127\.0\.0\.1|localhost):4398\/mcp\b/.test(url)) return true;
  }
  if (transport?.type === "stdio") {
    const joined = [transport.command, ...(transport.args ?? [])].join(" ").toLowerCase();
    if (joined.includes("127.0.0.1:4398/mcp") || joined.includes("localhost:4398/mcp")) return true;
  }
  return lowerName === "codexhost" && Boolean(transport?.url?.includes(":4398"));
}

/**
 * Stable deterministic fingerprint of an MCP transport so diff comparisons are accurate.
 */
export function transportSignature(transport) {
  if (!transport || typeof transport !== "object") return "";
  const sortObj = (obj) => {
    if (!obj || typeof obj !== "object") return undefined;
    const keys = Object.keys(obj).sort();
    if (keys.length === 0) return undefined;
    const out = {};
    for (const k of keys) out[k] = obj[k];
    return out;
  };
  if (transport.type === "stdio") {
    return JSON.stringify({
      type: "stdio",
      command: transport.command,
      args: transport.args ?? [],
      env: sortObj(transport.env),
      cwd: transport.cwd || undefined,
    });
  }
  return JSON.stringify({
    type: transport.type === "sse" ? "sse" : "http",
    url: transport.url,
    headers: sortObj(transport.headers),
    bearerTokenEnvVar: transport.bearerTokenEnvVar || undefined,
  });
}

/**
 * Parse arbitrary pasted JSON into an array of normalized MCP server specs:
 * Supports:
 *   1. { "mcpServers": { "name": { ... } } }
 *   2. { "mcp": { "name": { ... } } } (OpenCode)
 *   3. { "mcp_servers": { "name": { ... } } }
 *   4. { "my-server": { "command": "...", "args": [...] } }
 *   5. { "name": "my-server", "command": "...", "args": [...] }
 */
export function parseMcpJsonInput(jsonText) {
  let parsed;
  try {
    parsed = JSON.parse(String(jsonText ?? ""));
  } catch (err) {
    throw new Error(`Invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Expected a JSON object");
  }

  // Case 5: Single server object with explicit name + command/url
  if (
    typeof parsed.name === "string" &&
    (parsed.command || parsed.url || parsed.serverUrl || parsed.transport)
  ) {
    const rawTransport = parsed.transport && typeof parsed.transport === "object" ? parsed.transport : parsed;
    return [
      {
        name: normalizeServerName(parsed.name),
        description: typeof parsed.description === "string" ? parsed.description.trim() : "",
        enabled: parsed.enabled !== false && parsed.disabled !== true,
        transport: normalizeTransport(rawTransport),
      },
    ];
  }

  // Cases 1–3: Container object
  const mapCandidate =
    (parsed.mcpServers && typeof parsed.mcpServers === "object" && !Array.isArray(parsed.mcpServers)
      ? parsed.mcpServers
      : null) ||
    (parsed.mcp_servers && typeof parsed.mcp_servers === "object" && !Array.isArray(parsed.mcp_servers)
      ? parsed.mcp_servers
      : null) ||
    (parsed.mcp && typeof parsed.mcp === "object" && !Array.isArray(parsed.mcp) ? parsed.mcp : null) ||
    parsed;

  const results = [];
  for (const [key, value] of Object.entries(mapCandidate)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const rawTransport = value.transport && typeof value.transport === "object" ? value.transport : value;
    results.push({
      name: normalizeServerName(key),
      description: typeof value.description === "string" ? value.description.trim() : "",
      enabled: value.enabled !== false && value.disabled !== true,
      transport: normalizeTransport(rawTransport),
    });
  }

  if (results.length === 0) {
    throw new Error("No valid MCP server definitions found in JSON");
  }
  return results;
}

/**
 * Format a canonical server into standard mcpServers JSON snippet for preview/copy.
 */
export function toStandardMcpJson(server) {
  const t = server.transport;
  const entry =
    t.type === "stdio"
      ? {
          command: t.command,
          ...(t.args?.length ? { args: t.args } : {}),
          ...(t.env && Object.keys(t.env).length ? { env: t.env } : {}),
          ...(t.cwd ? { cwd: t.cwd } : {}),
        }
      : {
          type: t.type,
          url: t.url,
          ...(t.headers && Object.keys(t.headers).length ? { headers: t.headers } : {}),
        };
  return JSON.stringify({ mcpServers: { [server.name]: entry } }, null, 2);
}
