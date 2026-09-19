#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { listMemoryIds } = require("../src/config");
const { listRules, writeRule, deleteRule, setRuleInjected } = require("../src/services/rule-store");
const args = process.argv.slice(3), value = key => { const i=args.indexOf(key); return i>=0 ? args[i+1] : null; };
const legacyId = value("--thread"), memoryId = value("--memory");
if (legacyId && memoryId && legacyId !== memoryId) throw new Error("--memory 与兼容参数 --thread 不能指向不同记忆体");
const action = args[0] || "list", configured = listMemoryIds();
if (!memoryId && !legacyId && action !== "list") throw new Error("规则写操作必须显式指定 --memory <id>");
if (!memoryId && !legacyId && configured.length > 1) throw new Error("存在多个记忆体，请显式指定 --memory <id>");
const threadId = memoryId || legacyId || (configured.length === 1 ? configured[0] : null);
if (!threadId) throw new Error("请指定 --memory");
if (action === "list") console.log(JSON.stringify(listRules(threadId)));
else if (action === "import" || action === "update") { const source=value("--source"); if(!source) throw new Error("请指定 --source"); const name=value("--name") || path.basename(source); writeRule(threadId,name,fs.readFileSync(source,"utf8")); console.log(JSON.stringify({success:true,name})); }
else if (action === "delete") { deleteRule(threadId,value("--name")); console.log(JSON.stringify({success:true})); }
else if (action === "enable" || action === "disable") { setRuleInjected(threadId,value("--name"),action === "enable"); console.log(JSON.stringify({success:true,injected:action === "enable"})); }
else throw new Error("用法: stmem rules list|import|update|delete|enable|disable --memory <id>");
