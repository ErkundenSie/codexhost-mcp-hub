/**
 * Fast, safe connectivity probe for MCP servers.
 * Respects CodexHost's 10s backend IPC timeout by capping probes well below 7s.
 */

import { access } from "node:fs/promises";
import path from "node:path";

/**
 * Probe a normalized MCP transport:
 *  - For `http` / `sse`: sends an MCP JSON-RPC `initialize` request (or GET fallback) within timeout.
 *  - For `stdio`: validates command structure & checks file existence if an absolute path is given.
 *    (Note: CodexHost backend child strips PATH, so short commands like `npx`/`uvx` are validated syntactically.)
 */
export async function probeMcpServer(server, timeoutMs = 4000) {
  const t = server?.transport;
  if (!t || typeof t !== "object") {
    return { ok: false, kind: "invalid", error: "Missing transport configuration" };
  }

  if (t.type === "stdio") {
    const cmd = String(t.command ?? "").trim();
    if (!cmd) {
      return { ok: false, kind: "stdio", error: "Missing command" };
    }
    if (path.isAbsolute(cmd)) {
      try {
        await access(cmd);
        return {
          ok: true,
          kind: "stdio",
          detail: `Executable found at ${cmd}`,
        };
      } catch {
        return {
          ok: false,
          kind: "stdio",
          error: `Executable not found: ${cmd}`,
        };
      }
    }
    return {
      ok: true,
      kind: "stdio",
      warn: true,
      detail: `Command "${cmd}" looks valid (resolved via each AI's shell PATH at runtime)`,
    };
  }

  // HTTP / SSE probe
  const clamped = Math.max(1000, Math.min(7000, Number(timeoutMs) || 4000));
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
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "codexhost-mcp-hub", version: "1.0.0" },
      },
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
      return {
        ok: true,
        needsAuth: false,
        kind: t.type,
        status: response.status,
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
