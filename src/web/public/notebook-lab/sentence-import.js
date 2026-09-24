(() => {
  "use strict";
  const MAX=5000, MAX_BYTES=128*1024*1024, MAX_TEXT=8000, MAX_ID=240, MAX_TITLE=300;
  const esc=v=>String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
  const s=v=>String(v??"").trim();
  const key=n=>s(n?.metadata?.source_id||n?.metadata?.sourceId||n?.source_id);
  const fingerprint=value=>{let a=14695981039346656037n,b=7809847782465536322n;for(const ch of String(value)){const c=BigInt(ch.codePointAt(0));a=BigInt.asUintN(64,(a^c)*1099511628211n);b=BigInt.asUintN(64,(b^c)*14029467366897019727n);}return `sentence-import:f:${a.toString(16)}${b.toString(16)}`;};
  const normalize=(raw,index,session)=>{
    if(!raw||typeof raw!=="object"||Array.isArray(raw))return {invalid:"记录格式不正确"};
    const body=s(raw.content??raw.quote??raw.body??raw.text), id=s(raw.id??raw.source_id??raw.sourceId), title=s(raw.conv_title??raw.conversation_title??raw.title), stamp=raw.created_at??raw.createdAt;
    if(!body)return {invalid:"缺少句子内容"}; if(body.length>MAX_TEXT)return {invalid:"句子超过8000字"}; if(id.length>MAX_ID)return {invalid:"原记录ID超过长度限制"}; if(title.length>MAX_TITLE)return {invalid:"对话标题超过长度限制"}; if(stamp!=null&&(!Number.isFinite(Number(stamp))||Number.isNaN(new Date(Number(stamp)*1000).valueOf())))return {invalid:"日期需要有效的秒时间戳"};
    const source_id=id||fingerprint(JSON.stringify([body,title,raw.speaker||raw.role||"",raw.collector||"",raw.note||"",raw.note_author||"",stamp??null])); const role=s(raw.role??raw.speaker).toLowerCase(); const speaker=s(raw.speaker)||(role==="assistant"?"助手":"用户"); const collector=s(raw.collector)||"用户"; const note=s(raw.note); if(note.length>1200)return {invalid:"涟漪超过1200字"}; const metadata={source_id,speaker,collector,note,note_author:note?s(raw.note_author)||collector:""};
    if(title)metadata.conversation_title=title; if(stamp!=null){const d=new Date(Number(stamp)*1000);if(!Number.isNaN(d.valueOf()))metadata.originalCreatedAt=d.toISOString();}
    return {body,title:title||"句子收藏",metadata,source_id};
  };
  function parse(input,session="session"){
    let value;try{value=JSON.parse(input);}catch{throw Error("JSON 格式不正确，请检查逗号和引号。");}
    const all=Array.isArray(value)?value:value&&Array.isArray(value.items)?value.items:null;if(!all||!all.length||all.length>MAX)throw Error("需要包含1至5000条记录的数组或items数组。");
    const normalized=all.map((v,i)=>normalize(v,i,session)); const valid=normalized.filter(v=>!v.invalid);if(!valid.length)throw Error("没有读到可导入的句子。");return {all:normalized,valid,skipped:normalized.length-valid.length};
  }
  function open({api,base,topic,notes=[],modal,onComplete}={}){
    if(!api?.api||!base||!topic||typeof modal!=="function")throw Error("句子导入缺少必要接口。");
    const pendingKey=`stone:notebook:sentence-import:${base}:${topic.id}`; let pending=[]; try{pending=JSON.parse(localStorage.getItem(pendingKey)||"[]");if(!Array.isArray(pending))pending=[];}catch{pending=[];} const existing=new Set(notes.map(key).filter(Boolean)); let parsed=null,busy=false,unknown=pending.length>0,cancelled=false,failed=[];
    const persist=()=>{pending.length?localStorage.setItem(pendingKey,JSON.stringify(pending)):localStorage.removeItem(pendingKey);};
    const body=`<p class="cq-muted">支持原版句子册 JSON。带原记录ID的内容会自动去重；没有ID的记录按内容生成稳定标识，重复导入会跳过。</p><label>选择JSON文件<input type="file" accept=".json,application/json" data-import-file></label><label>或粘贴JSON<textarea data-import-text rows="7" placeholder='[{"id":"原记录ID","content":"想留下的话","role":"assistant"}]'></textarea></label><p role="status" data-import-status></p><div data-import-preview></div><footer><button type="button" data-import-cancel>取消</button><button type="button" data-import-preview-button>预览导入</button><button type="button" data-import-confirm disabled>确认导入</button></footer>`;
    const dialog=modal("导入收藏句子",body); const text=dialog.querySelector("[data-import-text]"),status=dialog.querySelector("[data-import-status]"),preview=dialog.querySelector("[data-import-preview]"),confirm=dialog.querySelector("[data-import-confirm]"),allButtons=()=>dialog.querySelectorAll("button,input,textarea");
    const say=m=>{status.textContent=m||"";}; const lock=v=>{dialog.dataset.busy=v?"true":"";allButtons().forEach(e=>{e.disabled=v;});};
    const showPreview=()=>{if(unknown)return;try{parsed=parse(text.value);const seen=new Set(existing);const fresh=parsed.valid.filter(i=>{if(seen.has(i.source_id))return false;seen.add(i.source_id);return true;});preview.innerHTML=`<h3>将导入 ${fresh.length} 条</h3><p>有效 ${parsed.valid.length} 条，跳过无效 ${parsed.skipped} 条，已有 ${parsed.valid.length-fresh.length} 条。</p>${fresh.slice(0,10).map(i=>`<blockquote>${esc(i.body)}</blockquote>`).join("")}`;confirm.disabled=!fresh.length;say("预览完成，请确认后保存。");}catch(e){parsed=null;preview.innerHTML="";confirm.disabled=true;say(e.message);}};
    const refreshAndVerify=async()=>{const rows=await api.api(`${base}/topics/${encodeURIComponent(topic.id)}/entries`);const ids=new Set((rows||[]).map(key).filter(Boolean));return ids;};
    const save=async()=>{if(busy||unknown||!parsed)return;busy=true;failed=[];lock(true);say("正在逐条导入，请不要关闭窗口…");let added=0,existingCount=0,skipped=parsed.skipped;try{for(const item of parsed.valid){if(cancelled)break;if(existing.has(item.source_id)){existingCount++;continue;}try{pending=[item.source_id];persist();const result=await api.api(`${base}/entries`,{method:"POST",body:JSON.stringify({topicId:topic.id,title:item.title,body:item.body,tags:[],visibility:"visible",metadata:item.metadata})});if(!result?.id)throw Error("保存返回格式不完整");existing.add(item.source_id);pending=[];persist();added++;}catch(e){failed.push({item,error:e});unknown=true;break;}}}finally{busy=false;lock(false);}
      if(unknown){showRecovery();return;}
      if(failed.length){say(`已导入${added}条，${failed.length}条失败，可以再次确认重试失败项。`);confirm.disabled=false;return;}dialog.close();onComplete?.({added,existing:existingCount,skipped,cancelled});
    };
    function showRecovery(){
      confirm.disabled=true;text.disabled=true;dialog.querySelector("[data-import-file]").disabled=true;dialog.querySelector("[data-import-preview-button]").disabled=true;
      say("上次写入结果未确认，已暂停重复导入。请先重新读取核对。");
      let verify=dialog.querySelector("[data-import-verify]");
      if(!verify){verify=document.createElement("button");verify.type="button";verify.dataset.importVerify="";verify.textContent="重新读取核对";dialog.querySelector("footer").append(verify);}
      verify.onclick=async()=>{verify.disabled=true;try{const ids=await refreshAndVerify();ids.forEach(id=>existing.add(id));
        if(pending.length&&pending.every(id=>ids.has(id))){pending=[];persist();unknown=false;verify.remove();text.disabled=false;dialog.querySelector("[data-import-file]").disabled=false;dialog.querySelector("[data-import-preview-button]").disabled=false;confirm.disabled=!parsed;say("已确认上次收藏成功。可继续导入；已有记录会跳过。");}
        else say("暂未确认上次写入，仍暂停重复导入。请稍后重新核对。");
      }catch(error){say(`核对失败：${error.message}`);}finally{verify.disabled=false;}};
    }
    if(unknown)showRecovery();
    text.oninput=()=>{parsed=null;preview.innerHTML="";confirm.disabled=true;say("内容已修改，请重新预览。");};
    dialog.querySelector("[data-import-preview-button]").onclick=showPreview; dialog.querySelector("[data-import-confirm]").onclick=save; dialog.querySelector("[data-import-cancel]").onclick=()=>{if(!busy){cancelled=true;dialog.close();}};
    dialog.querySelector("[data-import-file]").onchange=async e=>{const file=e.target.files?.[0];if(!file)return;if(file.size>MAX_BYTES)return say("文件超过128MiB，请拆分后再导入。");try{text.value=await file.text();showPreview();}catch{say("文件没有读到，请重新选择。");}};
    return {dialog,cancel:()=>{cancelled=true;if(!busy)dialog.close();},parse};
  }
  window.StoneSentenceImport={open,parse,normalize};
})();
