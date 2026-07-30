#!/usr/bin/env node
"use strict";

const major = Number(String(process.versions.node || "").split(".")[0]);

if (major !== 22) {
  console.error([
    "",
    `Stone Memory 当前仅支持 Node.js 22.x LTS（检测到 ${process.version}）。`,
    "请切换到 Node 22 后重新运行 npm install / npm ci。",
    "尤其不要在 Windows 上使用 Node 24：better-sqlite3 可能转为本地 C++ 编译并安装失败。",
    "",
  ].join("\n"));
  process.exit(1);
}
