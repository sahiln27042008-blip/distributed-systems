import { createHash } from "node:crypto";

// Single inline page. All dynamic data is written with textContent (no innerHTML),
// and the CSP allows only these exact inline blocks (sha256) + same-origin fetch.
const CSS = `
body{font:14px system-ui,sans-serif;margin:0;padding:12px;background:#f6f7f9;color:#1b1f24}
h1{font-size:16px;margin:0 0 4px}h2{font-size:13px;margin:12px 0 4px;text-transform:uppercase;letter-spacing:.04em;color:#57606a}
.note{color:#57606a;font-size:12px;margin:0 0 8px}
.bar{display:flex;flex-wrap:wrap;gap:6px;align-items:center;background:#fff;border:1px solid #d0d7de;padding:8px;border-radius:6px}
button,select,input{font:inherit}button{padding:4px 10px}button:disabled{opacity:.4}
.mt{margin-top:12px}
.err{background:#ffebe9;border:1px solid #ff8182;color:#82071e;padding:6px 8px;margin:8px 0;border-radius:6px}.err:empty{display:none}
.grid{display:grid;grid-template-columns:minmax(300px,540px) 1fr;gap:12px}
@media(max-width:900px){.grid{grid-template-columns:1fr}}
.card{background:#fff;border:1px solid #d0d7de;border-radius:6px;padding:8px;overflow:auto}
table{border-collapse:collapse;width:100%;font-size:12px}th,td{border-bottom:1px solid #eaeef2;padding:2px 6px;text-align:left;vertical-align:top}
td.d{font-family:ui-monospace,monospace;word-break:break-all}
#events{max-height:340px;overflow:auto}
.hidden-panel{display:none}
.chips span{display:inline-block;padding:2px 8px;margin:2px;border:1px solid #d0d7de;border-radius:10px;font-size:12px;color:#57606a}
.chips span.cur{background:#0969da;color:#fff;border-color:#0969da}
svg text{font-size:12px;fill:#1b1f24}svg .sub{font-size:10px;fill:#57606a}
svg rect{fill:#fff;stroke:#8c959f}svg .hot rect{fill:#ddf4ff;stroke:#0969da}svg line{stroke:#57606a}
`;

