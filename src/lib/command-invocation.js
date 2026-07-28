const fs = require("fs");
const path = require("path");

function parseCommandLine(input) {
  const value = String(input || "").trim();
  if (!value) throw new Error("runtime command is empty");
  const parts = [];
  let current = "";
  let quote = null;
  for (let index = 0; index < value.length; index++) {
    const char = value[index];
    if (char === "\\") {
      const next = value[index + 1];
      const escapable = next && (next === "\\" || next === quote || (!quote && (/\s/.test(next) || next === "'" || next === "\"")));
      if (quote !== "'" && escapable) {
        current += next;
        index++;
      } else {
        current += char;
      }
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        parts.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (quote) throw new Error("runtime command contains an unclosed quote");
  if (current) parts.push(current);
  if (!parts.length) throw new Error("runtime command is empty");
  return parts;
}

function commandInvocation(command, { remove = [] } = {}) {
  const [file, ...rawArgs] = parseCommandLine(command);
  const removals = new Set(remove);
  return { file, args: rawArgs.filter(arg => !removals.has(arg)) };
}

function appendOption(args, flag, value) {
  if (!flag || value === undefined || value === null || value === "") return;
  args.push(...parseCommandLine(flag), String(value));
}

function windowsEnvValue(env, name) {
  const key = Object.keys(env || {}).find(candidate => candidate.toLowerCase() === name.toLowerCase());
  return key ? String(env[key] || "") : "";
}

function windowsPathEntries(env) {
  return windowsEnvValue(env, "PATH")
    .split(";")
    .map(entry => entry.trim().replace(/^"(.*)"$/, "$1"))
    .filter(Boolean);
}

function npmNodeLauncher(shimPath, { existsSync, readFileSync }) {
  let content;
  try {
    content = readFileSync(shimPath, "utf8");
  } catch {
    return null;
  }
  const match = String(content).match(/%dp0%[\\/](node_modules[\\/][^"\r\n]+?\.js)"?\s+%\*/i);
  if (!match) return null;

  const shimDir = path.win32.dirname(shimPath);
  const nodeModulesDir = path.win32.resolve(shimDir, "node_modules");
  const launcher = path.win32.resolve(shimDir, match[1]);
  const allowedPrefix = `${nodeModulesDir}${path.win32.sep}`.toLowerCase();
  if (!launcher.toLowerCase().startsWith(allowedPrefix) || !existsSync(launcher)) return null;
  return launcher;
}

/**
 * Node's execFile/execFileSync intentionally does not invoke a shell. On Windows,
 * npm exposes package bins through .cmd shims, while an extensionless companion
 * file may be found first and fail CreateProcess with EPERM. Keep argv execution
 * shell-free by resolving a real executable first, or by safely unwrapping the
 * standard npm Node shim to its sibling node_modules launcher.
 */
function resolveExecutableInvocation(invocation, options = {}) {
  const platform = options.platform || process.platform;
  if (platform !== "win32") return invocation;

  const file = String(invocation?.file || "");
  if (!file || file.includes("\\") || file.includes("/") || path.win32.extname(file)) return invocation;

  const env = options.env || process.env;
  const existsSync = options.existsSync || fs.existsSync;
  const readFileSync = options.readFileSync || fs.readFileSync;
  const nodePath = options.nodePath || process.execPath;
  const directories = windowsPathEntries(env);

  // Respect PATH precedence. Within each entry, prefer a native executable;
  // otherwise unwrap only the standard npm Node shim.
  for (const directory of directories) {
    for (const extension of [".EXE", ".COM"]) {
      const candidate = path.win32.join(directory, `${file}${extension}`);
      if (existsSync(candidate)) return { ...invocation, file: candidate };
    }

    const shimPath = path.win32.join(directory, `${file}.CMD`);
    if (!existsSync(shimPath)) continue;
    const launcher = npmNodeLauncher(shimPath, { existsSync, readFileSync });
    if (!launcher) continue;
    return {
      ...invocation,
      file: nodePath,
      args: [launcher, ...(invocation.args || [])],
    };
  }

  return invocation;
}

module.exports = {
  parseCommandLine,
  commandInvocation,
  appendOption,
  resolveExecutableInvocation,
};
