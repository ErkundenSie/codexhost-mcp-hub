/**
 * Pure-Node MCP OAuth 2.1 (PKCE S256 + RFC 9728 / RFC 8414 / RFC 7591) manager.
 *
 * Designed specifically for CodexHost extensions:
 * - Zero subprocess spawns so it passes registry static security scans cleanly.
 * - Non-blocking 2-phase browser flow (`startLogin` returns immediately within IPC timeout;
 *   local `127.0.0.1` loopback listener waits for redirect callback).
 * - Tokens are persisted in plugin-private `oauth-tokens.json`; raw secrets are never sent
 *   in `overview` payloads to the frontend.
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, readFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { atomicWriteText } from "./adapters.mjs";

const TOKENS_FILE = "oauth-tokens.json";
const SESSION_TTL_MS = 180_000;
const TOKEN_SKEW_MS = 60_000;
const AUTO_REFRESH_THRESHOLD_MS = 5 * 60_000;
const AUTO_REFRESH_INTERVAL_MS = 60_000;

export function normalizeOAuthServerKey(rawUrl) {
  const u = new URL(String(rawUrl ?? "").trim());
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error("OAuth is only supported for http:// or https:// MCP servers");
  }
  const cleanPath = u.pathname.replace(/\/+$/, "") || "/";
  return `${u.origin}${cleanPath}`;
}

export function makeOAuthTokenKey(serverId, serverUrl) {
  const id = typeof serverId === "string" ? serverId.trim() : "";
  if (id) return `card:${id}`;
  return normalizeOAuthServerKey(serverUrl);
}

export function hasExplicitAuthHeader(headers) {
  if (!headers || typeof headers !== "object") return false;
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === "authorization" && String(v ?? "").trim()) {
      return true;
    }
  }
  return false;
}

function isHttpUrl(value) {
  try {
    const u = new URL(String(value ?? ""));
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function escapeHtml(text) {
  return String(text ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function renderCallbackHtml({ ok, title, detail }) {
  const accent = ok ? "#15803d" : "#dc2626";
  const badge = ok ? "✓" : "!";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC",sans-serif;
    background:#f8fafc; color:#0f172a; padding:24px; }
  .card { max-width:440px; width:100%; background:#fff; border:1px solid #e2e8f0;
    border-radius:14px; padding:28px 24px; text-align:center; box-shadow:0 8px 24px rgba(15,23,42,.06); }
  .icon { width:44px; height:44px; border-radius:50%; margin:0 auto 14px; display:flex;
    align-items:center; justify-content:center; font-size:20px; font-weight:700;
    color:#fff; background:${accent}; }
  h1 { margin:0 0 8px; font-size:18px; }
  p { margin:0; font-size:13.5px; color:#475569; line-height:1.55; }
</style>
</head>
<body>
  <div class="card">
    <div class="icon">${badge}</div>
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(detail)}</p>
  </div>
</body>
</html>`;
}

function parseResourceMetadataUrl(wwwAuthHeader) {
  if (!wwwAuthHeader || typeof wwwAuthHeader !== "string") return null;
  const match = wwwAuthHeader.match(/resource_metadata\s*=\s*"([^"]+)"/i);
  if (match && isHttpUrl(match[1])) return match[1];
  const unquoted = wwwAuthHeader.match(/resource_metadata\s*=\s*([^\s,]+)/i);
  if (unquoted && isHttpUrl(unquoted[1])) return unquoted[1];
  return null;
}

async function fetchJsonWithTimeout(url, options = {}, timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { ...options, signal: controller.signal });
    const text = await resp.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { ok: resp.ok, status: resp.status, headers: resp.headers, json, text };
  } finally {
    clearTimeout(timer);
  }
}

export async function discoverOAuthMetadata(serverUrl, timeoutMs = 5000) {
  const targetUrl = new URL(serverUrl);
  const origin = targetUrl.origin;
  const pathNoSlash = targetUrl.pathname.replace(/\/+$/, "");

  // 1. Inspect WWW-Authenticate for RFC 9728 resource_metadata hint (POST, with GET fallback for SSE)
  let resourceMetaFromHeader = null;
  try {
    const probe = await fetchJsonWithTimeout(
      serverUrl,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "codexhost-mcp-hub", version: "2.5.4" },
          },
        }),
      },
      Math.min(timeoutMs, 4000),
    );
    resourceMetaFromHeader = parseResourceMetadataUrl(probe.headers.get("www-authenticate"));
    if (!resourceMetaFromHeader && (probe.status === 405 || probe.status === 404 || probe.status === 400)) {
      const getProbe = await fetchJsonWithTimeout(
        serverUrl,
        {
          method: "GET",
          headers: { Accept: "text/event-stream, application/json" },
        },
        Math.min(timeoutMs, 3000),
      );
      resourceMetaFromHeader = parseResourceMetadataUrl(getProbe.headers.get("www-authenticate"));
    }
  } catch {
    // Continue to well-known fallback discovery
  }

  // 2. Fetch RFC 9728 Protected Resource Metadata
  const prmCandidates = [];
  if (resourceMetaFromHeader) prmCandidates.push(resourceMetaFromHeader);
  if (pathNoSlash && pathNoSlash !== "/") {
    prmCandidates.push(`${origin}/.well-known/oauth-protected-resource${pathNoSlash}`);
  }
  prmCandidates.push(`${origin}/.well-known/oauth-protected-resource`);

  let protectedMeta = null;
  for (const url of [...new Set(prmCandidates)]) {
    try {
      const res = await fetchJsonWithTimeout(url, { method: "GET", headers: { Accept: "application/json" } }, timeoutMs);
      if (res.ok && res.json && typeof res.json === "object") {
        protectedMeta = res.json;
        break;
      }
    } catch {
      // Try next candidate
    }
  }

  const authServerRaw =
    Array.isArray(protectedMeta?.authorization_servers) && isHttpUrl(protectedMeta.authorization_servers[0])
      ? protectedMeta.authorization_servers[0]
      : origin;
  const authUrlObj = new URL(authServerRaw);
  const authOrigin = authUrlObj.origin;
  const authPath = authUrlObj.pathname.replace(/\/+$/, "");

  // 3. Fetch RFC 8414 / OIDC Authorization Server Metadata
  const asCandidates = [];
  if (authPath && authPath !== "/") {
    asCandidates.push(`${authOrigin}/.well-known/oauth-authorization-server${authPath}`);
    asCandidates.push(`${authOrigin}${authPath}/.well-known/openid-configuration`);
  }
  asCandidates.push(`${authOrigin}/.well-known/oauth-authorization-server`);
  asCandidates.push(`${authOrigin}/.well-known/openid-configuration`);

  let authMeta = null;
  for (const url of [...new Set(asCandidates)]) {
    try {
      const res = await fetchJsonWithTimeout(url, { method: "GET", headers: { Accept: "application/json" } }, timeoutMs);
      if (
        res.ok &&
        res.json &&
        isHttpUrl(res.json.authorization_endpoint) &&
        isHttpUrl(res.json.token_endpoint)
      ) {
        authMeta = res.json;
        break;
      }
    } catch {
      // Try next candidate
    }
  }

  if (!authMeta) {
    throw new Error(
      `OAuth metadata not found for ${origin} (server does not expose RFC 9728 / RFC 8414 discovery endpoints)`,
    );
  }

  const scopesSupported = Array.isArray(protectedMeta?.scopes_supported) && protectedMeta.scopes_supported.length > 0
    ? protectedMeta.scopes_supported
    : Array.isArray(authMeta.scopes_supported)
      ? authMeta.scopes_supported
      : [];

  return {
    authorizationEndpoint: authMeta.authorization_endpoint,
    tokenEndpoint: authMeta.token_endpoint,
    registrationEndpoint: isHttpUrl(authMeta.registration_endpoint) ? authMeta.registration_endpoint : null,
    resource: typeof protectedMeta?.resource === "string" && isHttpUrl(protectedMeta.resource)
      ? protectedMeta.resource
      : null,
    scope: scopesSupported.filter((s) => typeof s === "string" && s.trim()).join(" "),
  };
}

async function registerDynamicClient(registrationEndpoint, redirectUri, timeoutMs = 5000) {
  if (!registrationEndpoint) {
    throw new Error(
      "Authorization server does not advertise a Dynamic Client Registration (RFC 7591) endpoint",
    );
  }
  const res = await fetchJsonWithTimeout(
    registrationEndpoint,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        client_name: "CodexHost MCP Sync Hub",
        redirect_uris: [redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    },
    timeoutMs,
  );
  if (!res.ok || !res.json || typeof res.json.client_id !== "string" || !res.json.client_id.trim()) {
    const errMsg = res.json?.error_description || res.json?.error || `HTTP ${res.status}`;
    throw new Error(`OAuth dynamic client registration failed: ${errMsg}`);
  }
  return {
    clientId: res.json.client_id.trim(),
    clientSecret: typeof res.json.client_secret === "string" ? res.json.client_secret : "",
  };
}

function buildTokenFormBody(params) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && String(v) !== "") {
      body.set(k, String(v));
    }
  }
  return body.toString();
}

export class OAuthManager {
  constructor({ dataDir, onChange = null }) {
    this.dataDir = dataDir;
    this.tokensPath = path.join(dataDir, TOKENS_FILE);
    this.onChange = onChange;
    /** @type {Map<string, object>} keyed by server.id */
    this.sessions = new Map();
    /** @type {Map<string, Promise<object>>} keyed by normalized serverKey to prevent double refresh */
    this._refreshInFlight = new Map();
    /** @type {ReturnType<typeof setInterval> | null} */
    this._autoRefreshTimer = null;
    this._autoRefreshRunning = false;
    /** @type {Record<string, object> | null} */
    this._cache = null;
  }

  async _loadTokens() {
    if (this._cache) return this._cache;
    try {
      const text = await readFile(this.tokensPath, "utf8");
      const parsed = JSON.parse(text);
      this._cache = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      this._cache = {};
    }
    return this._cache;
  }

  async _saveTokens(map) {
    this._cache = map;
    await atomicWriteText(this.tokensPath, JSON.stringify(map, null, 2) + "\n");
    if (process.platform !== "win32") {
      await chmod(this.tokensPath, 0o600).catch(() => {});
    }
  }

  async migrateLegacyTokens(servers) {
    const tokens = await this._loadTokens();
    const legacyKeys = Object.keys(tokens).filter((k) => !k.startsWith("card:"));
    if (legacyKeys.length === 0 || !Array.isArray(servers) || servers.length === 0) {
      return false;
    }
    let changed = false;
    for (const legacyKey of legacyKeys) {
      const record = tokens[legacyKey];
      if (!record || !record.accessToken) continue;
      const matches = servers.filter((s) => {
        if (!s?.id || !s.transport?.url) return false;
        if (s.transport.type !== "http" && s.transport.type !== "sse") return false;
        if (tokens[`card:${s.id}`]) return false;
        try {
          return normalizeOAuthServerKey(s.transport.url) === legacyKey;
        } catch {
          return false;
        }
      });
      if (matches.length === 0) continue;
      // Prefer a card already using OAuth header sync, else unaliased primary card, else first match
      const chosen =
        matches.find((s) => s.oauthHeaderManaged) ||
        matches.find((s) => !s.alias) ||
        matches[0];
      tokens[`card:${chosen.id}`] = {
        ...record,
        serverId: chosen.id,
        serverUrl: record.serverUrl || chosen.transport.url,
      };
      delete tokens[legacyKey];
      changed = true;
    }
    if (changed) {
      await this._saveTokens(tokens);
    }
    return changed;
  }

  _findRecord(tokens, serverUrl, serverId = null) {
    let urlKey;
    try {
      urlKey = normalizeOAuthServerKey(serverUrl);
    } catch {
      return null;
    }
    const id = typeof serverId === "string" ? serverId.trim() : "";
    if (id) {
      const cardKey = `card:${id}`;
      const rec = tokens[cardKey];
      if (rec && rec.accessToken) {
        try {
          if (!rec.serverUrl || normalizeOAuthServerKey(rec.serverUrl) === urlKey) {
            return { storageKey: cardKey, urlKey, record: rec };
          }
        } catch {
          return null;
        }
      }
      return null;
    }
    const legacyRec = tokens[urlKey];
    if (legacyRec && legacyRec.accessToken) {
      return { storageKey: urlKey, urlKey, record: legacyRec };
    }
    return null;
  }

  async getPublicStatus(serverUrl, serverId = null) {
    try {
      normalizeOAuthServerKey(serverUrl);
    } catch {
      return null;
    }
    const tokens = await this._loadTokens();
    const found = this._findRecord(tokens, serverUrl, serverId);
    const record = found?.record;
    if (!record || !record.accessToken) {
      return {
        authenticated: false,
        expired: false,
        expiresAt: null,
        hasRefreshToken: false,
        obtainedAt: null,
        scope: "",
      };
    }
    const expiresAt = typeof record.expiresAt === "number" ? record.expiresAt : null;
    const expired = expiresAt !== null && Date.now() >= expiresAt - TOKEN_SKEW_MS;
    return {
      authenticated: true,
      expired,
      expiresAt,
      hasRefreshToken: Boolean(record.refreshToken),
      obtainedAt: record.obtainedAt || null,
      scope: record.scope || "",
    };
  }

  getPendingStatus(serverId) {
    const sess = this.sessions.get(serverId);
    if (!sess) {
      return { status: "idle" };
    }
    if (sess.status === "pending" && Date.now() >= sess.expiresAt) {
      this._cleanupSession(serverId, "error", "OAuth login timed out waiting for browser callback");
      return {
        status: "error",
        sessionId: sess.sessionId,
        error: "OAuth login timed out waiting for browser callback",
      };
    }
    return {
      status: sess.status,
      sessionId: sess.sessionId,
      authUrl: sess.authUrl,
      redirectUri: sess.redirectUri,
      expiresAt: sess.expiresAt,
      error: sess.error || null,
    };
  }

  _cleanupSession(serverId, finalStatus = null, error = null) {
    const sess = this.sessions.get(serverId);
    if (!sess) return;
    if (sess.timer) {
      clearTimeout(sess.timer);
      sess.timer = null;
    }
    if (sess.httpServer) {
      try {
        sess.httpServer.close();
      } catch {
        // Ignore close errors
      }
      sess.httpServer = null;
    }
    if (finalStatus) {
      sess.status = finalStatus;
      sess.error = error;
      sess.authUrl = null;
      sess.codeVerifier = "";
      sess.state = "";
      sess.timer = setTimeout(() => {
        if (this.sessions.get(serverId) === sess) {
          this.sessions.delete(serverId);
        }
      }, 60_000);
      sess.timer.unref?.();
    } else {
      this.sessions.delete(serverId);
    }
  }

  async _exchangeCode(sess, code) {
    const payload = buildTokenFormBody({
      grant_type: "authorization_code",
      code,
      redirect_uri: sess.redirectUri,
      client_id: sess.clientId,
      client_secret: sess.clientSecret || undefined,
      code_verifier: sess.codeVerifier,
      resource: sess.resource || undefined,
    });
    const res = await fetchJsonWithTimeout(
      sess.tokenEndpoint,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: payload,
      },
      8000,
    );
    if (!res.ok || !res.json || typeof res.json.access_token !== "string" || !res.json.access_token) {
      const errMsg = res.json?.error_description || res.json?.error || `HTTP ${res.status}`;
      throw new Error(`Token exchange failed: ${errMsg}`);
    }
    const expiresIn = Number(res.json.expires_in);
    const expiresAt = Number.isFinite(expiresIn) && expiresIn > 0 ? Date.now() + expiresIn * 1000 : null;
    const tokens = await this._loadTokens();
    const storageKey = makeOAuthTokenKey(sess.serverId, sess.serverUrl);
    tokens[storageKey] = {
      serverId: sess.serverId || "",
      serverUrl: sess.serverUrl,
      accessToken: res.json.access_token,
      refreshToken: typeof res.json.refresh_token === "string" ? res.json.refresh_token : "",
      tokenType: typeof res.json.token_type === "string" && res.json.token_type.trim()
        ? res.json.token_type.trim()
        : "Bearer",
      expiresAt,
      scope: typeof res.json.scope === "string" ? res.json.scope : sess.scope || "",
      tokenEndpoint: sess.tokenEndpoint,
      clientId: sess.clientId,
      clientSecret: sess.clientSecret || "",
      resource: sess.resource || "",
      obtainedAt: new Date().toISOString(),
    };
    await this._saveTokens(tokens);
  }

  async startLogin(server, timeoutMs = 5000) {
    const url = server?.transport?.url;
    if (!url || (server.transport?.type !== "http" && server.transport?.type !== "sse")) {
      throw new Error("OAuth is only supported for HTTP or SSE MCP servers");
    }
    const serverKey = normalizeOAuthServerKey(url);
    this._cleanupSession(server.id, null);

    // 1. Bind ephemeral loopback callback server
    const httpServer = http.createServer();
    await new Promise((resolve, reject) => {
      httpServer.once("error", reject);
      httpServer.listen(0, "127.0.0.1", resolve);
    });
    const addr = httpServer.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    const redirectUri = `http://127.0.0.1:${port}/callback`;

    let meta;
    let client;
    try {
      meta = await discoverOAuthMetadata(url, timeoutMs);
      client = await registerDynamicClient(meta.registrationEndpoint, redirectUri, timeoutMs);
    } catch (err) {
      try {
        httpServer.close();
      } catch {
        // ignore
      }
      throw err;
    }

    const sessionId = randomUUID();
    const state = randomBytes(24).toString("base64url");
    const codeVerifier = randomBytes(32).toString("base64url");
    const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");

    const authUrlObj = new URL(meta.authorizationEndpoint);
    authUrlObj.searchParams.set("response_type", "code");
    authUrlObj.searchParams.set("client_id", client.clientId);
    authUrlObj.searchParams.set("redirect_uri", redirectUri);
    authUrlObj.searchParams.set("state", state);
    authUrlObj.searchParams.set("code_challenge", codeChallenge);
    authUrlObj.searchParams.set("code_challenge_method", "S256");
    if (meta.scope) authUrlObj.searchParams.set("scope", meta.scope);
    if (meta.resource) authUrlObj.searchParams.set("resource", meta.resource);

    const sess = {
      sessionId,
      serverId: server.id,
      serverKey,
      serverUrl: url,
      authUrl: authUrlObj.toString(),
      redirectUri,
      state,
      codeVerifier,
      tokenEndpoint: meta.tokenEndpoint,
      clientId: client.clientId,
      clientSecret: client.clientSecret,
      resource: meta.resource,
      scope: meta.scope,
      httpServer,
      status: "pending",
      exchanging: false,
      error: null,
      createdAt: Date.now(),
      expiresAt: Date.now() + SESSION_TTL_MS,
      timer: null,
    };

    httpServer.on("request", async (req, res) => {
      try {
        const reqUrl = new URL(req.url || "/", `http://127.0.0.1:${port}`);
        if (reqUrl.pathname !== "/callback") {
          res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("Not Found");
          return;
        }
        if (sess.exchanging || sess.status !== "pending") {
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(
            renderCallbackHtml({
              ok: true,
              title: "Authorization In Progress / 正在完成授权",
              detail: "This authorization callback has already been received. You can close this tab.",
            }),
          );
          return;
        }
        const errParam = reqUrl.searchParams.get("error");
        const errDesc = reqUrl.searchParams.get("error_description");
        if (errParam) {
          const msg = errDesc ? `${errParam}: ${errDesc}` : errParam;
          this._cleanupSession(server.id, "error", msg);
          res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
          res.end(
            renderCallbackHtml({
              ok: false,
              title: "OAuth Authorization Failed",
              detail: msg,
            }),
          );
          this.onChange?.();
          return;
        }
        const incomingState = reqUrl.searchParams.get("state");
        const code = reqUrl.searchParams.get("code");
        if (!code || incomingState !== sess.state) {
          const msg = "Invalid OAuth callback state or missing authorization code";
          this._cleanupSession(server.id, "error", msg);
          res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
          res.end(renderCallbackHtml({ ok: false, title: "Invalid OAuth Callback", detail: msg }));
          this.onChange?.();
          return;
        }

        sess.exchanging = true;
        await this._exchangeCode(sess, code);
        this._cleanupSession(server.id, "completed", null);
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(
          renderCallbackHtml({
            ok: true,
            title: "Authorization Complete / 授权成功",
            detail: "You can close this browser tab and return to CodexHost MCP Sync Hub. 您可以关闭此页面并返回 CodexHost。",
          }),
        );
        this.onChange?.();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this._cleanupSession(server.id, "error", msg);
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
          res.end(renderCallbackHtml({ ok: false, title: "OAuth Error", detail: msg }));
        }
        this.onChange?.();
      }
    });

    sess.timer = setTimeout(() => {
      if (sess.status === "pending") {
        this._cleanupSession(server.id, "error", "OAuth login timed out waiting for browser callback");
        this.onChange?.();
      }
    }, SESSION_TTL_MS);
    sess.timer.unref?.();

    this.sessions.set(server.id, sess);
    return {
      sessionId: sess.sessionId,
      authUrl: sess.authUrl,
      redirectUri: sess.redirectUri,
      expiresAt: sess.expiresAt,
    };
  }

  cancelLogin(serverId) {
    this._cleanupSession(serverId, null);
    return { ok: true };
  }

  async refreshTokenWithDetails(serverUrl, timeoutMs = 6000, serverId = null) {
    const urlKey = normalizeOAuthServerKey(serverUrl);
    const storageKey = makeOAuthTokenKey(serverId, serverUrl);
    const existingFlight = this._refreshInFlight.get(storageKey);
    if (existingFlight) {
      return existingFlight;
    }

    const work = (async () => {
      const tokens = await this._loadTokens();
      const found = this._findRecord(tokens, serverUrl, serverId);
      const record = found?.record;
      const actualKey = found?.storageKey || storageKey;
      if (!record || !record.refreshToken || !record.tokenEndpoint) {
        throw new Error("No refresh token available for this MCP server — please log in again");
      }
      const previousAccessToken = record.accessToken || "";
      const payload = buildTokenFormBody({
        grant_type: "refresh_token",
        refresh_token: record.refreshToken,
        client_id: record.clientId,
        client_secret: record.clientSecret || undefined,
        resource: record.resource || undefined,
      });
      const res = await fetchJsonWithTimeout(
        record.tokenEndpoint,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Accept: "application/json",
          },
          body: payload,
        },
        timeoutMs,
      );
      if (!res.ok || !res.json || typeof res.json.access_token !== "string" || !res.json.access_token) {
        const errMsg = res.json?.error_description || res.json?.error || `HTTP ${res.status}`;
        throw new Error(`Token refresh failed: ${errMsg}`);
      }
      const expiresIn = Number(res.json.expires_in);
      const expiresAt = Number.isFinite(expiresIn) && expiresIn > 0 ? Date.now() + expiresIn * 1000 : null;
      const nextTokenType =
        typeof res.json.token_type === "string" && res.json.token_type.trim()
          ? res.json.token_type.trim()
          : record.tokenType || "Bearer";
      const resolvedServerId = (typeof serverId === "string" && serverId.trim()) || record.serverId || "";
      tokens[actualKey] = {
        ...record,
        serverId: resolvedServerId,
        accessToken: res.json.access_token,
        refreshToken:
          typeof res.json.refresh_token === "string" && res.json.refresh_token
            ? res.json.refresh_token
            : record.refreshToken,
        tokenType: nextTokenType,
        expiresAt,
        scope: typeof res.json.scope === "string" ? res.json.scope : record.scope || "",
        obtainedAt: new Date().toISOString(),
      };
      await this._saveTokens(tokens);
      this.onChange?.();
      return {
        status: await this.getPublicStatus(serverUrl, resolvedServerId || null),
        storageKey: actualKey,
        serverId: resolvedServerId || null,
        serverKey: urlKey,
        serverUrl: record.serverUrl || serverUrl,
        previousAccessToken,
        accessToken: res.json.access_token,
        tokenType: nextTokenType,
        expiresAt,
      };
    })();

    this._refreshInFlight.set(storageKey, work);
    try {
      return await work;
    } finally {
      this._refreshInFlight.delete(storageKey);
    }
  }

  async refreshToken(serverUrl, timeoutMs = 6000, serverId = null) {
    const res = await this.refreshTokenWithDetails(serverUrl, timeoutMs, serverId);
    return res.status;
  }

  async refreshDueTokens({ thresholdMs = AUTO_REFRESH_THRESHOLD_MS, timeoutMs = 6000 } = {}) {
    const tokens = await this._loadTokens();
    const now = Date.now();
    const due = [];
    for (const [key, record] of Object.entries(tokens)) {
      if (!record || !record.refreshToken || !record.tokenEndpoint) continue;
      if (typeof record.expiresAt !== "number") continue;
      if (now >= record.expiresAt - thresholdMs) {
        const inferredId = key.startsWith("card:") ? key.slice(5) : record.serverId || null;
        due.push({ key, serverId: inferredId, serverUrl: record.serverUrl || key });
      }
    }
    const refreshed = [];
    for (const item of due) {
      try {
        const res = await this.refreshTokenWithDetails(item.serverUrl, timeoutMs, item.serverId);
        refreshed.push(res);
      } catch {
        // Ignore single-server transient refresh errors; user can still manually re-login
      }
    }
    return refreshed;
  }

  startAutoRefresh({
    intervalMs = AUTO_REFRESH_INTERVAL_MS,
    thresholdMs = AUTO_REFRESH_THRESHOLD_MS,
    timeoutMs = 6000,
    onRefreshed = null,
  } = {}) {
    if (this._autoRefreshTimer) return;
    const tick = async () => {
      if (this._autoRefreshRunning) return;
      this._autoRefreshRunning = true;
      try {
        const refreshed = await this.refreshDueTokens({ thresholdMs, timeoutMs });
        if (onRefreshed && refreshed.length > 0) {
          for (const item of refreshed) {
            try {
              await onRefreshed(item);
            } catch {
              // Keep background loop resilient
            }
          }
        }
      } finally {
        this._autoRefreshRunning = false;
      }
    };
    this._autoRefreshTimer = setInterval(() => {
      void tick();
    }, intervalMs);
    this._autoRefreshTimer.unref?.();
    // Run an immediate startup check so tokens that expired while CodexHost was closed recover immediately
    void tick();
  }

  stopAutoRefresh() {
    if (this._autoRefreshTimer) {
      clearInterval(this._autoRefreshTimer);
      this._autoRefreshTimer = null;
    }
  }

  async getValidAccessToken(serverUrl, timeoutMs = 4000, serverId = null) {
    const tokens = await this._loadTokens();
    const found = this._findRecord(tokens, serverUrl, serverId);
    const record = found?.record;
    if (!record || !record.accessToken) return null;

    const expired = typeof record.expiresAt === "number" && Date.now() >= record.expiresAt - TOKEN_SKEW_MS;
    if (expired && record.refreshToken && record.tokenEndpoint) {
      try {
        const refreshed = await this.refreshTokenWithDetails(serverUrl, timeoutMs, serverId);
        if (refreshed?.accessToken) {
          return { accessToken: refreshed.accessToken, tokenType: refreshed.tokenType || "Bearer" };
        }
      } catch {
        // Fall through to return null so caller triggers re-auth
        return null;
      }
    }
    if (expired) return null;
    return { accessToken: record.accessToken, tokenType: record.tokenType || "Bearer" };
  }

  async logout(serverUrl, serverId = null) {
    const tokens = await this._loadTokens();
    const id = typeof serverId === "string" ? serverId.trim() : "";
    let removed = false;
    if (id && `card:${id}` in tokens) {
      delete tokens[`card:${id}`];
      removed = true;
    } else if (!id) {
      const key = normalizeOAuthServerKey(serverUrl);
      if (key in tokens) {
        delete tokens[key];
        removed = true;
      }
    }
    if (removed) {
      await this._saveTokens(tokens);
      this.onChange?.();
    }
    return { ok: true };
  }

  async deleteCardToken(serverId) {
    const id = typeof serverId === "string" ? serverId.trim() : "";
    if (!id) return { ok: true };
    const tokens = await this._loadTokens();
    if (`card:${id}` in tokens) {
      delete tokens[`card:${id}`];
      await this._saveTokens(tokens);
      this.onChange?.();
    }
    return { ok: true };
  }

  dispose() {
    this.stopAutoRefresh();
    for (const serverId of [...this.sessions.keys()]) {
      this._cleanupSession(serverId, null);
    }
  }
}
