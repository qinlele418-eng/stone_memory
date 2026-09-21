"use strict";
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('node:child_process');
test('sentence-book real MCP process preserves CRUD, revisions and authorization',t=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'sentence-mcp-'));
 t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
 const root=path.join(home,'.stone_memory');fs.mkdirSync(root);
 fs.writeFileSync(path.join(root,'stmem.json'),JSON.stringify({synthetic:{runtime:'codex',purpose:'accompany',user:'user',ai:'assistant',mcpModules:['notebook-lab']}}));
 const env={...process.env,HOME:home,USERPROFILE:home,STMEM_DB_PATH:path.join(root,'stone-memory.db'),STMEM_CURRENT_THREAD_ID:'synthetic',STMEM_SKIP_PENDING_REBUILDS:'1',STMEM_SEARCH_ONLY:'0',STMEM_NOTEBOOK_STEWARD:'0'};delete env.NODE_TEST_CONTEXT; delete env.STMEM_MEMORY_ID; delete env.STMEM_BINDING_ID;
 const request=(method,params)=>{const r=spawnSync(process.execPath,[path.join(__dirname,'../mcp-server.js')],{env,input:JSON.stringify({jsonrpc:'2.0',id:1,method,params})+'\n',encoding:'utf8',timeout:15000});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout.trim().split(/\r?\n/).find(x=>JSON.parse(x).id===1)).result;};
 const call=(name,args)=>request('tools/call',{name:'stmem_notebook_'+name,arguments:args});
 const data=(name,args)=>{const r=call(name,args);assert.equal(r.isError,false,JSON.stringify(r));return JSON.parse(r.content[0].text);};
 assert.ok(request('tools/list',{}).tools.some(x=>x.name==='stmem_notebook_write'));
 const topic=data('topic_manage',{action:'create',name:'Synthetic book',kind:'sentence-book'});assert.equal(topic.kind,'sentence-book');
 let note=data('write',{topicId:topic.id,title:'Synthetic quote',body:'Quote body',metadata:{speaker:'speaker-key',note:'ripple-key',collector:'user'}});
 let read=data('read',{noteId:note.id});assert.equal(read.metadata.note,'ripple-key');
 assert.equal(data('status',{}).topics[0].kind,'sentence-book');
 assert.equal(data('query',{query:'speaker-key'}).matches[0].id,note.id);
 assert.equal(data('query',{query:'ripple-key'}).matches[0].id,note.id);
 const old=note.revision;
 for(const sentenceRemoved of [true,false]){read=data('read',{noteId:note.id});note=data('write',{topicId:topic.id,noteId:note.id,title:read.title,body:'Updated body',expectedRevision:read.revision,metadata:{...read.metadata,sentenceRemoved}});assert.equal(data('read',{noteId:note.id}).metadata.sentenceRemoved,sentenceRemoved);}
 assert.equal(call('write',{topicId:topic.id,noteId:note.id,title:'Stale',body:'No',expectedRevision:old}).isError,true);
 assert.equal(call('read',{thread:'unauthorized',noteId:note.id}).isError,true);
 assert.equal(call('write',{title:'Bad',body:'No',metadata:{unexpected:'bad'}}).isError,true);
 fs.writeFileSync(path.join(root,'stmem.json'),JSON.stringify({synthetic:{runtime:'codex',purpose:'accompany',user:'user',ai:'assistant',mcpModules:[]}}));
 assert.equal(request('tools/list',{}).tools.some(x=>x.name==='stmem_notebook_write'),false);
});
