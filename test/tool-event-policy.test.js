const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizePolicy, extractToolEvents } = require("../src/services/tool-event-policy");

test("Claude tool_use can become a selected readable event", () => {
  const records=[{type:"assistant",timestamp:"2026-08-31T10:00:00Z",message:{content:[{type:"tool_use",id:"t1",name:"speaker.say",input:{room:"客厅",text:"该休息了",token:"secret"}}]}}];
  const result=extractToolEvents(records,{tools:{"speaker.say":{mode:"event",label:"客厅音响",fields:["room","text","token"]}}});
  assert.equal(result.rows.length,1);
  assert.match(result.rows[0].text,/客厅音响/);
  assert.match(result.rows[0].text,/该休息了/);
  assert.doesNotMatch(result.rows[0].text,/secret/);
});

test("Codex function outputs can use the call name", () => {
  const records=[
    {type:"response_item",timestamp:"2026-08-31T10:00:00Z",payload:{type:"function_call",call_id:"c1",name:"lights.on",arguments:'{"room":"卧室"}'}},
    {type:"response_item",timestamp:"2026-08-31T10:00:01Z",payload:{type:"function_call_output",call_id:"c1",output:'{"ok":true}'}}
  ];
  const result=extractToolEvents(records,{tools:{"lights.on":{mode:"both"}}});
  assert.equal(result.rows.length,2);
  assert.match(result.rows[1].text,/返回/);
});

test("unconfigured tools stay excluded and sensitive field selectors are rejected", () => {
  const policy=normalizePolicy({tools:{x:{mode:"event",fields:["text","apiKey"]}}});
  assert.deepEqual(policy.tools.x.fields,["text"]);
  const result=extractToolEvents([{type:"response_item",timestamp:"2026-08-31T10:00:00Z",payload:{type:"function_call",name:"other",arguments:"{}"}}],policy);
  assert.equal(result.rows.length,0);
});
