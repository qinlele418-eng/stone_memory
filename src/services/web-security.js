"use strict";

const { loadConfig } = require("../config");
const { saveConfig } = require("./thread-setup");
const { generateToken, hashToken, configuredAuth } = require("../security/web-auth");

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
  return { ...webSecurityStatus(config), token };
}

module.exports = { webSecurityStatus, rotateWebApiToken };
