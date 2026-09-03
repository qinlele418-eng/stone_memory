const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { getThreadDir, listThreadIds } = require("../src/config");
const { MemoryStore } = require("../src/storage/memory-store");
const { parseThreadMessages, beijingDateKey, isSystemTemplate, internalRecordReason } = require("../src/services/thread-ingest");
const { listDateFiles, resolveDateFile } = require("../src/lib/archive-paths");
const { normalizePolicy, loadToolEventPolicy, saveToolEventPolicy, extractToolEvents, extractThinkingEvents } = require("../src/services/tool-event-policy");
const { normalizeThreadMessage } = require("../src/lib/thread-message");
const { isInjectedMemoryBlock } = require("../src/lib/system-injection");
const { messageIdentity } = require("../src/lib/message-identity");
const { createConversationAnomalyDetector, applyConversationCleaning } = require("../src/services/conversation-cleaning");

function valueAfter(args, flag) { const i=args.indexOf(flag); return i>=0?args[i+1]:null; }
function fullFiles(memoryDir) {
  const dir=path.join(memoryDir,"archive","full");
  return listDateFiles(dir).map(item=>item.file);
}
function mergeStats(target, source) {
  for(const [name,count] of Object.entries(source||{})) target[name]=(target[name]||0)+count;
}
function policyConversationEvents(records,policy,counts={}){
  const rows=[];
  for(const raw of records||[]){const row=normalizeThreadMessage(raw);if(!row)continue;
    if(row.text.includes("<!-- stmem-rule:")){counts.ruleInjections=(counts.ruleInjections||0)+1;if(policy.categories.ruleInjections)rows.push({...row,source:"conversation_policy:rules"});}
    else if(isSystemTemplate(row.text)){counts.systemTemplates=(counts.systemTemplates||0)+1;if(policy.categories.systemTemplates)rows.push({...row,source:"conversation_policy:system_template"});}
  }
  counts.thinking=(counts.thinking||0)+extractThinkingEvents(records,{categories:{thinking:true}}).length;
  return rows;
}
function scanPolicyPreview(memoryDir,policy){
  const stats={},categories={},preview=[];let totalSelected=0;
  for(const file of fullFiles(memoryDir)) {
    const records=parseThreadMessages(fs.readFileSync(file,"utf8")),extracted=extractToolEvents(records,policy),categoryRows=policyConversationEvents(records,policy,categories),thinking=extractThinkingEvents(records,policy);
    mergeStats(stats,extracted.stats);totalSelected+=extracted.rows.length+categoryRows.length+thinking.length;
    preview.push(...[...categoryRows,...thinking,...extracted.rows].slice(0,Math.max(0,50-preview.length)));
  }
  return {categories,observed:Object.entries(stats).map(([name,count])=>({name,count,rule:policy.tools[name]||{mode:"exclude",fields:[],label:""}})),preview,totalSelected};
}
function scanDetection(memoryDir,policy,store){
  const detector=createConversationAnomalyDetector(),stats={},categories={},preview=[];let totalSelected=0;
  const alreadyFiltered={
    memoryBlocks:{count:0,samples:[],locked:true},
    internalRecords:{count:0,samples:[],locked:true},
    systemTemplates:{count:0,samples:[],allowed:!!policy.categories.systemTemplates},
    thinking:{count:0,samples:[],allowed:!!policy.categories.thinking},
    ruleInjections:{count:0,samples:[],allowed:!!policy.categories.ruleInjections},
  };
  const sample=(bucket,value)=>{if(bucket.samples.length<3&&value)bucket.samples.push(String(value).slice(0,500));};
  for(const file of fullFiles(memoryDir)) {
    const records=parseThreadMessages(fs.readFileSync(file,"utf8"));
    for(const raw of records){
      const reason=internalRecordReason(raw),row=normalizeThreadMessage(raw);
      if(reason){alreadyFiltered.internalRecords.count++;sample(alreadyFiltered.internalRecords,reason);continue;}
      if(row?.text&&isInjectedMemoryBlock(row.text)){alreadyFiltered.memoryBlocks.count++;sample(alreadyFiltered.memoryBlocks,row.text);continue;}
      if(row?.text&&row.text.includes("<!-- stmem-rule:")){alreadyFiltered.ruleInjections.count++;sample(alreadyFiltered.ruleInjections,row.text);continue;}
      if(row?.text&&isSystemTemplate(row.text)){alreadyFiltered.systemTemplates.count++;sample(alreadyFiltered.systemTemplates,row.text);continue;}
    }
    const extracted=extractToolEvents(records,policy),categoryRows=policyConversationEvents(records,policy,categories),thinking=extractThinkingEvents(records,policy);
    const allThinking=extractThinkingEvents(records,{categories:{thinking:true}});
    alreadyFiltered.thinking.count+=allThinking.length;for(const row of allThinking)sample(alreadyFiltered.thinking,row.text);
    mergeStats(stats,extracted.stats);totalSelected+=extracted.rows.length+categoryRows.length+thinking.length;
    preview.push(...[...categoryRows,...thinking,...extracted.rows].slice(0,Math.max(0,50-preview.length)));
  }
  const archiveRows=store.db.prepare(`SELECT timestamp,role AS type,text FROM messages
    WHERE thread_id=? AND COALESCE(source,'') NOT LIKE 'tool_event:%' AND COALESCE(source,'') NOT LIKE 'conversation_policy:%'
    ORDER BY timestamp,message_seq`).all(store.threadId);
  for(const row of archiveRows)detector.add(row);
  const observed=Object.entries(stats).map(([name,count])=>({name,count,rule:policy.tools[name]||{mode:"exclude",fields:[],label:""}}));
  alreadyFiltered.tools=observed.map(item=>({...item,allowed:item.rule.mode!=="exclude"}));
  return {anomalies:detector.finish(),alreadyFiltered,categories,observed,preview,totalSelected};
}
function buildCleaningPlan(store,policy,memoryDir){
  const rows=store.db.prepare(`SELECT message_seq AS messageSeq,timestamp,role,text
    FROM messages WHERE thread_id=? AND COALESCE(source,'') NOT LIKE 'tool_event:%' AND COALESCE(source,'') NOT LIKE 'conversation_policy:%'
    ORDER BY timestamp,message_seq`).all(store.threadId);
  const seen=new Set(),samples=[];let removed=0,cleaned=0;
  for(const row of rows){
    const duplicateRule=policy.cleaning.exactDuplicates.find(item=>item.enabled&&(!item.role||item.role===row.role)&&item.text===String(row.text).trim());
    const duplicateSeen=!!duplicateRule&&seen.has(duplicateRule.id);if(duplicateRule)seen.add(duplicateRule.id);
    const result=applyConversationCleaning(row.text,policy.cleaning,{duplicateSeen,role:row.role});
    if(!result.keep)removed++;else if(result.text!==row.text)cleaned++;
    if(result.removed.length&&samples.length<20)samples.push({timestamp:row.timestamp,action:result.keep?"strip":"remove",categories:[...new Set(result.removed.map(item=>item.category))],before:row.text.slice(0,500),after:result.text.slice(0,500)});
  }
  const state=store.db.prepare("SELECT COUNT(*) count,COALESCE(MAX(message_seq),0) maxSeq FROM messages WHERE thread_id=?").get(store.threadId);
  const token=crypto.createHash("sha256").update(JSON.stringify({policy,state})).digest("hex");
  const supplementalCurrent=store.db.prepare("SELECT COUNT(*) count FROM messages WHERE thread_id=? AND (source LIKE 'tool_event:%' OR source LIKE 'conversation_policy:%')").get(store.threadId).count;
  const supplementalSelected=scanPolicyPreview(memoryDir,policy).totalSelected;
  return {token,scanned:rows.length,removed,cleaned,samples,supplementalCurrent,supplementalSelected};
}
function cleaningPolicyWithoutRule(policy,category,ruleId){
  const next=normalizePolicy(policy);
  const key={exact_duplicate:"exactDuplicates",injection_fragment:"injectionFragments",recall_block:"recallHeaders"}[category];
  if(key)next.cleaning[key]=next.cleaning[key].filter(item=>item.id!==ruleId);
  else if(category==="rule_header")next.cleaning.customRuleHeaders=next.cleaning.customRuleHeaders.filter(item=>item!==ruleId);
  else throw new Error(`不支持取消的过滤类型: ${category}`);
  return next;
}
function rawConversationCandidates(memoryDir,logs){
  const wanted=new Map();
  for(const log of logs){if(!wanted.has(log.timestamp))wanted.set(log.timestamp,[]);wanted.get(log.timestamp).push(log);}
  const found=new Map();
  const fullDir=path.join(memoryDir,"archive","full");
  const files=[...new Set(logs.map(log=>resolveDateFile(fullDir,beijingDateKey(log.timestamp))).filter(file=>fs.existsSync(file)))];
  for(const file of files)for(const raw of parseThreadMessages(fs.readFileSync(file,"utf8"))){
    if(internalRecordReason(raw))continue;
    const row=normalizeThreadMessage(raw);if(!row?.timestamp||!row?.text||!wanted.has(row.timestamp)||isInjectedMemoryBlock(row.text))continue;
    const matches=wanted.get(row.timestamp).some(log=>row.text.includes(log.originalText));if(!matches)continue;
    found.set(`${row.timestamp}\u0000${row.type}\u0000${row.text}`,row);
  }
  return [...found.values()];
}
function buildUnfilterPlan(store,policy,memoryDir,category,ruleId){
  const logs=store.db.prepare(`SELECT id,timestamp,category,rule_id AS ruleId,original_text AS originalText
    FROM conversation_filter_log WHERE thread_id=? AND category=? AND COALESCE(rule_id,'')=COALESCE(?, '') ORDER BY id`).all(store.threadId,category,ruleId||null);
  if(!logs.length)throw new Error("过滤档案中没有找到这条规则的命中记录");
  const candidates=rawConversationCandidates(memoryDir,logs),next=cleaningPolicyWithoutRule(policy,category,ruleId);
  const token=crypto.createHash("sha256").update(JSON.stringify({category,ruleId,ids:logs.map(row=>row.id),policy})).digest("hex");
  return {token,category,ruleId,logged:logs.length,recoverable:candidates.length,samples:candidates.slice(0,5).map(row=>({timestamp:row.timestamp,role:row.type,text:row.text.slice(0,500)})),next,candidates,logs};
}
function applyUnfilter(store,policy,memoryDir,category,ruleId,confirmedPlan){
  const plan=buildUnfilterPlan(store,policy,memoryDir,category,ruleId);
  if(!confirmedPlan||confirmedPlan!==plan.token)throw new Error("恢复范围尚未预览或过滤档案已变化，请重新预览后确认");
  if(!plan.recoverable)throw new Error("raw full 中没有找到可恢复的对应原文，已拒绝修改");
  const findCurrent=store.db.prepare("SELECT message_seq AS messageSeq FROM messages WHERE thread_id=? AND timestamp=? AND role=? ORDER BY message_seq LIMIT 1");
  const update=store.db.prepare("UPDATE messages SET text=?,message_id=? WHERE message_seq=?");
  const remove=store.db.prepare("DELETE FROM messages WHERE message_seq=?");
  const deleteLogs=store.db.prepare("DELETE FROM conversation_filter_log WHERE thread_id=? AND category=? AND COALESCE(rule_id,'')=COALESCE(?, '')");
  let restored=0;
  const tx=store.db.transaction(()=>{
    for(const row of plan.candidates){
      const duplicateRule=plan.next.cleaning.exactDuplicates.find(item=>item.enabled&&(!item.role||item.role===row.type)&&item.text===String(row.text).trim());
      const duplicateSeen=!!duplicateRule&&!!store.db.prepare("SELECT 1 FROM messages WHERE thread_id=? AND role=? AND text=? AND timestamp<? LIMIT 1").get(store.threadId,row.type,duplicateRule.text,row.timestamp);
      const cleaned=applyConversationCleaning(row.text,plan.next.cleaning,{duplicateSeen,role:row.type});
      const current=findCurrent.get(store.threadId,row.timestamp,row.type);
      if(!cleaned.keep){if(current)remove.run(current.messageSeq);continue;}
      if(current){
        try{restored+=update.run(cleaned.text,messageIdentity(row.timestamp,row.type,cleaned.text),current.messageSeq).changes;}
        catch(error){if(String(error.code||"").includes("CONSTRAINT"))remove.run(current.messageSeq);else throw error;}
      }else restored+=store.insertMessagesDetailed([{timestamp:row.timestamp,sourceDate:beijingDateKey(row.timestamp),role:row.type,text:cleaned.text,source:"archive"}]).inserted;
    }
    deleteLogs.run(store.threadId,category,ruleId||null);
  });
  const previous=policy;
  saveToolEventPolicy(memoryDir,plan.next);
  try{tx();}catch(error){saveToolEventPolicy(memoryDir,previous);throw error;}
  return {restored,removedRule:true,policy:plan.next};
}
function normalizeUnfilterRules(payload){
  const input=Array.isArray(payload?.rules)&&payload.rules.length?payload.rules:[payload];
  const seen=new Set(),rules=[];
  for(const item of input){
    const category=String(item?.category||""),ruleId=String(item?.ruleId||"");
    if(!category||!ruleId)continue;
    const key=`${category}\u0000${ruleId}`;if(seen.has(key))continue;seen.add(key);rules.push({category,ruleId});
  }
  if(!rules.length)throw new Error("请至少选择一条需要取消的过滤规则");
  return rules;
}
function buildUnfilterBatchPlan(store,policy,memoryDir,rules){
  let next=policy;const logs=[];
  for(const rule of rules){
    const rows=store.db.prepare(`SELECT id,timestamp,category,rule_id AS ruleId,original_text AS originalText
      FROM conversation_filter_log WHERE thread_id=? AND category=? AND COALESCE(rule_id,'')=COALESCE(?, '') ORDER BY id`).all(store.threadId,rule.category,rule.ruleId);
    if(!rows.length)throw new Error(`过滤档案中没有找到规则: ${rule.ruleId}`);
    logs.push(...rows);next=cleaningPolicyWithoutRule(next,rule.category,rule.ruleId);
  }
  const candidates=rawConversationCandidates(memoryDir,logs);
  const token=crypto.createHash("sha256").update(JSON.stringify({rules,ids:logs.map(row=>row.id),policy})).digest("hex");
  return {token,rules,logged:logs.length,recoverable:candidates.length,samples:candidates.slice(0,5).map(row=>({timestamp:row.timestamp,role:row.type,text:row.text.slice(0,500)})),next,candidates,logs};
}
function applyUnfilterBatch(store,policy,memoryDir,rules,confirmedPlan){
  const plan=buildUnfilterBatchPlan(store,policy,memoryDir,rules);
  if(!confirmedPlan||confirmedPlan!==plan.token)throw new Error("恢复范围尚未预览或过滤档案已变化，请重新预览后确认");
  if(!plan.recoverable)throw new Error("raw full 中没有找到可恢复的对应原文，已拒绝修改");
  const findCurrent=store.db.prepare("SELECT message_seq AS messageSeq FROM messages WHERE thread_id=? AND timestamp=? AND role=? ORDER BY message_seq LIMIT 1");
  const update=store.db.prepare("UPDATE messages SET text=?,message_id=? WHERE message_seq=?");
  const remove=store.db.prepare("DELETE FROM messages WHERE message_seq=?");
  const deleteLogs=store.db.prepare("DELETE FROM conversation_filter_log WHERE thread_id=? AND category=? AND COALESCE(rule_id,'')=COALESCE(?, '')");
  let restored=0;
  const tx=store.db.transaction(()=>{
    for(const row of plan.candidates){
      const duplicateRule=plan.next.cleaning.exactDuplicates.find(item=>item.enabled&&(!item.role||item.role===row.type)&&item.text===String(row.text).trim());
      const duplicateSeen=!!duplicateRule&&!!store.db.prepare("SELECT 1 FROM messages WHERE thread_id=? AND role=? AND text=? AND timestamp<? LIMIT 1").get(store.threadId,row.type,duplicateRule.text,row.timestamp);
      const cleaned=applyConversationCleaning(row.text,plan.next.cleaning,{duplicateSeen,role:row.type});
      const current=findCurrent.get(store.threadId,row.timestamp,row.type);
      if(!cleaned.keep){if(current)remove.run(current.messageSeq);continue;}
      if(current){
        try{restored+=update.run(cleaned.text,messageIdentity(row.timestamp,row.type,cleaned.text),current.messageSeq).changes;}
        catch(error){if(String(error.code||"").includes("CONSTRAINT"))remove.run(current.messageSeq);else throw error;}
      }else restored+=store.insertMessagesDetailed([{timestamp:row.timestamp,sourceDate:beijingDateKey(row.timestamp),role:row.type,text:cleaned.text,source:"archive"}]).inserted;
    }
    for(const rule of rules)deleteLogs.run(store.threadId,rule.category,rule.ruleId);
  });
  saveToolEventPolicy(memoryDir,plan.next);
  try{tx();}catch(error){saveToolEventPolicy(memoryDir,policy);throw error;}
  return {restored,removedRules:rules.length,policy:plan.next};
}
function runToolPolicy(args=process.argv.slice(3)) {
  const action=args[0]||"status",threadId=valueAfter(args,"--thread")||listThreadIds()[0];
  if(!threadId) throw new Error("没有可用记忆体，请传 --thread");
  const memoryDir=path.join(getThreadDir(threadId),"memory"), current=loadToolEventPolicy(memoryDir);
  if(action==="status") {
    const store=new MemoryStore({memoryDir,threadId});
    try{return {threadId,policy:current,filtered:store.listConversationFilterLog({limit:50})};}
    finally{store.close();}
  }
  if(action==="detect") {
    const store=new MemoryStore({memoryDir,threadId});
    try{return {threadId,policy:current,...scanDetection(memoryDir,current,store)};}finally{store.close();}
  }
  if(action==="filtered") {
    const store=new MemoryStore({memoryDir,threadId});
    try{return {threadId,...store.listConversationFilterLog({limit:Number(valueAfter(args,"--limit"))||100,offset:Number(valueAfter(args,"--offset"))||0})};}
    finally{store.close();}
  }
  if(action==="unfilter-preview"||action==="unfilter") {
    const batch=valueAfter(args,"--batch-file");if(!batch)throw new Error(`${action} 需要 --batch-file`);
    const payload=JSON.parse(fs.readFileSync(batch,"utf8")),rules=normalizeUnfilterRules(payload);
    const store=new MemoryStore({memoryDir,threadId});
    try{
      if(action==="unfilter-preview"){
        const {candidates,logs,next,...plan}=buildUnfilterBatchPlan(store,current,memoryDir,rules);
        return {threadId,plan};
      }
      return {threadId,...applyUnfilterBatch(store,current,memoryDir,rules,String(payload.confirmedPlan||""))};
    }finally{store.close();}
  }
  if(action==="reset-cleaning") {
    const policy=saveToolEventPolicy(memoryDir,{...current,cleaning:{}});
    return {threadId,policy,reset:true};
  }
  if(action==="plan") {
    const batch=valueAfter(args,"--batch-file");if(!batch)throw new Error("plan 需要 --batch-file");
    const policy=normalizePolicy(JSON.parse(fs.readFileSync(batch,"utf8"))),store=new MemoryStore({memoryDir,threadId});
    try{return {threadId,policy,plan:buildCleaningPlan(store,policy,memoryDir)};}finally{store.close();}
  }
  if(action==="rollback-formatting") {
    const originals=new Map();
    for(const row of (()=>{const values=[];for(const file of fullFiles(memoryDir)){for(const raw of parseThreadMessages(fs.readFileSync(file,"utf8"))){const item=normalizeThreadMessage(raw);if(item?.text&&item?.timestamp)values.push(item);}}return values;})()){
      const key=`${row.timestamp}\u0000${row.type}\u0000${String(row.text).trim()}`;
      if(!originals.has(key))originals.set(key,row.text);
    }
    const store=new MemoryStore({memoryDir,threadId});
    try{
      const rows=store.db.prepare("SELECT message_seq AS messageSeq,timestamp,role,text FROM messages WHERE thread_id=? ORDER BY message_seq").all(threadId);
      const candidates=rows.map(row=>({row,original:originals.get(`${row.timestamp}\u0000${row.role}\u0000${String(row.text).trim()}`)})).filter(item=>item.original!==undefined&&item.original!==item.row.text);
      if(args.includes("--dry-run"))return {threadId,candidates:candidates.length};
      const update=store.db.prepare("UPDATE messages SET text=?,message_id=? WHERE message_seq=?");let restored=0;
      const tx=store.db.transaction(()=>{for(const {row,original} of candidates){try{restored+=update.run(original,messageIdentity(row.timestamp,row.role,original),row.messageSeq).changes;}catch(error){if(!String(error.code||"").includes("CONSTRAINT"))throw error;}}});
      tx();return {threadId,restored};
    }finally{store.close();}
  }
  if(action==="preview") {
    return {threadId,policy:current,...scanPolicyPreview(memoryDir,current)};
  }
  if(action==="apply") {
    const batch=valueAfter(args,"--batch-file"); if(!batch) throw new Error("apply 需要 --batch-file");
    const payload=JSON.parse(fs.readFileSync(batch,"utf8")),next=normalizePolicy(payload);
    const store=new MemoryStore({memoryDir,threadId});
    try {
      const confirmedPlan=String(payload.confirmedPlan||""),freshPlan=buildCleaningPlan(store,next,memoryDir);
      if(!confirmedPlan||confirmedPlan!==freshPlan.token)throw new Error("清洗范围尚未预览或对话库已变化，请重新预览后确认");
      const hasCleaningRules=next.cleaning.exactDuplicates.some(item=>item.enabled)
        ||next.cleaning.injectionFragments.some(item=>item.enabled)
        ||next.cleaning.recallHeaders.some(item=>item.enabled)
        ||next.cleaning.customRuleHeaders.length>0;
      const existing=hasCleaningRules?store.db.prepare(`SELECT message_seq AS messageSeq,timestamp,source_date AS sourceDate,role,text,source
        FROM messages WHERE thread_id=? AND COALESCE(source,'') NOT LIKE 'tool_event:%' AND COALESCE(source,'') NOT LIKE 'conversation_policy:%'
        ORDER BY timestamp,message_seq`).all(threadId):[];
      const seenDuplicates=new Set(),filterRows=[];
      let removedConversations=0,cleanedConversations=0;
      const removeMessage=store.db.prepare("DELETE FROM messages WHERE message_seq=?");
      const updateMessage=store.db.prepare("UPDATE messages SET text=?,message_id=? WHERE message_seq=?");
      const cleanExisting=store.db.transaction(()=>{
        for(const row of existing){
          const duplicateRule=next.cleaning.exactDuplicates.find(item=>item.enabled&&(!item.role||item.role===row.role)&&item.text===String(row.text).trim());
          const duplicateSeen=!!duplicateRule&&seenDuplicates.has(duplicateRule.id);
          if(duplicateRule)seenDuplicates.add(duplicateRule.id);
          const cleaned=applyConversationCleaning(row.text,next.cleaning,{duplicateSeen,role:row.role});
          if(cleaned.removed.length)for(const item of cleaned.removed)filterRows.push({timestamp:row.timestamp,category:item.category,ruleId:item.ruleId,originalText:item.text,retainedText:cleaned.text||null});
          if(!cleaned.keep){removedConversations+=removeMessage.run(row.messageSeq).changes;continue;}
          if(cleaned.text!==row.text){
            try{cleanedConversations+=updateMessage.run(cleaned.text,messageIdentity(row.timestamp,row.role,cleaned.text),row.messageSeq).changes;}
            catch(error){if(String(error.code||"").includes("CONSTRAINT"))removedConversations+=removeMessage.run(row.messageSeq).changes;else throw error;}
          }
        }
      });
      cleanExisting();
      store.logConversationFilters(filterRows);
      const removed=store.db.prepare("DELETE FROM messages WHERE thread_id=? AND (source LIKE 'tool_event:%' OR source LIKE 'conversation_policy:%')").run(threadId).changes;
      const stats={};let imported=0,duplicates=0;
      for(const file of fullFiles(memoryDir)) {
        const records=parseThreadMessages(fs.readFileSync(file,"utf8")),extracted=extractToolEvents(records,next);mergeStats(stats,extracted.stats);
        const supplemental=[...policyConversationEvents(records,next),...extractThinkingEvents(records,next),...extracted.rows];
        const rows=supplemental.map(row=>({timestamp:row.timestamp,sourceDate:beijingDateKey(row.timestamp),role:row.type,text:row.text,source:row.source})).filter(row=>row.sourceDate);
        const result=store.insertMessagesDetailed(rows,{source:"tool_event"});imported+=result.inserted;duplicates+=result.duplicates;
      }
      const savedPolicy=saveToolEventPolicy(memoryDir,{...next,cleaning:{...next.cleaning,exactDuplicates:[]}});
      return {threadId,policy:savedPolicy,removed,imported,duplicates,removedConversations,cleanedConversations,filteredLogged:filterRows.length,observed:Object.entries(stats).map(([name,count])=>({name,count}))};
    } finally {store.close();}
  }
  throw new Error(`未知 action: ${action}`);
}
if(require.main===module){try{console.log(JSON.stringify(runToolPolicy(),null,2));}catch(error){console.error(`[tool-policy] error: ${error.message}`);process.exit(1);}}
module.exports={runToolPolicy,buildUnfilterPlan,applyUnfilter,buildUnfilterBatchPlan,applyUnfilterBatch};
