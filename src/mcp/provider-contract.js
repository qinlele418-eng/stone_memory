const fs = require("node:fs");
const path = require("node:path");
const { assertModuleId } = require("../services/developer-module-contract");
const { toolIdentity } = require("./legacy-tool-names");
function fail(code) { throw new Error(code); }
function equalJson(left, right) {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(key => Object.hasOwn(right, key) && equalJson(left[key], right[key]));
}
function jsonValue(value, seen = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (!value || typeof value !== "object" || seen.has(value)) fail("MCP_NON_JSON");
  if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail("MCP_NON_JSON");
  seen.add(value);
  for (const item of Object.values(value)) jsonValue(item, seen);
  seen.delete(value);
}
function resolveProvider(moduleDir, relative) {
  if (typeof relative !== "string" || !relative || path.isAbsolute(relative) || path.win32.isAbsolute(relative) || relative.split(/[\\/]/).includes("..")) fail("MCP_ENTRY_PATH");
  const root = fs.realpathSync(moduleDir);
  const target = path.resolve(root, relative);
  const rel = path.relative(root, target);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) fail("MCP_ENTRY_PATH");
  let current = root;
  for (const segment of rel.split(path.sep)) {
    current = path.join(current, segment);
    if (fs.lstatSync(current).isSymbolicLink()) fail("MCP_ENTRY_SYMLINK");
  }
  if (!fs.statSync(target).isFile()) fail("MCP_ENTRY_FILE");
  return target;
}
// Deliberately bounded JSON Schema dialect: reject unsupported assertions instead
// of advertising a schema that the host cannot enforce.
const schemaKeys = new Set(["type", "properties", "required", "additionalProperties", "items", "enum", "const", "minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems", "description", "title", "default"]);
function validateSchema(schema) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) fail("MCP_SCHEMA");
  for (const key of Object.keys(schema)) if (!schemaKeys.has(key)) fail("MCP_SCHEMA_UNSUPPORTED");
  if (!["object", "array", "string", "integer", "number", "boolean", "null"].includes(schema.type)) fail("MCP_SCHEMA_TYPE");
  if (schema.type === "object") {
    if (schema.additionalProperties !== false || !schema.properties || typeof schema.properties !== "object" || Array.isArray(schema.properties)) fail("MCP_SCHEMA_PROPERTIES");
    if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some(key => typeof key !== "string" || !Object.hasOwn(schema.properties, key)))) fail("MCP_SCHEMA_REQUIRED");
    Object.values(schema.properties).forEach(validateSchema);
  }
  if (schema.type === "array") validateSchema(schema.items);
  for (const [keys, types] of [
    [["properties", "required", "additionalProperties"], ["object"]],
    [["items", "minItems", "maxItems"], ["array"]],
    [["minLength", "maxLength"], ["string"]],
    [["minimum", "maximum"], ["integer", "number"]],
  ]) if (!types.includes(schema.type) && keys.some(key => Object.hasOwn(schema, key))) fail("MCP_SCHEMA_KEYWORD_TYPE");
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || !schema.enum.length)) fail("MCP_SCHEMA_ENUM");
  for (const key of ["minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems"]) {
    if (schema[key] !== undefined && (!Number.isFinite(schema[key]) || (key !== "minimum" && key !== "maximum" && (!Number.isInteger(schema[key]) || schema[key] < 0)))) fail("MCP_SCHEMA_BOUND");
  }
}
function validateInput(schema, value) {
  const type = schema.type;
  if (type === "object" ? !value || typeof value !== "object" || Array.isArray(value)
    : type === "array" ? !Array.isArray(value)
    : type === "null" ? value !== null
    : type === "integer" ? !Number.isInteger(value)
    : typeof value !== type) fail("MCP_INPUT_SCHEMA");
  if (["integer", "number"].includes(type) && !Number.isFinite(value)) fail("MCP_INPUT_SCHEMA");
  if (type === "object") {
    for (const key of schema.required || []) if (!Object.hasOwn(value, key)) fail("MCP_INPUT_REQUIRED");
    for (const [key, item] of Object.entries(value)) {
      if (!Object.hasOwn(schema.properties, key)) fail("MCP_INPUT_PROPERTY");
      validateInput(schema.properties[key], item);
    }
  }
  if (type === "array") value.forEach(item => validateInput(schema.items, item));
  if (schema.enum && !schema.enum.some(item => equalJson(item, value))) fail("MCP_INPUT_ENUM");
  if (Object.hasOwn(schema, "const") && !equalJson(schema.const, value)) fail("MCP_INPUT_CONST");
  for (const [key, actual, lower] of [["minimum", value, true], ["maximum", value, false], ["minLength", typeof value === "string" ? [...value].length : undefined, true], ["maxLength", typeof value === "string" ? [...value].length : undefined, false], ["minItems", value?.length, true], ["maxItems", value?.length, false]]) {
    if (schema[key] !== undefined && (lower ? actual < schema[key] : actual > schema[key])) fail("MCP_INPUT_BOUND");
  }
}
function validateTools(manifest, tools) {
  assertModuleId(manifest.id);
  jsonValue(tools);
  if (!Array.isArray(tools)) fail("MCP_TOOLS_ARRAY");
  const names = new Set();
  for (const tool of tools) {
    if (!tool || typeof tool.name !== "string" || !/^[a-z0-9_]+$/.test(tool.name) || typeof tool.description !== "string") fail("MCP_TOOL_NAME");
    const { name, memoryArgument, legacy, readOnly } = toolIdentity(manifest.id, tool.name);
    if (legacy && (manifest.scope !== "memory" || tool.annotations?.readOnlyHint !== readOnly)) fail("MCP_LEGACY_CONTRACT");
    if (name.length > 128 || names.has(name)) fail("MCP_NAME_CONFLICT");
    names.add(name);
    validateSchema(tool.inputSchema);
    if (tool.inputSchema.type !== "object") fail("MCP_SCHEMA_ROOT");
    for (const key of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"]) if (typeof tool.annotations?.[key] !== "boolean") fail("MCP_ANNOTATIONS");
    if (!tool.annotations.readOnlyHint && !manifest.permissions.includes("mcp:write")) fail("MCP_WRITE_PERMISSION");
    if (manifest.scope === "memory" && Object.hasOwn(tool.inputSchema.properties, "memoryId")) fail("MCP_RESERVED_MEMORY_ID");
    if (manifest.scope === "memory" && Object.hasOwn(tool.inputSchema.properties, memoryArgument)) fail("MCP_RESERVED_MEMORY_ID");
    if (manifest.scope === "memory" && ["const", "enum"].some(key => Object.hasOwn(tool.inputSchema, key))) fail("MCP_SCHEMA_HOST_FIELD_CONFLICT");
  }
  return structuredClone(tools);
}
function validateResult(result) {
  jsonValue(result);
  if (!result || !Array.isArray(result.content) || (result.isError !== undefined && typeof result.isError !== "boolean")) fail("MCP_RESULT");
  for (const block of result.content) {
    if (block?.type === "text" && typeof block.text === "string") continue;
    if (["image", "audio"].includes(block?.type) && typeof block.data === "string" && typeof block.mimeType === "string") continue;
    if (block?.type === "resource" && typeof block.resource?.uri === "string" && (typeof block.resource.text === "string" || typeof block.resource.blob === "string")) continue;
    fail("MCP_RESULT_CONTENT");
  }
  return result;
}
module.exports = { resolveProvider, validateTools, validateInput, validateResult, jsonValue };
