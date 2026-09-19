const path = require("path");
const fs = require("fs");
const zlib = require("zlib");
const { PUBLIC_DIR } = require("./paths");
const { loadModules, resolveInside } = require("../services/developer-module-contract");

function listDeveloperModules(publicDir = PUBLIC_DIR) {
  const root = path.join(publicDir, "developer-modules");
  const legacyModules = !fs.existsSync(root) ? [] : fs.readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .flatMap(entry => {
      try {
        const manifest = JSON.parse(fs.readFileSync(path.join(root, entry.name, "module.json"), "utf8"));
        const id = String(manifest.id || "").trim();
        const expectedEntry = `/developer-modules/${id}/`;
        if (!/^[a-z0-9][a-z0-9-]*$/u.test(id) || id !== entry.name || manifest.entry !== expectedEntry) return [];
        return [{
          id,
          title: String(manifest.title || id),
          summary: String(manifest.summary || ""),
          contributor: String(manifest.contributor || ""),
          status: String(manifest.status || "社区实验"),
          eyebrow: String(manifest.eyebrow || "COMMUNITY MODULE"),
          actionLabel: String(manifest.actionLabel || "打开 →"),
          metaLabel: String(manifest.metaLabel || "Module"),
          features: Array.isArray(manifest.features) ? manifest.features.map(String).slice(0, 6) : [],
          order: Number.isFinite(Number(manifest.order)) ? Number(manifest.order) : 100,
          entry: expectedEntry,
        }];
      } catch {
        return [];
      }
    })
    .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
  const canonicalModules = loadModules()
    .filter(item => !item.errors.length && item.manifest.entry?.frontend && !item.manifest.legacy?.frontend)
    .map(item => ({
      id: item.id,
      title: String(item.manifest.title || item.id),
      summary: String(item.manifest.summary || ""),
      contributor: String(item.manifest.contributor || "Stone Memory"),
      status: String(item.manifest.status || "官方实验"),
      eyebrow: String(item.manifest.eyebrow || "STONE MEMORY LAB"),
      actionLabel: String(item.manifest.actionLabel || "进入实验室 →"),
      metaLabel: String(item.manifest.metaLabel || `Module · v${item.manifest.version}`),
      features: Array.isArray(item.manifest.features) ? item.manifest.features.map(String).slice(0, 6) : [],
      order: Number.isFinite(Number(item.manifest.order)) ? Number(item.manifest.order) : 100,
      entry: `/developer-modules/${item.id}/`,
    }));
  const byId = new Map(legacyModules.map(item => [item.id, item]));
  for (const item of canonicalModules) byId.set(item.id, item);
  return [...byId.values()].sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
}

function serveCanonicalDeveloperModule(req, res, pathname) {
  const match = pathname.match(/^\/developer-modules\/([a-z0-9][a-z0-9-]*)(?:\/(.*))?$/u);
  if (!match) return false;
  const loaded = loadModules().find(item => item.id === match[1] && !item.errors.length);
  if (!loaded?.manifest.entry?.frontend || loaded.manifest.legacy?.frontend) return false;
  const frontendEntry = resolveInside(loaded.moduleDir, loaded.manifest.entry.frontend, "frontend entry");
  const frontendRoot = path.dirname(frontendEntry);
  const requested = match[2] || path.basename(frontendEntry);
  const file = path.resolve(frontendRoot, requested);
  const relative = path.relative(frontendRoot, file);
  if (relative.startsWith("..") || path.isAbsolute(relative) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
  const types = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml", ".png": "image/png" };
  const stat = fs.statSync(file);
  res.writeHead(200, {
    "content-type": types[path.extname(file)] || "application/octet-stream",
    "content-length": stat.size,
    "cache-control": "no-cache",
  });
  fs.createReadStream(file).pipe(res);
  return true;
}

function serveLegacyDreamLab(res, url) {
  const { pathname } = url;
  if (!/^\/dream-lab(?:\/|$)/u.test(pathname)) return false;
  const suffix = pathname.slice("/dream-lab".length).replace(/^\//u, "");
  const location = `/developer-modules/dream-lab/${suffix}`.replace(/\/$/u, "/") + url.search;
  res.writeHead(302, { location });
  res.end();
  return true;
}

function serveStatic(req, res, pathname) {
  const requested = pathname === "/" ? "index.html" : pathname.endsWith("/") ? `${pathname.slice(1)}index.html` : pathname.slice(1);
  const file = path.resolve(PUBLIC_DIR, requested);
  if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file)) return false;
  const stat = fs.statSync(file);
  if (stat.isDirectory()) return false;
  const types = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml", ".png": "image/png" };
  const extension = path.extname(file);
  const gzip = /\bgzip\b/.test(req.headers["accept-encoding"] || "") && new Set([".html", ".css", ".js", ".json", ".svg"]).has(extension);
  const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}${gzip ? "-gz" : ""}"`;
  const headers = {
    "content-type": types[extension] || "application/octet-stream",
    "cache-control": "no-cache",
    etag,
    "last-modified": stat.mtime.toUTCString(),
    vary: "Accept-Encoding",
  };
  if (req.headers["if-none-match"] === etag) {
    res.writeHead(304, headers);
    res.end();
    return true;
  }
  if (gzip) {
    headers["content-encoding"] = "gzip";
    res.writeHead(200, headers);
    fs.createReadStream(file).pipe(zlib.createGzip({ level: zlib.constants.Z_BEST_SPEED })).pipe(res);
  } else {
    headers["content-length"] = stat.size;
    res.writeHead(200, headers);
    fs.createReadStream(file).pipe(res);
  }
  return true;
}

function serveNotebookAsset(req, res, asset) {
  if (!asset) return false;
  const etag = `W/"${asset.size.toString(16)}-${Math.floor(asset.modifiedAt.getTime()).toString(16)}"`;
  const headers = {
    "content-type": asset.contentType,
    "content-length": asset.size,
    "cache-control": "private, max-age=300",
    "x-content-type-options": "nosniff",
    etag,
  };
  if (req.headers["if-none-match"] === etag) {
    delete headers["content-length"];
    res.writeHead(304, headers);
    res.end();
    return true;
  }
  res.writeHead(200, headers);
  fs.createReadStream(asset.absolutePath).pipe(res);
  return true;
}

module.exports = { listDeveloperModules, serveCanonicalDeveloperModule, serveLegacyDreamLab, serveStatic, serveNotebookAsset };
