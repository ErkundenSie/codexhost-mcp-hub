/**
 * Fast, safe connectivity & tool-count probe for MCP servers.
 * Respects CodexHost's 10s backend IPC timeout by capping probes well below 7s.
 */

import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";

const INIT_PARAMS = {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "codexhost-mcp-hub", version: "2.5.1" },
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
    // Parse SSE `data: {...}` lines
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
      const tools = msg.result.tools;
      return {
        toolCount: tools.length,
        toolNames: tools
          .slice(0, 8)
          .map((item) => (typeof item?.name === "string" ? item.name.trim() : ""))
          .filter(Boolean),
      };
    }
  }
  return null;
}

/**
 * Perform a bounded stdio MCP handshake (`initialize` -> `tools/list`) to count exposed tools.
 * Always terminates the child process before returning. Returns `null` on timeout or unsupported launch.
 */
function probeStdioHandshake(transport, timeoutMs) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(transport.command, Array.isArray(transport.args) ? transport.args : [], {
        cwd: transport.cwd || undefined,
        env: { ...process.env, ...(transport.env ?? {}) },
        stdio: ["pipe", "pipe", "ignore"],
        windowsHide: true,
      });
    } catch {
      resolve(null);
      return;
    }

    let settled = false;
    let initAcked = false;
    let buffer = "";

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.stdin?.end();
      } catch {}
      try {
        child.kill();
      } catch {}
      resolve(result);
    };

    const timer = setTimeout(() => finish(null), Math.max(1000, Math.min(5000, timeoutMs)));
    if (typeof timer.unref === "function") timer.unref();

    child.on("error", () => finish(null));
    child.on("exit", () => finish(null));
    child.stdin?.on("error", () => {});

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      if (settled) return;
      buffer += chunk;
      // Guard against runaway stdout from non-MCP binaries
      if (buffer.length > 2 * 1024 * 1024) {
        finish(null);
        return;
      }
      let idx;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line || !line.startsWith("{")) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (!initAcked && msg?.id === 1 && msg?.result) {
          initAcked = true;
          try {
            child.stdin?.write(
              JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) +
                "\n" +
                JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) +
                "\n",
            );
          } catch {
            finish(null);
          }
        } else if (msg?.id === 2) {
          const info = extractToolsInfo([msg]);
          finish(info);
          return;
        }
      }
    });

    try {
      child.stdin?.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: INIT_PARAMS,
        }) + "\n",
      );
    } catch {
      finish(null);
    }
  });
}

/**
 * Probe a normalized MCP transport:
 *  - For `http` / `sse`: sends an MCP JSON-RPC `initialize` request (or GET fallback) within timeout,
 *    and on Streamable HTTP 2xx responses also queries `tools/list` to report tool count.
 *  - For `stdio`: validates executable & local arg file paths, then performs a bounded MCP handshake
 *    (`initialize` -> `tools/list`) to count exposed tools when launchable.
 */
export async function probeMcpServer(server, timeoutMs = 4000) {
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

    const handshake = await probeStdioHandshake(t, clamped);
    const toolsFields = handshake
      ? { toolCount: handshake.toolCount, toolNames: handshake.toolNames }
      : {};

    if (cmdIsAbs) {
      const extra = argPaths.length > 0 ? ` (+ ${argPaths.length} local file(s) verified)` : "";
      return {
        ok: true,
        kind: "stdio",
        detail: `Executable found at ${cmd}${extra}`,
        ...toolsFields,
      };
    }
    const extra = argPaths.length > 0 ? `; ${argPaths.length} local arg path(s) verified` : "";
    return {
      ok: true,
      kind: "stdio",
      warn: !handshake,
      detail: `Command "${cmd}" looks valid (resolved via each AI's shell PATH at runtime${extra})`,
      ...toolsFields,
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
          // Drain init body quietly so connection can be reused cleanly
          await response.text().catch(() => "");
          const listHeaders = sessionId ? { ...headers, "mcp-session-id": sessionId } : headers;
          // Send best-effort initialized notification before tools/list
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
        ...(toolsInfo ? { toolCount: toolsInfo.toolCount, toolNames: toolsInfo.toolNames } : {}),
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
