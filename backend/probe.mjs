/**
 * Fast, safe connectivity & tool-count probe for MCP servers.
 * Respects CodexHost's 10s backend IPC timeout and stays free of subprocess spawns.
 */

import { readFileSync } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";

const MAX_DISCOVERED_TOOLS = 60;
const MAX_TOOL_DESC_LEN = 240;

function readClientVersion() {
  try {
    const { version } = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
    if (typeof version === "string" && version.trim()) return version.trim();
  } catch {
    // The probe can also run without a readable extension manifest.
  }
  return "0.0.0";
}

const INIT_PARAMS = {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "codexhost-mcp-hub", version: readClientVersion() },
};

function isLocalAbsolutePath(value) {
  const s = String(value ?? "").trim();
  if (!s || s.startsWith("-")) return false;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(s)) return false;
  if (/^[a-zA-Z]:[\\/]/.test(s)) return true;
  return process.platform !== "win32" && path.isAbsolute(s) && s.length > 1;
}

/**
 * Extract JSON-RPC message(s) from either plain JSON or text/event-stream (SSE) payload.
 */
function parseJsonRpcPayload(text) {
  const raw = String(text ?? "").trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    const msgs = [];
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const body = trimmed.slice(5).trim();
      if (!body || body === "[DONE]") continue;
      try {
        const parsed = JSON.parse(body);
        if (parsed && typeof parsed === "object") msgs.push(parsed);
      } catch {
        // Skip non-JSON SSE event lines
      }
    }
    return msgs;
  }
}

function extractToolsInfo(messages) {
  for (const msg of messages) {
    if (msg && typeof msg === "object" && Array.isArray(msg.result?.tools)) {
      const rawTools = msg.result.tools;
      const tools = [];
      for (const item of rawTools) {
        const name = typeof item?.name === "string" ? item.name.trim() : "";
        if (!name) continue;
        const rawDesc = typeof item?.description === "string" ? item.description.replace(/\s+/g, " ").trim() : "";
        const description =
          rawDesc.length > MAX_TOOL_DESC_LEN ? `${rawDesc.slice(0, MAX_TOOL_DESC_LEN - 1)}…` : rawDesc;
        tools.push({ name, description });
        if (tools.length >= MAX_DISCOVERED_TOOLS) break;
      }
      return {
        toolCount: rawTools.length,
        toolNames: tools.slice(0, 8).map((item) => item.name),
        tools,
      };
    }
  }
  return null;
}

/**
 * Probe a normalized MCP transport:
 *  - For `http` / `sse`: sends an MCP JSON-RPC `initialize` request (or GET fallback) within timeout,
 *    and on Streamable HTTP 2xx responses also queries `tools/list` to report tool count & preview.
 *  - For `stdio`: validates command structure, checks executable existence if an absolute path is given,
 *    and verifies any referenced local absolute script/config file paths in `args`.
 */
export async function probeMcpServer(server, timeoutMs = 4000, extraHeaders = null) {
  const t = server?.transport;
  if (!t || typeof t !== "object") {
    return { ok: false, kind: "invalid", error: "Missing transport configuration" };
  }

  const clamped = Math.max(1000, Math.min(7000, Number(timeoutMs) || 4000));

  if (t.type === "stdio") {
    const cmd = String(t.command ?? "").trim();
    if (!cmd) {
      return { ok: false, kind: "stdio", error: "Missing command" };
    }
    const cmdIsAbs = path.isAbsolute(cmd);
    if (cmdIsAbs) {
      try {
        await access(cmd);
      } catch {
        return {
          ok: false,
          kind: "stdio",
          error: `Executable not found: ${cmd}`,
        };
      }
    }

    const argPaths = (Array.isArray(t.args) ? t.args : []).filter((a) => isLocalAbsolutePath(a));
    for (const argPath of argPaths) {
      try {
        await access(argPath);
      } catch {
        return {
          ok: false,
          kind: "stdio",
          error: `Referenced file not found: ${argPath}`,
        };
      }
    }

    if (cmdIsAbs) {
      const extra = argPaths.length > 0 ? ` (+ ${argPaths.length} local file(s) verified)` : "";
      return {
        ok: true,
        kind: "stdio",
        detail: `Executable found at ${cmd}${extra}`,
      };
    }
    const extra = argPaths.length > 0 ? `; ${argPaths.length} local arg path(s) verified` : "";
    return {
      ok: true,
      kind: "stdio",
      warn: true,
      detail: `Command "${cmd}" looks valid (resolved via each AI's shell PATH at runtime${extra})`,
    };
  }

  // HTTP / SSE probe
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), clamped);

  try {
    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(extraHeaders && typeof extraHeaders === "object" ? extraHeaders : {}),
      ...(t.headers ?? {}),
    };
    const initPayload = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: INIT_PARAMS,
    });

    const response = await fetch(t.url, {
      method: t.type === "sse" ? "GET" : "POST",
      headers,
      body: t.type === "sse" ? undefined : initPayload,
      signal: controller.signal,
    });

    if (response.status === 401 || response.status === 403) {
      return {
        ok: true,
        needsAuth: true,
        kind: t.type,
        status: response.status,
      };
    }

    if (response.ok || response.status === 405 || response.status === 406) {
      let toolsInfo = null;
      if (t.type !== "sse" && response.ok && Date.now() - startedAt < clamped - 300) {
        try {
          const sessionId = response.headers.get("mcp-session-id");
          await response.text().catch(() => "");
          const listHeaders = sessionId ? { ...headers, "mcp-session-id": sessionId } : headers;
          await fetch(t.url, {
            method: "POST",
            headers: listHeaders,
            body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
            signal: controller.signal,
          })
            .then((r) => r.text().catch(() => ""))
            .catch(() => {});

          const listResp = await fetch(t.url, {
            method: "POST",
            headers: listHeaders,
            body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
            signal: controller.signal,
          });
          if (listResp.ok) {
            const listText = await listResp.text();
            toolsInfo = extractToolsInfo(parseJsonRpcPayload(listText));
          }
        } catch {
          // Keep reachability success even if server doesn't support stateless tools/list
        }
      }

      return {
        ok: true,
        needsAuth: false,
        kind: t.type,
        status: response.status,
        ...(toolsInfo
          ? { toolCount: toolsInfo.toolCount, toolNames: toolsInfo.toolNames, tools: toolsInfo.tools }
          : {}),
      };
    }

    return {
      ok: false,
      kind: t.type,
      status: response.status,
      error: `HTTP ${response.status} ${response.statusText || ""}`.trim(),
    };
  } catch (err) {
    const isAbort = err instanceof Error && err.name === "AbortError";
    return {
      ok: false,
      kind: t.type,
      error: isAbort ? `Timeout after ${clamped}ms` : err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}
