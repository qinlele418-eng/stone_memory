"use strict";

const path = require("path");

function systemdUserPath(home) {
  return [
    path.join(home, ".local", "bin"),
    "/usr/local/sbin",
    "/usr/local/bin",
    "/usr/sbin",
    "/usr/bin",
    "/sbin",
    "/bin",
  ].join(":");
}

function watcherServiceContent({ nodePath, watcherScript, home }) {
  const lines = [
    "[Unit]",
    "Description=STMEM Memory Watcher",
    "After=default.target",
    "StartLimitIntervalSec=300",
    "StartLimitBurst=5",
    "",
    "[Service]",
    "Type=simple",
    `Environment="PATH=${systemdUserPath(home)}"`,
    `ExecStart=${nodePath} ${watcherScript}`,
    "KillMode=control-group",
    "TimeoutStopSec=20",
  ];
  lines.push(
    "Restart=on-failure",
    "RestartSec=30",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  );
  return lines.join("\n");
}

module.exports = { systemdUserPath, watcherServiceContent };
