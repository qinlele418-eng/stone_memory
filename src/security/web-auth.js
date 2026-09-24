"use strict";

const crypto = require("crypto");

const SESSION_COOKIE = "stmem_web_session";
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

class WebAuthError extends Error {
  constructor(status, message, headers = {}) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}

function isLoopbackHost(value) {
  const host = String(value || "").trim().replace(/^\[|\]$/g, "").toLowerCase();
  return host === "localhost" || host === "::1" || host === "::ffff:127.0.0.1" || /^127(?:\.\d{1,3}){3}$/.test(host);
}

function isLoopbackAddress(value) {
  return isLoopbackHost(value);
}

function hashToken(token) {
  return `sha256:${crypto.createHash("sha256").update(String(token), "utf8").digest("hex")}`;
}

function generateToken() {
  return `stmem_${crypto.randomBytes(32).toString("base64url")}`;
}

function verifyToken(token, verifier) {
  if (!token || typeof verifier !== "string" || !verifier.startsWith("sha256:")) return false;
  const actual = Buffer.from(hashToken(token));
  const expected = Buffer.from(verifier);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function configuredAuth(config) {
  const auth = config?.web?.auth;
  return auth && typeof auth.tokenVerifier === "string" && auth.tokenVerifier.startsWith("sha256:") ? auth : null;
}

function parseCookies(header) {
  return Object.fromEntries(String(header || "").split(";").map(item => item.trim().split(/=(.*)/s)).filter(([key]) => key).map(([key, value]) => [key, value || ""]));
}

function requestOrigins(req, webConfig) {
  const origins = new Set();
  const scheme = req.socket?.encrypted ? "https" : "http";
  if (req.headers.host) origins.add(`${scheme}://${req.headers.host}`);
  const configured = String(webConfig?.publicUrl || "").trim();
  if (configured) {
    try { origins.add(new URL(configured).origin); } catch {}
  }
  return origins;
}

function isRemoteRequest(req) {
  if (!isLoopbackAddress(req.socket?.remoteAddress)) return true;
  try {
    return !isLoopbackHost(new URL(`http://${req.headers.host || ""}`).hostname);
  } catch {
    return true;
  }
}

function isPublicWebApiRoute(method, pathname) {
  return (method === "GET" && pathname === "/api/auth/status")
    || (method === "POST" && pathname === "/api/auth/unlock");
}

function createWebAuth({ host, configProvider, now = () => Date.now() }) {
  const sessions = new Map();
  const config = () => configProvider() || {};
  const authConfig = () => configuredAuth(config());
  const requiresAuth = () => Boolean(authConfig()) || !isLoopbackHost(host);

  function prune() {
    const current = now();
    for (const [id, session] of sessions) if (session.expiresAt <= current) sessions.delete(id);
  }

  function bearer(req) {
    const match = String(req.headers.authorization || "").match(/^Bearer\s+(.+)$/i);
    return match ? match[1].trim() : "";
  }

  function authenticate(req) {
    prune();
    if (!requiresAuth()) return { kind: "none" };
    const auth = authConfig();
    if (!auth) throw new WebAuthError(503, "此监听地址需要先配置 Web API Token");
    if (verifyToken(bearer(req), auth.tokenVerifier)) return { kind: "bearer" };
    const session = sessions.get(parseCookies(req.headers.cookie)[SESSION_COOKIE]);
    if (session && session.tokenVerifier === auth.tokenVerifier && session.expiresAt > now()) return { kind: "session" };
    throw new WebAuthError(401, "需要 Web API 访问令牌", { "www-authenticate": "Bearer" });
  }

  function assertSameOrigin(req, principal) {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method) || principal.kind === "bearer") return;
    const origin = String(req.headers.origin || "");
    const expected = requestOrigins(req, config().web);
    // When authentication is disabled on a loopback-only listener, keep
    // non-browser local tooling working (it has no Origin) while rejecting a
    // browser request that declares a foreign Origin. Cookie sessions require
    // an explicit same Origin because browsers attach their credential for us.
    const requiresExplicitOrigin = principal.kind === "session";
    if ((requiresExplicitOrigin && !origin) || (origin && !expected.has(origin)) || req.headers["sec-fetch-site"] === "cross-site") {
      throw new WebAuthError(403, "浏览器会话只能从同一来源执行写操作");
    }
  }

  function unlock(token, req) {
    const auth = authConfig();
    if (!auth || !verifyToken(token, auth.tokenVerifier)) {
      throw new WebAuthError(401, "Web API 访问令牌无效", { "www-authenticate": "Bearer" });
    }
    prune();
    const id = crypto.randomBytes(32).toString("base64url");
    sessions.set(id, { tokenVerifier: auth.tokenVerifier, expiresAt: now() + SESSION_TTL_MS });
    const secure = req.socket?.encrypted || /^https:/i.test(String(config().web?.publicUrl || ""));
    return `${SESSION_COOKIE}=${id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${secure ? "; Secure" : ""}`;
  }

  return {
    requiresAuth,
    authenticate,
    assertSameOrigin,
    unlock,
    status: () => ({ authenticationRequired: requiresAuth(), enabled: Boolean(authConfig()) }),
  };
}

module.exports = { WebAuthError, SESSION_COOKIE, SESSION_TTL_MS, isLoopbackHost, isLoopbackAddress, isRemoteRequest, hashToken, generateToken, configuredAuth, isPublicWebApiRoute, createWebAuth };
