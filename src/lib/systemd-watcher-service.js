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

function watcherServiceContent({ nodePath, watcherScript, home, pidFile = null }) {
  const lines = [
    "[Unit]",
    "Description=STMEM Memory Watcher",
    "After=default.target",
    "",
    "[Service]",
    "Type=simple",
    `Environment="PATH=${systemdUserPath(home)}"`,
    `ExecStart=${nodePath} ${watcherScript}`,
  ];
  if (pidFile) lines.push(`ExecStopPost=/bin/rm -f ${pidFile}`);
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
