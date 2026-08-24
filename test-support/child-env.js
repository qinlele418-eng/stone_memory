const path = require("node:path");

function childEnvWithHome(home, overrides = {}) {
  const env = { ...process.env, ...overrides, HOME: home, USERPROFILE: home };
  if (process.platform !== "win32") return env;

  const { root } = path.win32.parse(home);
  if (/^[A-Za-z]:[\\/]$/.test(root)) {
    env.HOMEDRIVE = root.slice(0, 2);
    env.HOMEPATH = home.slice(2) || "\\";
  } else {
    delete env.HOMEDRIVE;
    delete env.HOMEPATH;
  }
  return env;
}

module.exports = { childEnvWithHome };
