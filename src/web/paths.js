const path = require("path");

const PUBLIC_DIR = path.join(__dirname, "public");

const PROJECT_ROOT = path.join(__dirname, "..", "..");

const STMEM_BIN = path.join(PROJECT_ROOT, "bin", "stmem");

const MAX_UPLOAD = 512 * 1024 * 1024;

const MAX_NOTEBOOK_ASSET_UPLOAD = 20 * 1024 * 1024;

module.exports = { PUBLIC_DIR, PROJECT_ROOT, STMEM_BIN, MAX_UPLOAD, MAX_NOTEBOOK_ASSET_UPLOAD };
