"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { loadConfig } = require("../config");
const { saveConfig } = require("./thread-setup");
const { generateToken, hashToken, verifyToken, configuredAuth } = require("../security/web-auth");
const { assertPrivateFileTarget, writePrivateFile } = require("../security/local-data-permissions");

const DEVICE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DEVICE_REFRESH_MS = 6 * 60 * 60 * 1000;

function defaultSessionFile() {
  return path.join(os.homedir(), ".stone_memory", "web-sessions.json");
}

function deviceLabel(req) {
  return String(req?.headers?.["user-agent"] || "浏览器设备").replace(/[\u0000-\u001f\u007f]/gu, " ").trim().slice(0, 160) || "浏览器设备";
}

function createWebSessionStore({ file = defaultSessionFile(), now = () => Date.now(), trustedRoot = os.homedir() } = {}) {
  function read() {
    assertPrivateFileTarget(file, { trustedRoot });
    if (!fs.existsSync(file)) return { schemaVersion:1, sessions:[] };
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!parsed || parsed.schemaVersion !== 1 || !Array.isArray(parsed.sessions)) throw new Error("Web 设备会话文件格式无效");
    return parsed;
  }

  function write(value) {
    writePrivateFile(file, JSON.stringify(value, null, 2), { encoding:"utf8" }, { trustedRoot });
  }

  function active(value) {
    const current = now();
    const sessions = value.sessions.filter(item => Number(item.expiresAt) > current);
    if (sessions.length !== value.sessions.length) write({ schemaVersion:1, sessions });
    return sessions;
  }

  function create({ tokenVerifier, request }) {
    const value = read(), sessions = active(value);
    const id = crypto.randomUUID(), secret = crypto.randomBytes(32).toString("base64url"), current = now();
    sessions.push({
      id, secretVerifier:hashToken(secret), tokenVerifier,
      label:deviceLabel(request), createdAt:current, lastSeenAt:current, expiresAt:current + DEVICE_TTL_MS,
    });
    write({ schemaVersion:1, sessions });
    return { credential:`${id}.${secret}`, deviceId:id, expiresAt:current + DEVICE_TTL_MS };
  }

  function find(credential, { tokenVerifier }) {
    const [id, secret] = String(credential || "").split(".", 2);
    if (!id || !secret) return null;
    const value = read(), sessions = active(value), session = sessions.find(item => item.id === id);
    if (!session || session.tokenVerifier !== tokenVerifier || !verifyToken(secret, session.secretVerifier)) return null;
    const current = now();
    let refreshed = false;
    if (current - Number(session.lastSeenAt || 0) >= DEVICE_REFRESH_MS) {
      session.lastSeenAt = current;
      session.expiresAt = current + DEVICE_TTL_MS;
      write({ schemaVersion:1, sessions });
      refreshed = true;
    }
    return { deviceId:session.id, label:session.label, expiresAt:session.expiresAt, refreshed };
  }

  function list() {
    const value = read();
    return active(value).map(({ id, label, createdAt, lastSeenAt, expiresAt }) => ({ id, label, createdAt, lastSeenAt, expiresAt }));
  }

  function revoke(id) {
    const value = read(), sessions = active(value), next = sessions.filter(item => item.id !== id);
    if (next.length === sessions.length) return false;
    write({ schemaVersion:1, sessions:next });
    return true;
  }

  function clear() {
    write({ schemaVersion:1, sessions:[] });
  }

  return { create, find, list, revoke, clear, file };
}

function webSecurityStatus(config = loadConfig()) {
  const auth = configuredAuth(config);
  return { enabled: Boolean(auth), tokenVersion: Number(auth?.tokenVersion || 0) };
}

function rotateWebApiToken() {
  const config = loadConfig();
  const token = generateToken();
  const previous = configuredAuth(config);
  config.web = { ...(config.web || {}), auth: { tokenVerifier: hashToken(token), tokenVersion: Number(previous?.tokenVersion || 0) + 1 } };
  saveConfig(config);
  createWebSessionStore().clear();
  return { ...webSecurityStatus(config), token };
}

function listWebDevices() { return createWebSessionStore().list(); }
function revokeWebDevice(id) { return createWebSessionStore().revoke(String(id || "")); }
function clearWebDevices() { return createWebSessionStore().clear(); }

module.exports = { DEVICE_TTL_MS, webSecurityStatus, rotateWebApiToken, createWebSessionStore, listWebDevices, revokeWebDevice, clearWebDevices };
