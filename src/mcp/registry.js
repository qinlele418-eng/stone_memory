class Registry {
  constructor() { this.entries = new Map(); }
  registerCore(provider) {
    this.core = provider;
    for (const tool of provider.tools) {
      if (this.entries.has(tool.name)) throw new Error("MCP_NAME_CONFLICT");
      this.entries.set(tool.name, { tool, call: args => provider.call(tool.name, args) });
    }
  }
  list() { return [...this.entries.values()].map(entry => entry.tool); }
  call(name, args) {
    const entry = this.entries.get(name);
    return entry ? entry.call(args) : this.core.call(name, args);
  }
}
module.exports = { Registry };