const JS = `
"use strict";
var $=function(id){return document.getElementById(id)};
var S=null,poll=null,SVGNS="http://www.w3.org/2000/svg";
var STATES=["requested","account_verified","payment_pending","payment_retrying","completed","failed"];
function api(method,path,body){
  var o={method:method};
  if(body){o.headers={"Content-Type":"application/json"};o.body=JSON.stringify(body)}
  return fetch(path,o).then(function(r){
    return r.json().then(function(j){
      if(!r.ok){var e=new Error(j&&j.message?j.message:"request failed ("+r.status+")");throw e}
      return j;
    },function(){throw new Error("server returned non-JSON ("+r.status+")")});
  });
}
function setErr(m){$("err").textContent=m||""}
function refresh(){return api("GET","/api/state").then(function(s){S=s;render()},function(e){setErr(e.message)})}
function op(o){
  return api("POST","/api/op",o).then(function(s){S=s;setErr("");render()},function(e){setErr(e.message);return refresh()});
}
function td(tr,text,cls){var c=document.createElement("td");c.textContent=text;if(cls)c.className=cls;tr.appendChild(c)}
function fill(tbody,rows,cols){
  tbody.textContent="";
  (rows||[]).forEach(function(r){var tr=document.createElement("tr");cols.forEach(function(c){td(tr,String(r[c]===null||r[c]===undefined?"":r[c]))});tbody.appendChild(tr)});
}
function nodeFor(kind){
  if(kind.indexOf("account.")===0)return"account";
  if(kind.indexOf("payment.")===0)return"payment";
  if(kind==="db.write")return"db";
  return"client";
}
function svgEl(name,attrs,text){
  var e=document.createElementNS(SVGNS,name);
  for(var k in attrs)e.setAttribute(k,attrs[k]);
  if(text!==undefined)e.textContent=text;
  return e;
}
function drawTopology(){
  var svg=$("topo");svg.textContent="";
  var names=S.services.map(function(s){return s.name}),pos={},n=names.length,cx=270,cy=120,r=85;
  names.forEach(function(nm,i){var a=(-90+360*i/n)*Math.PI/180;pos[nm]={x:cx+Math.cos(a)*r*1.9,y:cy+Math.sin(a)*r}});
  var last=S.events.length?nodeFor(S.events[S.events.length-1].kind):null;
  svg.appendChild(svgEl("defs",{})).appendChild(svgEl("marker",{id:"ar",markerWidth:8,markerHeight:8,refX:7,refY:3,orient:"auto"})).appendChild(svgEl("path",{d:"M0,0 L7,3 L0,6 z",fill:"#57606a"}));
  S.links.forEach(function(l){
    var p=l.split(">"),a=pos[p[0]],b=pos[p[1]];if(!a||!b)return;
    var dx=b.x-a.x,dy=b.y-a.y,d=Math.sqrt(dx*dx+dy*dy)||1,k=34/d;
    svg.appendChild(svgEl("line",{x1:a.x+dx*k,y1:a.y+dy*k,x2:b.x-dx*k,y2:b.y-dy*k,"marker-end":"url(#ar)"}));
  });
  S.services.forEach(function(s){
    var p=pos[s.name],g=svgEl("g",{"class":s.name===last?"hot":""});
    g.appendChild(svgEl("rect",{x:p.x-48,y:p.y-20,width:96,height:40,rx:6}));
    g.appendChild(svgEl("text",{x:p.x,y:p.y-3,"text-anchor":"middle"},s.name));
    g.appendChild(svgEl("text",{x:p.x,y:p.y+12,"text-anchor":"middle","class":"sub"},s.kind));
    svg.appendChild(g);
  });
}
function render(){
  if(!S)return;
  var c=S.config,idle=S.life==="idle",run=S.life==="running";
  var isEnterprise=S.model==="enterprise";
  var isChaos=S.model==="chaos";
  $("refundPanel").className=isEnterprise||isChaos?"card hidden-panel":"card";
  $("m6Panel").className=isEnterprise?"card":"card hidden-panel";
  $("chaosPanel").className=isChaos?"card":"card hidden-panel";
  $("refundDbPanel").className=isEnterprise?"card hidden-panel":"card";
  $("opsPanel").className=isEnterprise?"card hidden-panel":"card";
  $("refundDbPanel").className=isEnterprise||isChaos?"card hidden-panel":"card";
  $("opsPanel").className=isEnterprise||isChaos?"card hidden-panel":"card";
  $("expa").disabled=isEnterprise||isChaos;$ ("expa").title=isEnterprise||isChaos?"auditor export unavailable for this trace model":"";
  $("status").textContent="lifecycle: "+S.life+" | virtual time: "+S.now+" ms | pending scheduled events: "+S.pending+" | autoplay: "+(S.autoplay?"on":"off");
  $("preset").value=isChaos?(c.mode==="naive"?"m7-naive":"m7-resilient"):isEnterprise?(c.mode==="fault"?"m6-fault":"m6-healthy"):c.mode;$("preset").disabled=!idle;
  $("idem").checked=c.idempotency;$("idem").disabled=!idle;
  $("start").disabled=!idle;$("play").disabled=!run||S.autoplay;$("pause").disabled=!run||!S.autoplay;
  $("step").disabled=!run;$("adv").disabled=!run;$("stop").disabled=!run||isEnterprise;$("stop").disabled=$("stop").disabled||isChaos;
  $("cfg").textContent=isChaos?"scenario config: run "+c.runId+", seed "+c.seed+", mode "+c.mode:isEnterprise?"scenario config: seed "+c.seed+", mode "+c.mode+", queue capacity "+c.queueCapacity+", workers "+c.workerCount:"scenario config: seed "+c.seed+", order "+c.orderId+", timeout "+c.timeoutMs+" ms, max retries "+c.maxRetries+", replay after success: "+c.replay;
  drawTopology();
  var chips=$("chips");chips.textContent="";
  STATES.forEach(function(st){var s=document.createElement("span");s.textContent=st;if(st===S.refundState)s.className="cur";chips.appendChild(s)});
  $("rstate").textContent="current refund state: "+S.refundState+(S.error?" | ENGINE ERROR: "+S.error:"");
  var tb=$("ev");tb.textContent="";
  S.events.forEach(function(e){var tr=document.createElement("tr");td(tr,e.id);td(tr,e.t);td(tr,e.kind);td(tr,e.parent||"");td(tr,JSON.stringify(e.data),"d");tb.appendChild(tr)});
  $("evcount").textContent="events: "+S.eventTotal+(S.eventTotal>S.events.length?" (showing last "+S.events.length+")":"");
  var box=$("events");box.scrollTop=box.scrollHeight;
  var m=S.m6;
  if(isEnterprise&&m){
    $("m6summary").textContent="lifecycle: "+m.life+" | virtual time: "+m.now+" ms | queue: "+m.queue.length+"/"+m.queue.capacity+" | resource: "+m.sharedResource.state+" ("+m.sharedResource.inUse+"/"+m.sharedResource.capacity+", waiting "+m.sharedResource.waitDepth+")";
    fill($("m6queue"),m.queue.items,["id","workflow","status"]);
    fill($("m6workers"),m.workers,["id","state","currentJob"]);
    fill($("m6workflows"),m.workflows,["name","status"]);
    fill($("m6deadletters"),m.deadLetters,["workflow","jobId","reason","at"]);
  }
  var chaos=S.chaos;
  if(isChaos&&chaos){
    var cm=chaos.metrics;
    $("chaosSummary").textContent="mode: "+chaos.mode+" | virtual time: "+chaos.virtualTimeMs+" ms | host: "+chaos.host.state+" | workflows: "+chaos.workflows.length+" | events: "+chaos.eventsCount;
    $("chaosDb").textContent="DB pool: "+cm.activeDbConnections+"/"+c.poolCapacity+" active | waiters: "+cm.dbWaitQueueLength+" | peak: "+cm.peakActiveDbConnections+" | timeouts: "+cm.poolAcquisitionTimeouts+" | held: "+cm.totalDbConnectionHoldMs+" ms | occupied-time utilization: "+cm.dbPoolUtilizationPercent.toFixed(2)+"% over "+cm.measurementWindowMs+" virtual ms";
    $("chaosFaults").textContent="Main-host crashes: "+cm.mainHostCrashes+" | contained worker crashes: "+cm.containedWorkerCrashes+" (worker "+chaos.workers[0].state+") | tokens: "+cm.tokensConsumed+" | duplicate charge: $"+cm.duplicateDollarsCharged+" | orphaned instances: "+cm.orphanedAwsInstances;
    $("chaosBatch").textContent="Batch: "+chaos.batch.succeeded+" succeeded, "+chaos.batch.failed+" failed, "+chaos.batch.aborted+" innocent items aborted (50 total)";
    $("chaosSaga").textContent="Payment attempts: "+chaos.payment.attempts+" | receipts: "+chaos.payment.receipts+" | saga compensation order: "+chaos.saga.compensationOrder.join(" <- ")+" | compensated: "+chaos.saga.compensated.length+"/"+chaos.saga.forwardSteps.length+" | compensation failures: "+cm.sagaCompensationsFailed+" | resources allocated: "+chaos.saga.resourcesAllocated;
    fill($("chaosWorkflows"),chaos.workflows,["taskId","tenant","tenantId","status","dbHeldMs","retries"]);
  }
  fill($("refunds"),S.refunds,["id","order_id","amount_cents","idem_key","attempt","created_t"]);
  fill($("ops"),S.operations,["id","state","refund_id","t"]);
  if(!isEnterprise&&!isChaos)$("derived").textContent="derived from DB rows: duplicate refunds = "+S.derived.duplicateRefunds;
  $("auditor").textContent="auditor: "+(S.auditor.connected?"connected":"not run by this page - "+S.auditor.reason);
  if(S.autoplay&&!poll)poll=setInterval(refresh,300);
  if(!S.autoplay&&poll){clearInterval(poll);poll=null}
}
$("preset").onchange=function(){var preset=$("preset").value;if(preset.indexOf("m7-")===0){op({op:"configure",scenario:"chaos",mode:preset==="m7-naive"?"naive":"resilient",seed:7,runId:"chaos-run-7"});return}op({op:"configure",preset:preset,scenario:preset.indexOf("m6-")===0?"enterprise":"refund",idempotency:$("idem").checked})};
$("idem").onchange=$("preset").onchange;
$("start").onclick=function(){op({op:"start"})};
$("play").onclick=function(){op({op:"play"})};
$("pause").onclick=function(){op({op:"pause"})};
$("step").onclick=function(){op({op:"step"})};
$("adv").onclick=function(){op({op:"advance",ms:500})};
$("stop").onclick=function(){op({op:"stop"})};
$("reset").onclick=function(){op({op:"reset"})};
$("exp").onclick=function(){
  api("GET","/api/trace").then(function(t){
    var a=document.createElement("a");
    a.href=URL.createObjectURL(new Blob([JSON.stringify(t,null,2)],{type:"application/json"}));
    a.download="refund-sim.trace.json";document.body.appendChild(a);a.click();a.remove();setErr("");
  },function(e){setErr(e.message)});
};
$("expa").onclick=function(){
  fetch("/api/auditor-export").then(function(r){
    if(!r.ok)return r.json().then(function(j){throw new Error(j.message||"export failed")});
    return r.text();
  }).then(function(t){
    var a=document.createElement("a");
    a.href=URL.createObjectURL(new Blob([t],{type:"application/x-ndjson"}));
    a.download="refund-sim.langchain-callback.jsonl";document.body.appendChild(a);a.click();a.remove();setErr("");
  }).catch(function(e){setErr(e.message)});
};
refresh();
`;

