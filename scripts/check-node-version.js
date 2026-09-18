#!/usr/bin/env node
"use strict";

const major = Number(String(process.versions.node || "").split(".")[0]);

if (!Number.isInteger(major) || major < 22) {
  console.error([
    "",
    `Stone Memory 需要 Node.js 22 或更高版本（检测到 ${process.version}）。`,
    "请升级 Node.js 后重新运行 npm install / npm ci。",
    "",
  ].join("\n"));
  process.exit(1);
}