const BODY = `
<h1>Enterprise simulator &mdash; local enterprise infrastructure</h1>
<p class="note">Everything here is SIMULATED: virtual clock, mock services, in-memory SQLite. Nothing measures real infrastructure.</p>
<div class="bar">
  <label>Scenario <select id="preset"><option value="healthy">healthy</option><option value="timeout">timeout + retry</option><option value="m6-healthy">M6 healthy</option><option value="m6-fault">M6 fault</option><option value="m7-naive">M7 chaos naive</option><option value="m7-resilient">M7 chaos resilient</option></select></label>
  <label><input type="checkbox" id="idem"> idempotency</label>
  <button id="start">Start</button><button id="play">Play</button><button id="pause">Pause</button>
  <button id="step">Step (next event)</button><button id="adv">Advance 500 ms</button>
  <button id="stop">Stop</button><button id="reset">Reset</button><button id="exp">Export trace JSON</button><button id="expa">Export for auditor (JSONL)</button>
</div>
<div id="err" class="err"></div>
<p id="status" class="note"></p><p id="cfg" class="note"></p>
<div class="grid">
  <div id="refundPanel" class="card"><h2>Service topology (from registry)</h2><svg id="topo" viewBox="0 0 540 240" width="100%" height="240" role="img" aria-label="service topology"></svg>
    <h2>Refund workflow</h2><div class="chips" id="chips"></div><p id="rstate" class="note"></p></div>
  <div id="m6Panel" class="card hidden-panel"><h2>Shared queue / worker / resource</h2><p id="m6summary" class="note"></p>
    <h2>Queue</h2><table><thead><tr><th>id</th><th>workflow</th><th>status</th></tr></thead><tbody id="m6queue"></tbody></table>
    <h2>Workers</h2><table><thead><tr><th>id</th><th>state</th><th>job</th></tr></thead><tbody id="m6workers"></tbody></table>
    <h2>Workflows</h2><table><thead><tr><th>name</th><th>status</th></tr></thead><tbody id="m6workflows"></tbody></table>
    <h2>Dead letters</h2><table><thead><tr><th>workflow</th><th>job</th><th>reason</th><th>at</th></tr></thead><tbody id="m6deadletters"></tbody></table>
  </div>
  <div id="chaosPanel" class="card hidden-panel"><h2>Enterprise Chaos Lab</h2><p id="chaosSummary" class="note"></p><p id="chaosDb" class="note"></p><p id="chaosFaults" class="note"></p><p id="chaosBatch" class="note"></p><p id="chaosSaga" class="note"></p>
    <h2>Tenant workflows</h2><table><thead><tr><th>task</th><th>tenant</th><th>tenant ID</th><th>status</th><th>DB held ms</th><th>retries</th></tr></thead><tbody id="chaosWorkflows"></tbody></table>
  </div>
  <div class="card"><h2>Event timeline</h2><p id="evcount" class="note"></p>
    <div id="events"><table><thead><tr><th>id</th><th>t (ms)</th><th>kind</th><th>parent</th><th>data</th></tr></thead><tbody id="ev"></tbody></table></div></div>
</div>
<div class="grid mt">
  <div id="refundDbPanel" class="card"><h2>DB: refunds</h2><table><thead><tr><th>id</th><th>order</th><th>cents</th><th>idem key</th><th>attempt</th><th>t</th></tr></thead><tbody id="refunds"></tbody></table>
    <p id="derived" class="note"></p></div>
  <div id="opsPanel" class="card"><h2>DB: operations</h2><table><thead><tr><th>id</th><th>state</th><th>refund id</th><th>t</th></tr></thead><tbody id="ops"></tbody></table>
    <p id="auditor" class="note"></p></div>
</div>
`;

const sha = (s: string) => `'sha256-${createHash("sha256").update(s).digest("base64")}'`;

export const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Enterprise simulator</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>${CSS}</style></head><body>${BODY}<script>${JS}</script></body></html>`;

export const CSP = [
  "default-src 'none'",
  `script-src ${sha(JS)}`,
  `style-src ${sha(CSS)}`,
  "connect-src 'self'",
  "img-src 'self' blob:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");
