/**
 * The dashboard HTML — zero runtime dependencies: one self-contained document with
 * inline CSS and vanilla JS that consumes the versioned control-plane DTOs and renders an
 * insightful, actionable view of the autonomous run. The browser loads a durable snapshot
 * before opening SSE; the stream only invalidates that snapshot and never becomes UI truth:
 *
 *  - a KPI header (progress, current-run sessions, review/blocked counts, attempts, freshness)
 *  - a "needs attention" strip (stale projection / blocked / rejected / escalated)
 *  - per-agent swimlane cards built only from allowlisted session and task summaries
 *  - a kanban board by status with dependency chips, "ready" + critical-path markers
 *  - an activity timeline (events + inter-agent messages)
 *
 * renderDashboard(projectName) keeps its signature (and HTML-escapes the name) so the
 * existing dashboard-render test holds.
 */
export function renderDashboard(projectName: string): string {
  const safeName = escapeHtml(projectName);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>RelayForge — ${safeName}</title>
  <style>${STYLE}</style>
</head>
<body data-project="${safeName}">
  <header>
    <h1>🛰 RelayForge <span class="sub">${safeName}</span></h1>
    <div class="hdr-right">
      <span class="live" id="connection" data-state="connecting"><span class="dot"></span><span id="livetext">connecting…</span></span>
      <button class="refresh" id="refresh-button" type="button">Refresh</button>
    </div>
  </header>

  <section class="kpis" id="kpis"></section>
  <section id="attention-strip"></section>

  <main>
    <div class="card span-agents"><h2>Agents <span class="count" id="agents-count"></span></h2><div class="agents" id="agents"></div></div>
    <div class="card span-board"><h2>Task board <span class="count" id="board-count"></span></h2><div class="kanban" id="kanban"></div></div>
    <div class="card span-timeline"><h2>Activity <span class="count">live</span></h2><div class="timeline" id="timeline"></div></div>
    <div class="card span-steering"><h2>Next-prompt steering <span class="count" id="steering-count"></span></h2><div class="steering" id="steering"></div></div>
    <div class="card span-observations"><h2>Verified control room <span class="count" id="observations-count"></span></h2><div class="observations" id="observations"></div></div>
  </main>

  <script>${CLIENT_JS}</script>
</body>
</html>`;
}

const STYLE = String.raw`
:root {
  color-scheme: dark;
  --bg:#0b0f14; --panel:#11161d; --panel2:#161c25; --border:#232c38;
  --fg:#e6edf3; --muted:#8b97a7; --dim:#5b6675;
  --green:#3fb950; --amber:#d29922; --red:#f85149; --blue:#58a6ff;
  --cyan:#56b6c2; --magenta:#c98bdb; --grey:#6e7681; --orange:#f0a868;
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
*{box-sizing:border-box;} body{margin:0;background:var(--bg);color:var(--fg);font-size:14px;}
header{display:flex;align-items:center;justify-content:space-between;padding:13px 20px;border-bottom:1px solid var(--border);position:sticky;top:0;background:rgba(11,15,20,.93);backdrop-filter:blur(6px);z-index:20;}
header h1{font-size:1.02rem;margin:0;display:flex;align-items:center;gap:9px;font-weight:650;}
header .sub{color:var(--muted);font-size:.8rem;font-weight:400;}
.hdr-right{display:flex;align-items:center;gap:14px;}
.live{display:inline-flex;align-items:center;gap:6px;color:var(--muted);font-size:.76rem;}
.dot{width:8px;height:8px;border-radius:50%;background:var(--grey);}
.live[data-state="connected"] .dot{background:var(--green);animation:pulse 2s infinite;}
.live[data-state="connecting"] .dot,.live[data-state="reconnecting"] .dot{background:var(--blue);animation:pulse 1.2s infinite;}
.live[data-state="degraded"] .dot{background:var(--amber);animation:pulse 1.5s infinite;}
.live[data-state="stale"] .dot{background:var(--orange);}
.live[data-state="error"] .dot{background:var(--red);}
@keyframes pulse{0%{box-shadow:0 0 0 0 rgba(63,185,80,.5);}70%{box-shadow:0 0 0 6px rgba(63,185,80,0);}100%{box-shadow:0 0 0 0 rgba(63,185,80,0);}}
.refresh{border:1px solid var(--border);background:var(--panel2);color:var(--fg);border-radius:8px;padding:6px 11px;cursor:pointer;font-size:.8rem;}
.refresh:hover{border-color:var(--blue);}

.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(148px,1fr));gap:10px;padding:16px 20px 6px;}
.kpi{background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:11px 14px;transition:background .4s;}
.kpi.flash{background:#1b2530;}
.kpi .label{color:var(--muted);font-size:.7rem;text-transform:uppercase;letter-spacing:.04em;}
.kpi .value{font-size:1.5rem;font-weight:650;margin-top:3px;line-height:1.1;}
.kpi .value small{font-size:.8rem;color:var(--muted);font-weight:400;}
.bar{height:5px;border-radius:4px;background:var(--panel2);margin-top:9px;overflow:hidden;}
.bar>span{display:block;height:100%;background:var(--green);transition:width .5s;}
.bar.warn>span{background:var(--amber);} .bar.crit>span{background:var(--red);}

#attention-strip:not(:empty){padding:8px 20px 4px;display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:8px;}
.att{border-radius:9px;padding:9px 12px;font-size:.82rem;border:1px solid var(--border);background:var(--panel);}
.att.warn{border-color:#5a4a16;background:#211c0e;color:var(--amber);}
.att.blocked,.att.escalated{border-color:#5a2020;background:#211010;}
.att.rejected{border-color:#4a2a52;background:#1d1322;}
.att .att-top{display:flex;justify-content:space-between;gap:8px;align-items:center;}
.att code{font-family:ui-monospace,monospace;color:var(--fg);}
.att .why{color:var(--muted);font-size:.76rem;margin-top:3px;}

main{padding:10px 20px 28px;display:grid;grid-template-columns:minmax(250px,1fr) 1.7fr minmax(280px,1fr);gap:14px;align-items:start;}
.span-steering,.span-observations{grid-column:1/-1;}
@media (max-width:1100px){main{grid-template-columns:1fr;}}
.card{background:var(--panel);border:1px solid var(--border);border-radius:12px;overflow:hidden;}
.card>h2{font-size:.84rem;margin:0;padding:11px 15px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;font-weight:600;}
.card>h2 .count{color:var(--muted);font-weight:400;font-size:.76rem;}

.agents{display:flex;flex-direction:column;gap:9px;padding:12px 14px;}
.agent{background:var(--panel2);border:1px solid var(--border);border-radius:10px;padding:10px 12px;border-left:3px solid var(--grey);}
.agent.working{border-left-color:var(--blue);} .agent.review-pending{border-left-color:var(--amber);}
.agent.blocked{border-left-color:var(--red);} .agent.idle{opacity:.66;}
.agent .top{display:flex;align-items:center;justify-content:space-between;gap:6px;}
.agent .name{font-weight:600;}
.agent .role-meta{color:var(--dim);font-size:.72rem;margin-top:1px;}
.agent .task{margin-top:7px;font-size:.82rem;}
.agent .muted{color:var(--muted);font-size:.76rem;margin-top:5px;}
.agent .stat-row{display:flex;flex-wrap:wrap;gap:10px;margin-top:8px;color:var(--dim);font-size:.71rem;}
.agent .idle-amber{color:var(--amber);} .agent .idle-red{color:var(--red);}
.statepill{font-size:.66rem;padding:1px 7px;border-radius:999px;border:1px solid var(--border);text-transform:capitalize;}
.statepill.working{color:var(--blue);} .statepill.review-pending{color:var(--amber);}
.statepill.blocked{color:var(--red);} .statepill.idle{color:var(--grey);}
.agent.waiting_input{border-left-color:var(--amber)} .agent.dispatching{border-left-color:var(--cyan)}
.agent.active{border-left-color:var(--blue)} .agent.settling{border-left-color:var(--magenta)}
.agent.exited{opacity:.66}.statepill.waiting_input{color:var(--amber)} .statepill.dispatching{color:var(--cyan)}
.statepill.active{color:var(--blue)} .statepill.settling{color:var(--magenta)} .statepill.exited{color:var(--grey)}
.agent details{margin-top:8px;} .agent summary{cursor:pointer;color:var(--dim);font-size:.72rem;}
.agent pre{white-space:pre-wrap;max-height:160px;overflow:auto;background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:8px;font-size:.7rem;margin:6px 0 0;color:var(--muted);}

.kanban{display:grid;grid-auto-flow:column;grid-auto-columns:minmax(155px,1fr);gap:10px;padding:12px 14px;overflow-x:auto;}
.lane h3{font-size:.7rem;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);margin:0 0 8px;display:flex;justify-content:space-between;}
.ticket{background:var(--panel2);border:1px solid var(--border);border-radius:8px;padding:8px 10px;margin-bottom:8px;border-top:2px solid var(--grey);}
.ticket.crit{box-shadow:inset 2px 0 0 var(--orange);}
.ticket .tid{color:var(--dim);font-size:.69rem;font-family:ui-monospace,monospace;display:flex;justify-content:space-between;}
.ticket .ttitle{font-size:.8rem;margin:2px 0 5px;}
.ticket .tmeta{display:flex;justify-content:space-between;color:var(--dim);font-size:.68rem;}
.chip{display:inline-block;font-size:.64rem;padding:0 6px;border-radius:999px;border:1px solid var(--border);margin:4px 4px 0 0;color:var(--dim);}
.chip.block{color:var(--red);border-color:#5a2020;} .chip.ok{color:var(--green);border-color:#1f5a2a;}
.badge-ready{font-size:.64rem;color:var(--green);border:1px solid #1f5a2a;border-radius:999px;padding:0 6px;}
.badge-crit{font-size:.64rem;color:var(--orange);}

.s-done{color:var(--green);}.s-open{color:var(--grey);}.s-claimed{color:var(--cyan);}
.s-in-progress{color:var(--blue);}.s-needs-review{color:var(--amber);}
.s-blocked{color:var(--red);}.s-rejected{color:var(--magenta);}.s-escalated{color:var(--orange);}
.bt-done{border-top-color:var(--green);}.bt-open{border-top-color:var(--grey);}.bt-claimed{border-top-color:var(--cyan);}
.bt-in-progress{border-top-color:var(--blue);}.bt-needs-review{border-top-color:var(--amber);}
.bt-blocked{border-top-color:var(--red);}.bt-rejected{border-top-color:var(--magenta);}.bt-escalated{border-top-color:var(--orange);}

.timeline{padding:4px 14px 12px;max-height:460px;overflow-y:auto;}
.tl{display:flex;gap:9px;padding:7px 0;border-bottom:1px solid var(--border);}
.tl .when{color:var(--dim);font-size:.69rem;font-variant-numeric:tabular-nums;white-space:nowrap;min-width:52px;}
.tl .who{font-weight:600;font-size:.74rem;white-space:nowrap;}
.tl .what{color:var(--muted);font-size:.77rem;}
.tl.msg .what{color:var(--cyan);}
.steering{padding:12px 14px;}
.steering-summary{display:flex;flex-wrap:wrap;gap:8px 16px;color:var(--muted);font-size:.76rem;margin-bottom:10px;}
.steering-sessions{display:flex;flex-wrap:wrap;gap:7px;margin-bottom:10px;}
.steering-session{border:1px solid var(--border);border-radius:999px;padding:3px 8px;color:var(--muted);font-size:.7rem;}
.steering-session strong{color:var(--fg);font-weight:500;}
.steering-list{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:8px;}
.steer{background:var(--panel2);border:1px solid var(--border);border-radius:9px;padding:9px 11px;min-width:0;}
.steer .top{display:flex;justify-content:space-between;gap:8px;align-items:center;}
.steer .sid{font-family:ui-monospace,monospace;color:var(--dim);font-size:.69rem;overflow-wrap:anywhere;}
.steer .status{font-size:.66rem;border:1px solid var(--border);border-radius:999px;padding:1px 7px;}
.steer.pending .status{color:var(--amber)} .steer.included .status{color:var(--green)} .steer.refused .status{color:var(--red)}
.steer .detail{font-size:.76rem;margin-top:6px;color:var(--fg);overflow-wrap:anywhere;}
.steer .target,.steer .source{font-size:.68rem;color:var(--dim);margin-top:4px;overflow-wrap:anywhere;}
.steer .preview{white-space:pre-wrap;overflow-wrap:anywhere;color:var(--muted);font-size:.73rem;margin:7px 0 0;border-left:2px solid var(--border);padding-left:7px;}
.observations{padding:12px 14px;display:grid;gap:10px;}
.observation-notices{display:flex;flex-wrap:wrap;gap:7px;}
.observation-notice{font-size:.72rem;color:var(--muted);border:1px solid var(--border);border-radius:999px;padding:2px 8px;}
.observation-notice.warn{color:var(--amber);border-color:#5a4a16;}
.observation-agents{display:flex;flex-wrap:wrap;gap:7px;}
.observation-agent{background:var(--panel2);border:1px solid var(--border);border-radius:8px;padding:7px 9px;font-size:.72rem;color:var(--muted);}
.observation-agent strong{color:var(--fg);font-weight:600;}
.observation-list{list-style:none;margin:0;padding:0;display:grid;gap:7px;}
.observation-item{background:var(--panel2);border:1px solid var(--border);border-radius:8px;padding:8px 10px;display:grid;grid-template-columns:auto auto 1fr;gap:5px 10px;align-items:baseline;}
.observation-item time,.observation-item code{font-size:.69rem;color:var(--dim);}
.observation-item .observation-summary{grid-column:1/-1;color:var(--muted);font-size:.76rem;overflow-wrap:anywhere;}
.empty{color:var(--dim);padding:18px;text-align:center;font-size:.82rem;}
code{font-family:ui-monospace,SFMono-Regular,monospace;}
`;

export const DASHBOARD_CLIENT_JS = String.raw`
(function relayForgeDashboardClient(){
"use strict";

const V=1;
const SERVICE="relayforge-control";
const JSON_LIMIT={status:262144,board:2097152,activity:2097152,steering:1048576,observations:4194304};
const FRAME_LIMIT=65536;
const FETCH_TIMEOUT_MS=5000;
const REFRESH_DEBOUNCE_MS=75;
const POLL_MS=2500;
const FAILURE_FALLBACK_THRESHOLD=3;
const LANES=["open","claimed","in-progress","needs-review","blocked","rejected","escalated","done"];
const LANE_LABEL={"open":"Open","claimed":"Claimed","in-progress":"In progress","needs-review":"In review","blocked":"Blocked","rejected":"Rejected","escalated":"Escalated","done":"Done"};
const TASK_STATES=new Set(LANES);
const RUN_STATES=new Set(["starting","running","waiting","succeeded","failed","cancelled","recovery-required","unknown"]);
const SESSION_STATES=new Set(["running","exited","unknown","probe-failed"]);
const ACTIVITY_KINDS=new Set(["run.started","run.completed","run.failed","run.cancelled","task.created","task.claimed","task.started","task.blocked","task.review-requested","task.completed","task.rejected","task.escalated","runtime.probe-failed"]);
const STEERING_ACTIVITIES=new Set(["idle","waiting_input","dispatching","active","settling","blocked","exited"]);
const STEERING_ACTIVITY_LABEL={"idle":"Idle","waiting_input":"Waiting for next prompt","dispatching":"Preparing attempt","active":"Active","settling":"Reconciling","blocked":"Blocked","exited":"Exited"};
const STEERING_BOUNDARIES=new Set(["initial-boundary-not-proven","safe-prompt-boundary","prepared-prompt-immutable","provider-attempt-active","reconciliation-pending","session-blocked","session-exited","activity-indeterminate"]);
const STEERING_STATUSES=new Set(["pending","included","refused","withdrawn","superseded","expired"]);
const STEERING_STATUS_LABEL={"pending":"Pending","included":"Included","refused":"Refused","withdrawn":"Withdrawn","superseded":"Superseded","expired":"Expired"};
const STEERING_SOURCES=new Set(["operator","review_gate","verifier","control_plane"]);
const STEERING_REFUSALS=new Set(["SESSION_BLOCKED","SESSION_EXITED","STALE_GENERATION","TASK_TERMINAL","TARGET_MISMATCH","EXPIRED","UNSUPPORTED_DELIVERY_MODE","INVALID_REQUEST","TASK_TERMINAL_BEFORE_INCLUSION"]);
const OBS_CATEGORIES=new Set(["runtime","provider","steering","scm","verification","artifact","system"]);
const OBS_PHASES=new Set(["queued","preparing","dispatching","executing","waiting","reviewing","verifying","publishing","settling","completed","failed"]);
const OBS_INTEGRITIES=new Set(["live","quiescent_final","recovered","replaced","degraded","unknown"]);
const OBS_ACTIVITIES=new Set(["idle","waiting_input","dispatching","active","settling","blocked","exited","unknown"]);
const OBS_ATTENTION=new Set(["needs_input","working","settling","blocked","failed","complete","idle","unknown"]);
const ATTEMPT_STATES=new Set(["prepared","active","exited","abandoned"]);
const ATTEMPT_OUTCOMES=new Set(["succeeded","failed","cancelled","uncertain"]);
const RESYNC_REASONS=new Set(["epoch","cursor-expired","future-cursor","replay-budget","schema"]);
const ID_RE=/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const EPOCH_RE=/^[A-Za-z0-9_-]{16,128}$/;
const HEX64_RE=/^[a-f0-9]{64}$/;
const TS_RE=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const OBS_ID_RE=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const CODE_RE=/^[a-z][a-z0-9._-]{0,63}$/;
let previousKpis={};

function esc(value){return String(value==null?"":value).replace(/[&<>"]/g,function(character){return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[character];});}
function clock(value){try{return new Date(value).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit",second:"2-digit"});}catch{return"";}}
function isObject(value){return value!==null&&typeof value==="object"&&!Array.isArray(value);}
function exact(value,keys){if(!isObject(value))return false;const actual=Object.keys(value);return actual.length===keys.length&&keys.every(function(key){return Object.prototype.hasOwnProperty.call(value,key);});}
function safeInteger(value){return Number.isSafeInteger(value)&&value>=0;}
function positiveInteger(value){return Number.isSafeInteger(value)&&value>=1;}
function id(value){return typeof value==="string"&&ID_RE.test(value)&&value!=="."&&value!==".."&&!value.includes("..");}
function epoch(value){return typeof value==="string"&&EPOCH_RE.test(value);}
function timestamp(value){if(typeof value!=="string"||!TS_RE.test(value))return false;try{return new Date(value).toISOString()===value;}catch{return false;}}
function text(value,maximum){return typeof value==="string"&&value.length<=maximum;}
function utf8Text(value,maximum){return typeof value==="string"&&new TextEncoder().encode(value).byteLength<=maximum;}
function nullable(value,guard){return value===null||guard(value);}
function freshness(value){return safeInteger(value.floorSeq)&&safeInteger(value.viewSeq)&&safeInteger(value.headSeq)&&value.floorSeq<=value.viewSeq&&value.viewSeq<=value.headSeq;}
function protocolFailure(){const error=new Error("The control service returned an invalid versioned response.");error.kind="protocol";throw error;}
function requireValue(condition,value){if(!condition)protocolFailure();return value;}

function parseCounts(value){
  requireValue(exact(value,["total","open","active","needsReview","blocked","done","rejected","escalated"]),value);
  ["total","open","active","needsReview","blocked","done","rejected","escalated"].forEach(function(key){requireValue(safeInteger(value[key]),value);});
  requireValue(value.open+value.active+value.needsReview+value.blocked+value.done+value.rejected+value.escalated===value.total,value);
  return value;
}

function parseRunSummary(value){
  requireValue(exact(value,["project","run","runEpoch","status","reason","startedAt","updatedAt","completedAt","viewSeq","headSeq","floorSeq","stale","tasks"]),value);
  requireValue(id(value.project)&&id(value.run)&&epoch(value.runEpoch)&&RUN_STATES.has(value.status),value);
  requireValue(nullable(value.reason,function(item){return typeof item==="string"&&/^[a-z][a-z0-9._-]{0,63}$/.test(item);}),value);
  requireValue(timestamp(value.startedAt)&&timestamp(value.updatedAt)&&nullable(value.completedAt,timestamp),value);
  requireValue(typeof value.stale==="boolean"&&freshness(value),value);parseCounts(value.tasks);return value;
}

function parseSession(value){
  requireValue(exact(value,["name","project","run","role","state","taskId","lastActivity"]),value);
  requireValue(typeof value.name==="string"&&value.name.length<=192&&/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value.name)&&!value.name.includes(".."),value);
  requireValue(id(value.project)&&id(value.run)&&id(value.role)&&SESSION_STATES.has(value.state),value);
  requireValue(nullable(value.taskId,id)&&nullable(value.lastActivity,timestamp),value);return value;
}

function parseStatus(value){
  requireValue(exact(value,["schemaVersion","service","instanceId","configId","status","startedAt","projects"]),value);
  requireValue(value.schemaVersion===V&&value.service===SERVICE&&typeof value.instanceId==="string"&&HEX64_RE.test(value.instanceId)&&typeof value.configId==="string"&&HEX64_RE.test(value.configId)&&value.status==="ok"&&timestamp(value.startedAt),value);
  requireValue(Array.isArray(value.projects)&&value.projects.length<=256,value);
  const seen=new Set();
  value.projects.forEach(function(project){
    requireValue(exact(project,["project","latestRun","sessions"])&&id(project.project)&&!seen.has(project.project),project);seen.add(project.project);
    if(project.latestRun!==null){parseRunSummary(project.latestRun);requireValue(project.latestRun.project===project.project,project);}
    requireValue(Array.isArray(project.sessions)&&project.sessions.length<=256,project);
    project.sessions.forEach(function(session){parseSession(session);requireValue(session.project===project.project,session);});
  });
  return value;
}

function parseTask(value){
  requireValue(exact(value,["id","title","status","assignee","claimedBy","priority","dependsOn","attempts","createdAt","updatedAt","summary"]),value);
  requireValue(id(value.id)&&text(value.title,4096)&&TASK_STATES.has(value.status)&&id(value.assignee)&&nullable(value.claimedBy,id),value);
  requireValue(Number.isInteger(value.priority)&&value.priority>=0&&value.priority<=100&&safeInteger(value.attempts)&&value.attempts<=100,value);
  requireValue(Array.isArray(value.dependsOn)&&value.dependsOn.length<=256&&value.dependsOn.every(id),value);
  requireValue(timestamp(value.createdAt)&&nullable(value.updatedAt,timestamp)&&nullable(value.summary,function(item){return text(item,4096);}),value);return value;
}

function parseBoard(value){
  requireValue(exact(value,["schemaVersion","project","run","runEpoch","viewSeq","headSeq","floorSeq","stale","tasks","counts"]),value);
  requireValue(value.schemaVersion===V&&id(value.project)&&id(value.run)&&epoch(value.runEpoch)&&typeof value.stale==="boolean"&&freshness(value),value);
  requireValue(Array.isArray(value.tasks)&&value.tasks.length<=4096,value);value.tasks.forEach(parseTask);parseCounts(value.counts);
  requireValue(value.tasks.length===value.counts.total,value);return value;
}

function parseActivity(value){
  requireValue(exact(value,["schemaVersion","project","run","runEpoch","viewSeq","headSeq","floorSeq","stale","activity","nextAfter"]),value);
  requireValue(value.schemaVersion===V&&id(value.project)&&id(value.run)&&epoch(value.runEpoch)&&typeof value.stale==="boolean"&&freshness(value),value);
  requireValue(Array.isArray(value.activity)&&value.activity.length<=500&&nullable(value.nextAfter,safeInteger),value);
  let prior=-1;
  value.activity.forEach(function(entry){
    requireValue(exact(entry,["seq","occurredAt","kind","actor","taskId","status","summary"]),entry);
    requireValue(safeInteger(entry.seq)&&entry.seq>prior&&entry.seq<=value.headSeq&&timestamp(entry.occurredAt)&&ACTIVITY_KINDS.has(entry.kind),entry);prior=entry.seq;
    requireValue(nullable(entry.actor,id)&&nullable(entry.taskId,id)&&nullable(entry.status,function(item){return TASK_STATES.has(item);})&&nullable(entry.summary,function(item){return text(item,4096);}),entry);
  });
  return value;
}

function parseSteeringQueue(value,sessionQueue){
  const keys=sessionQueue?["pendingCount","oldestPendingAgeMs","nextEligibleAttemptGeneration","boundaryReason"]:["pendingCount","oldestPendingAgeMs"];
  requireValue(exact(value,keys)&&safeInteger(value.pendingCount)&&nullable(value.oldestPendingAgeMs,safeInteger),value);
  if(sessionQueue){
    requireValue(nullable(value.nextEligibleAttemptGeneration,positiveInteger)&&STEERING_BOUNDARIES.has(value.boundaryReason),value);
    if(value.pendingCount===0)requireValue(value.nextEligibleAttemptGeneration===null,value);
  }
  requireValue((value.pendingCount===0)===(value.oldestPendingAgeMs===null),value);
  return value;
}

function parseSteeringSession(value){
  requireValue(exact(value,["sessionId","sessionGeneration","taskId","taskGeneration","activity","activityLabel","certainty","reason","observedAt","observedAgeMs","observedSeq","headSeq","stale","queue"]),value);
  requireValue(id(value.sessionId)&&positiveInteger(value.sessionGeneration)&&nullable(value.taskId,id)&&nullable(value.taskGeneration,positiveInteger),value);
  requireValue((value.taskId===null)===(value.taskGeneration===null)&&STEERING_ACTIVITIES.has(value.activity)&&value.activityLabel===STEERING_ACTIVITY_LABEL[value.activity],value);
  requireValue((value.certainty==="proven"||value.certainty==="indeterminate")&&utf8Text(value.reason,512)&&nullable(value.observedAt,timestamp)&&nullable(value.observedAgeMs,safeInteger),value);
  requireValue((value.observedAt===null)===(value.observedAgeMs===null)&&safeInteger(value.observedSeq)&&safeInteger(value.headSeq)&&value.observedSeq<=value.headSeq&&typeof value.stale==="boolean",value);
  if(value.observedSeq<value.headSeq)requireValue(value.stale,value);
  parseSteeringQueue(value.queue,true);return value;
}

function parseSteeringAttempt(value){
  requireValue(exact(value,["attemptId","attemptGeneration","promptSha256","includedSeq","state","preparedSeq","launchPlannedSeq","providerStartedSeq","providerExitedSeq","providerExitCode","outcome","abandonedSeq"]),value);
  requireValue(id(value.attemptId)&&positiveInteger(value.attemptGeneration)&&HEX64_RE.test(value.promptSha256)&&positiveInteger(value.includedSeq)&&ATTEMPT_STATES.has(value.state)&&positiveInteger(value.preparedSeq)&&value.preparedSeq<value.includedSeq,value);
  ["launchPlannedSeq","providerStartedSeq","providerExitedSeq","abandonedSeq"].forEach(function(key){requireValue(nullable(value[key],positiveInteger),value);});
  requireValue(nullable(value.providerExitCode,function(item){return Number.isInteger(item)&&item>=-1&&item<=255;})&&nullable(value.outcome,function(item){return ATTEMPT_OUTCOMES.has(item);}),value);
  if(value.providerStartedSeq!==null)requireValue(value.launchPlannedSeq!==null&&value.providerStartedSeq>value.launchPlannedSeq,value);
  if(value.providerExitedSeq!==null)requireValue(value.providerStartedSeq!==null&&value.providerExitedSeq>value.providerStartedSeq,value);
  if(value.launchPlannedSeq!==null)requireValue(value.launchPlannedSeq>value.includedSeq,value);
  if(value.abandonedSeq!==null)requireValue(value.providerStartedSeq===null&&value.abandonedSeq>value.includedSeq,value);
  if(value.state==="prepared")requireValue(value.providerStartedSeq===null&&value.providerExitedSeq===null&&value.abandonedSeq===null&&value.outcome===null&&value.providerExitCode===null,value);
  if(value.state==="active")requireValue(value.providerStartedSeq!==null&&value.providerExitedSeq===null&&value.abandonedSeq===null&&value.outcome===null&&value.providerExitCode===null,value);
  if(value.state==="exited")requireValue(value.providerStartedSeq!==null&&value.providerExitedSeq!==null&&value.abandonedSeq===null&&value.outcome!==null,value);
  if(value.state==="abandoned")requireValue(value.providerStartedSeq===null&&value.providerExitedSeq===null&&value.abandonedSeq!==null&&value.outcome===null&&value.providerExitCode===null,value);
  return value;
}

function parseSteeringCommand(value){
  requireValue(exact(value,["commandId","status","statusLabel","statusDetail","sourceKind","admittedSeq","admittedAt","terminalSeq","sessionId","sessionGeneration","taskId","taskGeneration","notBeforeAttemptGeneration","eligibleAttemptGeneration","bodySha256","preview","reasonCode","supersededByCommandId","attempt"]),value);
  requireValue(id(value.commandId)&&STEERING_STATUSES.has(value.status)&&value.statusLabel===STEERING_STATUS_LABEL[value.status]&&utf8Text(value.statusDetail,512),value);
  requireValue(nullable(value.sourceKind,function(item){return STEERING_SOURCES.has(item);})&&nullable(value.admittedSeq,positiveInteger)&&nullable(value.admittedAt,timestamp)&&nullable(value.terminalSeq,positiveInteger),value);
  requireValue((value.admittedSeq===null)===(value.admittedAt===null)&&id(value.sessionId)&&positiveInteger(value.sessionGeneration)&&id(value.taskId)&&positiveInteger(value.taskGeneration),value);
  requireValue(nullable(value.notBeforeAttemptGeneration,positiveInteger)&&nullable(value.eligibleAttemptGeneration,positiveInteger)&&HEX64_RE.test(value.bodySha256)&&nullable(value.preview,function(item){return utf8Text(item,512);}),value);
  requireValue(nullable(value.reasonCode,function(item){return STEERING_REFUSALS.has(item);})&&nullable(value.supersededByCommandId,id)&&nullable(value.attempt,parseSteeringAttempt),value);
  if(value.admittedSeq===null)requireValue(value.status==="refused"&&value.sourceKind===null&&value.preview===null&&value.notBeforeAttemptGeneration===null,value);
  else requireValue(value.sourceKind!==null&&value.preview!==null&&value.notBeforeAttemptGeneration!==null,value);
  if(value.status==="pending"){
    requireValue(value.terminalSeq===null&&value.attempt===null,value);
    if(value.eligibleAttemptGeneration===null)requireValue(/^Pending; no eligible prompt boundary \([a-z-]+\)$/.test(value.statusDetail),value);
    else requireValue(/^Pending; eligible for attempt [1-9][0-9]*$/.test(value.statusDetail),value);
  }
  else requireValue(value.terminalSeq!==null&&value.eligibleAttemptGeneration===null,value);
  if(value.status==="included")requireValue(value.attempt!==null&&value.statusDetail==="Included in attempt "+value.attempt.attemptGeneration+"; prompt sha256:"+value.attempt.promptSha256,value);else requireValue(value.attempt===null,value);
  if(value.status==="refused")requireValue(value.reasonCode!==null&&value.statusDetail==="Refused; reason "+value.reasonCode,value);else requireValue(value.reasonCode===null,value);
  if(value.status==="superseded")requireValue(value.supersededByCommandId!==null&&value.statusDetail==="Superseded by "+value.supersededByCommandId,value);else requireValue(value.supersededByCommandId===null,value);
  if(value.status==="withdrawn")requireValue(value.statusDetail==="Withdrawn while pending",value);
  if(value.status==="expired")requireValue(value.statusDetail==="Expired before inclusion",value);
  return value;
}

function parseSteering(value){
  requireValue(exact(value,["schemaVersion","project","run","runEpoch","observedSeq","headSeq","floorSeq","stale","queue","sessions","commandCount","commandsTruncated","commands"]),value);
  requireValue(value.schemaVersion===V&&id(value.project)&&id(value.run)&&epoch(value.runEpoch)&&safeInteger(value.floorSeq)&&safeInteger(value.observedSeq)&&safeInteger(value.headSeq)&&value.floorSeq<=value.observedSeq&&value.observedSeq<=value.headSeq,value);
  requireValue(typeof value.stale==="boolean"&&value.stale===(value.observedSeq<value.headSeq),value);parseSteeringQueue(value.queue,false);
  requireValue(Array.isArray(value.sessions)&&value.sessions.length<=4096,value);
  const sessionIds=new Set();
  value.sessions.forEach(function(session){parseSteeringSession(session);requireValue(!sessionIds.has(session.sessionId)&&session.observedSeq===value.observedSeq&&session.headSeq===value.headSeq&&(!value.stale||session.stale),session);sessionIds.add(session.sessionId);});
  requireValue(safeInteger(value.commandCount)&&typeof value.commandsTruncated==="boolean"&&Array.isArray(value.commands)&&value.commands.length<=512&&value.commands.length<=value.commandCount,value);
  requireValue(value.commandsTruncated===(value.commands.length<value.commandCount),value);
  const commandIds=new Set();
  value.commands.forEach(function(command){
    parseSteeringCommand(command);requireValue(!commandIds.has(command.commandId),command);commandIds.add(command.commandId);
    if(command.admittedSeq!==null)requireValue(command.admittedSeq<=value.observedSeq,command);
    if(command.terminalSeq!==null)requireValue(command.terminalSeq<=value.observedSeq,command);
    if(command.attempt!==null)requireValue(command.attempt.includedSeq===command.terminalSeq&&command.attempt.promptSha256===command.statusDetail.slice(-64),command);
    if(command.status==="pending")requireValue(value.sessions.some(function(session){return session.sessionId===command.sessionId&&session.sessionGeneration===command.sessionGeneration&&session.taskId===command.taskId&&session.taskGeneration===command.taskGeneration;}),command);
  });
  const visiblePending=value.commands.filter(function(command){return command.status==="pending";}).length;
  requireValue(visiblePending<=value.queue.pendingCount&&(!value.commandsTruncated?visiblePending===value.queue.pendingCount:true),value);
  requireValue(value.sessions.reduce(function(sum,session){return sum+session.queue.pendingCount;},0)===value.queue.pendingCount,value);
  return value;
}

function obsId(value){return typeof value==="string"&&OBS_ID_RE.test(value);}
function obsCode(value){return typeof value==="string"&&CODE_RE.test(value);}
function parseObservationGeneration(value){
  const keys=["runId","runEpoch","agentId","runtimeGeneration","attemptGeneration","sourceGeneration"].concat(value&&value.taskId===undefined?[]:["taskId"]);
  requireValue(exact(value,keys)&&obsId(value.runId)&&epoch(value.runEpoch)&&obsId(value.agentId),value);
  requireValue(value.taskId===undefined||obsId(value.taskId),value);
  requireValue(positiveInteger(value.runtimeGeneration)&&positiveInteger(value.attemptGeneration)&&positiveInteger(value.sourceGeneration),value);return value;
}
function parseObservationLoss(value){
  requireValue(exact(value,["droppedRecords","droppedBytes","reasonCode"])&&safeInteger(value.droppedRecords)&&safeInteger(value.droppedBytes)&&obsCode(value.reasonCode),value);
  requireValue(value.droppedRecords>0||value.droppedBytes>0,value);return value;
}
function parseObservationSummary(value){
  requireValue(exact(value,["text","redacted","truncated","originalBytes","retainedBytes"])&&utf8Text(value.text,1024),value);
  requireValue(typeof value.redacted==="boolean"&&typeof value.truncated==="boolean"&&safeInteger(value.originalBytes)&&safeInteger(value.retainedBytes),value);
  requireValue(new TextEncoder().encode(value.text).byteLength===value.retainedBytes&&value.originalBytes>=value.retainedBytes,value);
  if(value.truncated)requireValue(value.originalBytes>value.retainedBytes,value);return value;
}
function parseObservationDetails(value){
  requireValue(isObject(value)&&typeof value.kind==="string",value);
  if(value.kind==="lifecycle"){requireValue(exact(value,["kind","activity","stateCode"])&&OBS_ACTIVITIES.has(value.activity)&&value.activity!=="unknown"&&obsCode(value.stateCode),value);}
  else if(value.kind==="progress"){
    const keys=["kind","operationCode"].concat(value.completed===undefined?[]:["completed"]).concat(value.total===undefined?[]:["total"]).concat(value.unit===undefined?[]:["unit"]);
    requireValue(exact(value,keys)&&obsCode(value.operationCode)&&(value.completed===undefined)===(value.total===undefined),value);
    if(value.completed!==undefined)requireValue(safeInteger(value.completed)&&safeInteger(value.total)&&value.completed<=value.total&&new Set(["items","bytes","files","checks","steps"]).has(value.unit),value);
  }else if(value.kind==="tool"){
    const keys=["kind","toolClass","state"].concat(value.invocationId===undefined?[]:["invocationId"]);
    requireValue(exact(value,keys)&&new Set(["read","search","edit","process","network","other"]).has(value.toolClass)&&new Set(["started","completed","failed","cancelled"]).has(value.state),value);
    if(value.invocationId!==undefined)requireValue(obsId(value.invocationId),value);
  }else if(value.kind==="usage"){
    requireValue(exact(value,["kind","inputTokens","outputTokens","cachedTokens","turnCount"]),value);["inputTokens","outputTokens","cachedTokens","turnCount"].forEach(function(key){requireValue(safeInteger(value[key]),value);});
  }else if(value.kind==="steering"){
    requireValue(exact(value,["kind","commandState","pendingCount","nextBoundary"])&&new Set(["pending","included","withdrawn","expired","refused","superseded"]).has(value.commandState)&&safeInteger(value.pendingCount)&&new Set(["current_attempt","future_attempt","none"]).has(value.nextBoundary),value);
  }else if(value.kind==="scm"){
    requireValue(exact(value,["kind","factKind","stateCode","evidenceCount"])&&new Set(["publication","pull_request","ci","review","mergeability"]).has(value.factKind)&&obsCode(value.stateCode)&&safeInteger(value.evidenceCount),value);
  }else if(value.kind==="verification"){
    requireValue(exact(value,["kind","gateCode","outcome","completedChecks","totalChecks"])&&obsCode(value.gateCode)&&new Set(["pending","passing","failing","cancelled","unknown"]).has(value.outcome)&&safeInteger(value.completedChecks)&&safeInteger(value.totalChecks)&&value.completedChecks<=value.totalChecks,value);
  }else if(value.kind==="artifact"){
    const keys=["kind","artifactClass","state"].concat(value.digest===undefined?[]:["digest"]).concat(value.bytes===undefined?[]:["bytes"]);
    requireValue(exact(value,keys)&&new Set(["prompt","patch","review","verification","publication"]).has(value.artifactClass)&&new Set(["prepared","verified","published","unavailable","rejected"]).has(value.state),value);
    if(value.digest!==undefined)requireValue(HEX64_RE.test(value.digest),value);if(value.bytes!==undefined)requireValue(safeInteger(value.bytes),value);
  }else if(value.kind==="source"){
    requireValue(exact(value,["kind","state","recordCount","byteCount"])&&new Set(["opened","advanced","quiescent","recovered","replaced","degraded","unavailable"]).has(value.state)&&safeInteger(value.recordCount)&&safeInteger(value.byteCount),value);
  }else if(value.kind==="loss"){
    requireValue(exact(value,["kind","droppedRecords","droppedBytes","reasonCode"]),value);parseObservationLoss({droppedRecords:value.droppedRecords,droppedBytes:value.droppedBytes,reasonCode:value.reasonCode});
  }else protocolFailure();
  return value;
}
function parseObservationRecord(value){
  const keys=["schemaVersion","seq","recordId","generation","observedAt","recordedAt","category","phase","severity","code","details","sourceIntegrity"].concat(value&&value.loss===undefined?[]:["loss"]).concat(value&&value.summary===undefined?[]:["summary"]);
  requireValue(exact(value,keys)&&value.schemaVersion===V&&safeInteger(value.seq)&&obsId(value.recordId),value);parseObservationGeneration(value.generation);
  requireValue(timestamp(value.observedAt)&&timestamp(value.recordedAt)&&Date.parse(value.observedAt)<=Date.parse(value.recordedAt),value);
  requireValue(OBS_CATEGORIES.has(value.category)&&OBS_PHASES.has(value.phase)&&new Set(["info","warning","error"]).has(value.severity)&&obsCode(value.code)&&OBS_INTEGRITIES.has(value.sourceIntegrity),value);
  parseObservationDetails(value.details);if(value.loss!==undefined)parseObservationLoss(value.loss);if(value.summary!==undefined)parseObservationSummary(value.summary);
  requireValue(new TextEncoder().encode(JSON.stringify(value)).byteLength<=8192,value);return value;
}
function parseObservationSource(value){
  const keys=["agentId","runtimeGeneration","attemptGeneration","sourceGeneration","integrity","droppedRecords","droppedBytes"].concat(value&&value.lastObservedAt===undefined?[]:["lastObservedAt"]);
  requireValue(exact(value,keys)&&obsId(value.agentId)&&positiveInteger(value.runtimeGeneration)&&positiveInteger(value.attemptGeneration)&&positiveInteger(value.sourceGeneration)&&OBS_INTEGRITIES.has(value.integrity),value);
  requireValue(value.lastObservedAt===undefined||timestamp(value.lastObservedAt),value);requireValue(safeInteger(value.droppedRecords)&&safeInteger(value.droppedBytes),value);return value;
}
function expectedAttention(activity,taskStatus){
  if(activity==="waiting_input")return"needs_input";if(activity==="dispatching"||activity==="active")return"working";if(activity==="settling")return"settling";if(activity==="blocked")return"blocked";if(activity==="idle")return"idle";
  if(activity==="exited")return taskStatus==="done"?"complete":taskStatus==="blocked"||taskStatus==="escalated"?"failed":"idle";return"unknown";
}
function parseObservationRow(value){
  const keys=["agentId","runtimeGeneration","attemptGeneration","sourceGeneration","activity","attention","taskStatus","steeringState","pendingCommands","scmState","verificationState","sourceIntegrity","sourceStateCode","sourceDroppedRecords","sourceDroppedBytes","lastFactSeq"].concat(value&&value.taskId===undefined?[]:["taskId"]).concat(value&&value.lastObservedAt===undefined?[]:["lastObservedAt"]).concat(value&&value.lastObservation===undefined?[]:["lastObservation"]);
  requireValue(exact(value,keys)&&obsId(value.agentId)&&(value.taskId===undefined||obsId(value.taskId)),value);
  requireValue(positiveInteger(value.runtimeGeneration)&&positiveInteger(value.attemptGeneration)&&positiveInteger(value.sourceGeneration)&&OBS_ACTIVITIES.has(value.activity)&&OBS_ATTENTION.has(value.attention),value);
  requireValue(new Set(["planned","claimed","done","blocked","escalated","unknown"]).has(value.taskStatus)&&value.attention===expectedAttention(value.activity,value.taskStatus),value);
  requireValue(new Set(["none","pending","included","refused","unknown"]).has(value.steeringState)&&safeInteger(value.pendingCommands)&&new Set(["unpublished","publishing","ci_pending","changes_requested","ready","blocked","unknown"]).has(value.scmState),value);
  requireValue(new Set(["not_run","pending","passing","failing","unknown"]).has(value.verificationState)&&OBS_INTEGRITIES.has(value.sourceIntegrity)&&obsCode(value.sourceStateCode),value);
  requireValue(safeInteger(value.sourceDroppedRecords)&&safeInteger(value.sourceDroppedBytes)&&safeInteger(value.lastFactSeq)&&(value.lastObservedAt===undefined||timestamp(value.lastObservedAt)),value);
  if(value.lastObservation!==undefined){parseObservationRecord(value.lastObservation);requireValue(value.lastObservation.generation.agentId===value.agentId&&value.lastObservation.generation.runtimeGeneration===value.runtimeGeneration&&value.lastObservation.generation.attemptGeneration===value.attemptGeneration&&value.lastObservation.generation.sourceGeneration===value.sourceGeneration,value);}
  return value;
}
function parseObservationSnapshot(value){
  requireValue(exact(value,["schemaVersion","runId","runEpoch","eventHeadSeq","rows","observationPage","nextCursor"]),value);
  requireValue(value.schemaVersion===V&&obsId(value.runId)&&epoch(value.runEpoch)&&safeInteger(value.eventHeadSeq)&&Array.isArray(value.rows)&&value.rows.length<=512,value);value.rows.forEach(parseObservationRow);
  const page=value.observationPage;requireValue(exact(page,["schemaVersion","runId","runEpoch","snapshotSeq","projectionSeq","firstAvailableSeq","nextAfter","truncated","droppedRecords","droppedBytes","freshness","records","sources"]),page);
  requireValue(page.schemaVersion===V&&page.runId===value.runId&&page.runEpoch===value.runEpoch&&page.snapshotSeq===value.eventHeadSeq&&safeInteger(page.projectionSeq)&&page.projectionSeq<=page.snapshotSeq,page);
  requireValue(safeInteger(page.firstAvailableSeq)&&page.firstAvailableSeq<=page.snapshotSeq+1&&safeInteger(page.nextAfter)&&typeof page.truncated==="boolean"&&safeInteger(page.droppedRecords)&&safeInteger(page.droppedBytes),page);
  requireValue(new Set(["fresh","stale","rebuilding","unavailable"]).has(page.freshness)&&(page.freshness!=="fresh"||page.projectionSeq===page.snapshotSeq),page);
  requireValue(Array.isArray(page.records)&&page.records.length<=500&&Array.isArray(page.sources)&&page.sources.length<=256,page);let prior=page.firstAvailableSeq-1;
  page.records.forEach(function(record){parseObservationRecord(record);requireValue(record.generation.runId===value.runId&&record.generation.runEpoch===value.runEpoch&&record.seq>prior&&record.seq<=page.snapshotSeq,record);prior=record.seq;});page.sources.forEach(parseObservationSource);
  requireValue((page.records.length===0&&page.nextAfter>=Math.max(0,page.firstAvailableSeq-1)&&page.nextAfter<=page.snapshotSeq)||(page.records.length>0&&page.nextAfter===page.records[page.records.length-1].seq),page);
  requireValue(typeof value.nextCursor==="string"&&value.nextCursor.length<=512&&/^v1\.[A-Za-z0-9_-]+$/.test(value.nextCursor),value);return value;
}

function parseNotification(value,lastEventId,identity){
  requireValue(exact(value,["v","type","project","run","taskId","runEpoch","seq","headSeq","viewSeq"]),value);
  requireValue(value.v===V&&value.type==="control.changed"&&id(value.project)&&id(value.run)&&nullable(value.taskId,id)&&epoch(value.runEpoch),value);
  requireValue(safeInteger(value.seq)&&safeInteger(value.headSeq)&&safeInteger(value.viewSeq)&&value.seq<=value.headSeq&&value.viewSeq<=value.headSeq,value);
  requireValue(typeof lastEventId==="string"&&/^(?:0|[1-9][0-9]*)$/.test(lastEventId)&&Number(lastEventId)===value.seq,value);
  requireValue(value.project===identity.project&&value.run===identity.run&&value.runEpoch===identity.runEpoch&&value.seq>identity.lastApplied,value);
  return value;
}

function parseControlFrame(value,expectedType){
  requireValue(isObject(value)&&value.v===V&&value.type===expectedType,value);
  if(expectedType==="control.ready"){
    requireValue(exact(value,["v","type","runEpoch","floorSeq","headSeq","viewSeq"])&&epoch(value.runEpoch)&&freshness(value),value);
  }else if(expectedType==="control.resync-required"){
    requireValue(exact(value,["v","type","reason","runEpoch","floorSeq","headSeq","snapshotSeq"]),value);
    requireValue(RESYNC_REASONS.has(value.reason)&&epoch(value.runEpoch)&&safeInteger(value.floorSeq)&&safeInteger(value.headSeq)&&safeInteger(value.snapshotSeq),value);
  }else if(expectedType==="control.slow-client"){
    requireValue(exact(value,["v","type","reason"])&&value.reason==="backpressure",value);
  }else if(expectedType==="control.closing"){
    requireValue(exact(value,["v","type","reason"])&&value.reason==="shutdown",value);
  }else protocolFailure();
  return value;
}

function parseFrameJson(raw,parser){
  requireValue(typeof raw==="string"&&new TextEncoder().encode(raw).byteLength<=FRAME_LIMIT,raw);
  let value;try{value=JSON.parse(raw);}catch{protocolFailure();}
  return parser(value);
}

function parseError(value){
  requireValue(exact(value,["error"])&&exact(value.error,["code","message","requestId"].concat(value.error.details===undefined?[]:["details"])),value);
  requireValue(new Set(["INVALID_REQUEST","INVALID_CURSOR","CURSOR_EXPIRED","NOT_FOUND","METHOD_NOT_ALLOWED","NOT_READY","IDENTITY_MISMATCH","RESPONSE_TOO_LARGE","RECOVERY_REQUIRED","CAPACITY_EXCEEDED","INTERNAL_ERROR"]).has(value.error.code)&&text(value.error.message,2048)&&typeof value.error.requestId==="string"&&/^[A-Za-z0-9._-]{1,128}$/.test(value.error.requestId),value);
  if(value.error.details!==undefined){
    requireValue(isObject(value.error.details)&&Object.keys(value.error.details).every(function(key){return ["floorSeq","headSeq","snapshotSeq","retryAfterMs","reason"].includes(key);}),value);
    ["floorSeq","headSeq","snapshotSeq","retryAfterMs"].forEach(function(key){if(value.error.details[key]!==undefined)requireValue(safeInteger(value.error.details[key]),value);});
    if(value.error.details.reason!==undefined)requireValue(typeof value.error.details.reason==="string"&&/^[a-z][a-z0-9._-]{0,63}$/.test(value.error.details.reason),value);
  }
  return value.error.code;
}

function createClient(runtime){
  const project=String(document.body&&document.body.dataset?document.body.dataset.project||"":"");
  let stopped=false;
  let connectionState="connecting";
  let baseOrigin=readOrigin();
  let instanceId=null;
  let selectedRun=null;
  let runEpoch=null;
  let lastApplied=null;
  let currentSnapshot=null;
  let eventSource=null;
  let sourceGeneration=0;
  let retryTimer=null;
  let retryAttempt=0;
  let failedOpenings=0;
  let debounceTimer=null;
  let pollTimer=null;
  let polling=false;
  let refreshInFlight=null;
  let refreshTrailing=false;
  let activeControllers=new Set();
  let scheduledRetryDelays=[];
  let lastErrorKind=null;

  function readOrigin(){
    const value=String(runtime.location.origin||"");
    const match=/^http:\/\/127\.0\.0\.1(?::([1-9][0-9]{0,4}))?$/.exec(value);
    requireValue(Boolean(match)&&(!match[1]||Number(match[1])<=65535),value);
    return value;
  }
  function endpoint(path){return new URL(path,baseOrigin+"/").toString();}
  function setConnection(state,label){
    connectionState=state;
    const container=document.getElementById("connection"),textNode=document.getElementById("livetext");
    if(container){container.dataset.state=state;if(typeof container.setAttribute==="function")container.setAttribute("aria-label",label);}
    if(textNode)textNode.textContent=label;
  }
  function classifyError(error){return error&&error.kind==="protocol"?"protocol":"transport";}
  function showError(){
    const el=document.getElementById("attention-strip");
    if(el)el.innerHTML='<div class="att warn"><div class="att-top"><span>Control data is unavailable or invalid. Retrying…</span></div></div>';
  }

  async function fetchDto(path,limit,parser,signal,origin){
    const response=await runtime.fetch(new URL(path,origin+"/").toString(),{method:"GET",headers:{accept:"application/json"},cache:"no-store",redirect:"error",signal:signal});
    const bodyLimit=response.status===200?limit:4096;
    const length=response.headers&&response.headers.get?response.headers.get("content-length"):null;
    if(length!==null){requireValue(/^(?:0|[1-9][0-9]*)$/.test(length)&&Number(length)<=bodyLimit,length);}
    const contentType=response.headers&&response.headers.get?response.headers.get("content-type"):null;
    requireValue(typeof contentType==="string"&&/^application\/json(?:\s*;|$)/i.test(contentType),contentType);
    const raw=await response.text();
    requireValue(new TextEncoder().encode(raw).byteLength<=bodyLimit,raw);
    let value;try{value=JSON.parse(raw);}catch{protocolFailure();}
    if(response.status!==200){parseError(value);const error=new Error("The control service rejected the request.");error.kind="transport";throw error;}
    return parser(value);
  }

  async function loadSnapshot(){
    const origin=readOrigin();
    const controller=new AbortController();
    activeControllers.add(controller);
    const timeout=runtime.setTimeout(function(){controller.abort();},FETCH_TIMEOUT_MS);
    try{
      const status=parseStatus(await fetchDto("/api/v1/status",JSON_LIMIT.status,parseStatus,controller.signal,origin));
      const selected=status.projects.find(function(item){return item.project===project;});
      requireValue(Boolean(selected),status);
      if(selected.latestRun===null)return {origin:origin,status:status,projectStatus:selected,board:null,activity:null,steering:null,observations:null};
      const run=selected.latestRun.run;
      const query="?project="+encodeURIComponent(project);
      const board=await fetchDto("/api/v1/runs/"+encodeURIComponent(run)+"/board"+query,JSON_LIMIT.board,parseBoard,controller.signal,origin);
      requireValue(board.project===project&&board.run===run&&board.runEpoch===selected.latestRun.runEpoch,board);
      const after=Math.max(board.floorSeq-1,board.headSeq-500,0);
      const activity=await fetchDto("/api/v1/runs/"+encodeURIComponent(run)+"/activity"+query+"&after="+after+"&limit=500",JSON_LIMIT.activity,parseActivity,controller.signal,origin);
      requireValue(activity.project===project&&activity.run===run&&activity.runEpoch===board.runEpoch,activity);
      const steering=await fetchDto("/api/v1/runs/"+encodeURIComponent(run)+"/steering"+query,JSON_LIMIT.steering,parseSteering,controller.signal,origin);
      requireValue(steering.project===project&&steering.run===run&&steering.runEpoch===board.runEpoch,steering);
      let observations=null;
      if(document.getElementById("observations")){
        observations=await fetchDto("/api/v1/runs/"+encodeURIComponent(run)+"/observations"+query+"&limit=100",JSON_LIMIT.observations,parseObservationSnapshot,controller.signal,origin);
        requireValue(observations.runId===run&&observations.runEpoch===board.runEpoch&&observations.eventHeadSeq>=board.headSeq,observations);
      }
      return {origin:origin,status:status,projectStatus:selected,board:board,activity:activity,steering:steering,observations:observations};
    }finally{
      runtime.clearTimeout(timeout);activeControllers.delete(controller);
    }
  }

  function adoptSnapshot(snapshot){
    if(stopped)throw new Error("Dashboard stopped.");
    const hadSnapshot=currentSnapshot!==null;
    const nextRun=snapshot.board?snapshot.board.run:null;
    const nextEpoch=snapshot.board?snapshot.board.runEpoch:null;
    const baseChanged=hadSnapshot&&snapshot.origin!==baseOrigin;
    const instanceChanged=hadSnapshot&&snapshot.status.instanceId!==instanceId;
    const selectionChanged=hadSnapshot&&(nextRun!==selectedRun||nextEpoch!==runEpoch);
    if(hadSnapshot&&!selectionChanged&&snapshot.board&&lastApplied!==null)requireValue(snapshot.board.headSeq>=lastApplied,snapshot.board);
    baseOrigin=snapshot.origin;instanceId=snapshot.status.instanceId;selectedRun=nextRun;runEpoch=nextEpoch;
    lastApplied=snapshot.board?snapshot.board.headSeq:null;currentSnapshot=snapshot;
    renderSnapshot(snapshot);
    return {baseChanged:baseChanged,instanceChanged:instanceChanged,selectionChanged:selectionChanged};
  }

  function requestRefresh(){
    if(refreshInFlight){refreshTrailing=true;return refreshInFlight;}
    const promise=loadSnapshot().then(adoptSnapshot);
    refreshInFlight=promise;
    promise.catch(function(){}).finally(function(){
      if(refreshInFlight===promise)refreshInFlight=null;
      if(refreshTrailing&&!stopped){refreshTrailing=false;scheduleInvalidation();}
    });
    return promise;
  }
  function requestOpenRefresh(){
    const prior=refreshInFlight;
    if(!prior)return requestRefresh();
    return Promise.resolve(prior).catch(function(){}).then(function(){if(stopped)throw new Error("Dashboard stopped.");return requestRefresh();});
  }

  function clearTimer(name){
    if(name==="retry"&&retryTimer!==null){runtime.clearTimeout(retryTimer);retryTimer=null;}
    if(name==="debounce"&&debounceTimer!==null){runtime.clearTimeout(debounceTimer);debounceTimer=null;}
    if(name==="poll"&&pollTimer!==null){runtime.clearTimeout(pollTimer);pollTimer=null;}
  }
  function closeSource(){
    sourceGeneration+=1;
    const prior=eventSource;eventSource=null;
    if(prior&&typeof prior.close==="function")prior.close();
  }
  function abortRequests(){activeControllers.forEach(function(controller){controller.abort();});activeControllers.clear();}
  function disablePolling(){polling=false;clearTimer("poll");}
  function enablePolling(){if(polling||stopped)return;polling=true;schedulePoll();}
  function schedulePoll(){
    if(!polling||stopped||pollTimer!==null)return;
    pollTimer=runtime.setTimeout(function(){
      pollTimer=null;if(!polling||stopped)return;
      requestRefresh().then(function(changes){
        if(stopped)return;
        if(changes.baseChanged||changes.instanceChanged){restartAfterIdentityChange();return;}
        if(changes.selectionChanged){closeSource();clearTimer("retry");retryAttempt=0;if(selectedRun)openSource();return;}
        if(selectedRun&&!eventSource&&retryTimer===null)openSource();
      }).catch(function(error){lastErrorKind=classifyError(error);showError();}).finally(schedulePoll);
    },POLL_MS);
  }
  function recordFailure(){failedOpenings+=1;if(failedOpenings>=FAILURE_FALLBACK_THRESHOLD){enablePolling();setConnection("degraded","degraded · polling");}}
  function retryDelay(){
    const base=Math.min(5000,250*Math.pow(2,Math.min(retryAttempt,8)));
    retryAttempt+=1;
    const random=Math.max(0,Math.min(1,Number(runtime.random())||0));
    return Math.min(5000,base+Math.floor(base*0.2*random));
  }
  function scheduleRetry(state){
    if(stopped||retryTimer!==null)return;
    const delay=retryDelay();scheduledRetryDelays.push(delay);
    retryTimer=runtime.setTimeout(function(){
      retryTimer=null;if(stopped)return;
      if(!polling)setConnection("reconnecting","reconnecting…");
      if(currentSnapshot===null||selectedRun===null)bootstrap();else openSource();
    },delay);
    if(!polling)setConnection(state,state==="error"?"stream error · retrying":"reconnecting…");
  }
  function terminalFailure(kind){
    if(stopped)return;
    lastErrorKind=kind;closeSource();recordFailure();showError();scheduleRetry(kind==="protocol"?"error":"reconnecting");
  }
  function restartAfterIdentityChange(){
    closeSource();clearTimer("retry");retryAttempt=0;recordFailure();scheduleRetry("reconnecting");
  }

  function scheduleInvalidation(){
    if(stopped||debounceTimer!==null)return;
    if(refreshInFlight){refreshTrailing=true;return;}
    setConnection("stale","stale · refreshing");
    debounceTimer=runtime.setTimeout(function(){
      debounceTimer=null;if(stopped)return;
      requestRefresh().then(function(changes){
        if(changes.baseChanged||changes.instanceChanged){restartAfterIdentityChange();return;}
        if(changes.selectionChanged){closeSource();clearTimer("retry");retryAttempt=0;if(selectedRun)openSource();else startWaitingPoll();return;}
        if(selectedRun===null){startWaitingPoll();return;}
        if(!eventSource&&retryTimer===null){openSource();return;}
        if(eventSource&&eventSource.readyState===1&&!polling)setConnection("connected","connected");
      }).catch(function(error){terminalFailure(classifyError(error));});
    },REFRESH_DEBOUNCE_MS);
  }

  function eventData(event,parser){return parseFrameJson(event&&event.data,parser);}
  function attachSourceHandlers(source,generation){
    source.onopen=function(){
      if(stopped||eventSource!==source||generation!==sourceGeneration)return;
      setConnection("reconnecting","synchronizing…");
      requestOpenRefresh().then(function(changes){
        if(stopped||eventSource!==source||generation!==sourceGeneration)return;
        if(changes.baseChanged||changes.instanceChanged){restartAfterIdentityChange();return;}
        if(changes.selectionChanged){closeSource();retryAttempt=0;if(selectedRun)openSource();else startWaitingPoll();return;}
        failedOpenings=0;retryAttempt=0;lastErrorKind=null;disablePolling();setConnection("connected","connected");
      }).catch(function(error){if(eventSource===source)terminalFailure(classifyError(error));});
    };
    source.onerror=function(){
      if(stopped||eventSource!==source||generation!==sourceGeneration)return;
      recordFailure();
      if(source.readyState===0){if(!polling)setConnection("reconnecting","reconnecting…");return;}
      closeSource();scheduleRetry("reconnecting");
    };
    source.onmessage=function(){if(!stopped&&eventSource===source)terminalFailure("protocol");};
    source.addEventListener("control.changed",function(event){
      if(stopped||eventSource!==source||generation!==sourceGeneration)return;
      try{
        const notification=eventData(event,function(value){return parseNotification(value,event.lastEventId,{project:project,run:selectedRun,runEpoch:runEpoch,lastApplied:lastApplied});});
        lastApplied=notification.seq;scheduleInvalidation();
      }catch{terminalFailure("protocol");}
    });
    source.addEventListener("control.ready",function(event){
      if(stopped||eventSource!==source||generation!==sourceGeneration)return;
      try{
        const frame=eventData(event,function(value){return parseControlFrame(value,"control.ready");});
        requireValue(frame.runEpoch===runEpoch&&lastApplied!==null&&frame.headSeq>=lastApplied,frame);
      }catch{terminalFailure("protocol");}
    });
    source.addEventListener("control.resync-required",function(event){
      if(stopped||eventSource!==source||generation!==sourceGeneration)return;
      try{eventData(event,function(value){return parseControlFrame(value,"control.resync-required");});performResync();}catch{terminalFailure("protocol");}
    });
    source.addEventListener("control.slow-client",function(event){
      if(stopped||eventSource!==source||generation!==sourceGeneration)return;
      try{eventData(event,function(value){return parseControlFrame(value,"control.slow-client");});closeSource();recordFailure();scheduleRetry("reconnecting");}catch{terminalFailure("protocol");}
    });
    source.addEventListener("control.closing",function(event){
      if(stopped||eventSource!==source||generation!==sourceGeneration)return;
      try{eventData(event,function(value){return parseControlFrame(value,"control.closing");});closeSource();recordFailure();scheduleRetry("reconnecting");}catch{terminalFailure("protocol");}
    });
  }

  function openSource(){
    if(stopped||eventSource||selectedRun===null||runEpoch===null||lastApplied===null)return;
    clearTimer("retry");
    const url=endpoint("/api/v1/runs/"+encodeURIComponent(selectedRun)+"/events?project="+encodeURIComponent(project)+"&runEpoch="+encodeURIComponent(runEpoch)+"&after="+lastApplied);
    try{
      const source=new runtime.EventSource(url);eventSource=source;sourceGeneration+=1;
      const generation=sourceGeneration;attachSourceHandlers(source,generation);
      if(connectionState!=="degraded")setConnection("connecting","connecting…");
    }catch{recordFailure();scheduleRetry("error");}
  }

  function performResync(){
    const pending=refreshInFlight;
    closeSource();clearTimer("retry");clearTimer("debounce");abortRequests();
    runEpoch=null;lastApplied=null;currentSnapshot=null;retryAttempt=0;
    setConnection("stale","stale · resynchronizing");
    Promise.resolve(pending).catch(function(){}).then(function(){
      if(stopped)return;refreshTrailing=false;return requestRefresh();
    }).then(function(){if(stopped)return;if(selectedRun)openSource();else startWaitingPoll();}).catch(function(error){if(!stopped)terminalFailure(classifyError(error));});
  }
  function startWaitingPoll(){setConnection("connected","connected · waiting for run");enablePolling();}
  function bootstrap(){
    if(stopped)return;
    setConnection(failedOpenings?"reconnecting":"connecting",failedOpenings?"reconnecting…":"connecting…");
    requestRefresh().then(function(){if(stopped)return;if(selectedRun)openSource();else startWaitingPoll();}).catch(function(error){lastErrorKind=classifyError(error);recordFailure();showError();scheduleRetry(lastErrorKind==="protocol"?"error":"reconnecting");});
  }
  function stop(){
    if(stopped)return;stopped=true;closeSource();clearTimer("retry");clearTimer("debounce");disablePolling();abortRequests();refreshTrailing=false;
  }
  function manualRefresh(){
    if(stopped)return;
    scheduleInvalidation();
  }
  function debug(){
    return {state:connectionState,baseOrigin:baseOrigin,instanceId:instanceId,selectedRun:selectedRun,runEpoch:runEpoch,lastApplied:lastApplied,failedOpenings:failedOpenings,retryAttempt:retryAttempt,hasSource:eventSource!==null,retryTimerActive:retryTimer!==null,debounceTimerActive:debounceTimer!==null,pollTimerActive:pollTimer!==null,polling:polling,activeRequests:activeControllers.size,stopped:stopped,lastErrorKind:lastErrorKind,scheduledRetryDelays:scheduledRetryDelays.slice()};
  }

  return {start:bootstrap,stop:stop,refresh:manualRefresh,debug:debug};
}

function kpi(key,label,value,sub,bar){
  const flash=previousKpis[key]!==undefined&&previousKpis[key]!==value?" flash":"";previousKpis[key]=value;
  const meter=bar?'<div class="bar '+(bar.cls||'')+'"><span style="width:'+bar.pct+'%"></span></div>':'';
  return '<div class="kpi'+flash+'"><div class="label">'+esc(label)+'</div><div class="value">'+esc(value)+(sub?' <small>'+esc(sub)+'</small>':'')+'</div>'+meter+'</div>';
}
function renderSnapshot(snapshot){
  if(!snapshot.board){renderEmptyRun(snapshot.projectStatus.sessions);return;}
  const runSessions=snapshot.projectStatus.sessions.filter(function(session){return session.run===snapshot.board.run;});
  renderKpis(snapshot.board,snapshot.projectStatus,runSessions);
  renderAttention(snapshot.board);
  renderAgents(runSessions,snapshot.board.tasks,snapshot.steering.sessions);
  renderKanban(snapshot.board);
  renderTimeline(snapshot.activity.activity);
  renderSteering(snapshot.steering);
  renderObservations(snapshot.observations);
}
function renderEmptyRun(sessions){
  document.getElementById("kpis").innerHTML=kpi("progress","Progress","0%","no run yet");
  document.getElementById("attention-strip").innerHTML="";
  renderAgents(sessions,[],[]);
  renderKanban({tasks:[]});renderTimeline([]);renderSteering(null);renderObservations(null);
}
function renderKpis(board,projectStatus,sessions){
  const counts=board.counts,total=counts.total,progress=total?Math.round(counts.done*100/total):0;
  const activeSessions=sessions.filter(function(session){return session.state==="running";}).length;
  const retries=board.tasks.reduce(function(sum,task){return sum+task.attempts;},0);
  document.getElementById("kpis").innerHTML=
    kpi("progress","Progress",progress+"%",counts.done+"/"+total+" done",{pct:progress})+
    kpi("agents","Agents active",activeSessions,String(sessions.length)+" sessions")+
    kpi("active","Active",counts.active,String(counts.needsReview)+" in review")+
    kpi("blocked","Blocked",counts.blocked,String(counts.escalated)+" escalated")+
    kpi("retries","Attempts",retries,String(counts.rejected)+" rejected")+
    kpi("cursor","View cursor",board.viewSeq,"head "+board.headSeq)+
    kpi("run","Run",projectStatus.latestRun.status,board.stale?"projection stale":"projection current");
}
function renderAttention(board){
  const warnings=board.stale?["The durable projection is stale; the control service is catching up."]:[];
  const tasks=board.tasks.filter(function(task){return task.status==="blocked"||task.status==="rejected"||task.status==="escalated";});
  const el=document.getElementById("attention-strip");
  if(!warnings.length&&!tasks.length){el.innerHTML="";return;}
  el.innerHTML=warnings.map(function(warning){return '<div class="att warn"><div class="att-top"><span>⚠ '+esc(warning)+'</span></div></div>';}).join("")+
    tasks.map(function(task){return '<div class="att '+esc(task.status)+'"><div class="att-top"><span><code>'+esc(task.id)+'</code> '+esc(task.title)+'</span><span class="s-'+esc(task.status)+'">'+esc(task.status)+'</span></div>'+(task.summary?'<div class="why">'+esc(task.summary).slice(0,130)+'</div>':'')+(task.attempts?'<div class="why">↻ '+task.attempts+' attempt(s)</div>':'')+'</div>';}).join("");
}
function renderAgents(sessions,tasks,steeringSessions){
  const el=document.getElementById("agents");
  document.getElementById("agents-count").textContent=sessions.filter(function(session){return session.state==="running";}).length+" active";
  if(!sessions.length){el.innerHTML='<div class="empty">No owned sessions for this run.</div>';return;}
  el.innerHTML=sessions.map(function(session){
    const task=tasks.find(function(item){return item.id===session.taskId;})||tasks.find(function(item){return (item.claimedBy||item.assignee)===session.role&&(item.status==="claimed"||item.status==="in-progress"||item.status==="needs-review"||item.status==="blocked");});
    const exact=steeringSessions.find(function(item){return item.sessionId===session.name;});
    const taskMatches=exact?[]:steeringSessions.filter(function(item){return item.taskId!==null&&item.taskId===session.taskId;});
    const steering=exact||(taskMatches.length===1?taskMatches[0]:null);
    const state=steering?steering.activity:(session.state==="running"?(task&&task.status==="needs-review"?"review-pending":task&&task.status==="blocked"?"blocked":"working"):"idle");
    const stateLabel=steering?steering.activityLabel:session.state;
    const generation=steering?'<span>session gen '+steering.sessionGeneration+(steering.taskGeneration!==null?' · task gen '+steering.taskGeneration:'')+'</span>':'';
    return '<div class="agent '+state+'"><div class="top"><span class="name">'+esc(session.role)+'</span><span class="statepill '+state+'">'+esc(stateLabel)+'</span></div><div class="role-meta">'+esc(session.name)+'</div>'+(task?'<div class="task"><code>'+esc(task.id)+'</code> '+esc(task.title)+'</div>':'<div class="muted">idle — no active task</div>')+(steering?'<div class="muted">'+esc(steering.reason)+'</div>':task&&task.summary?'<div class="muted">'+esc(task.summary).slice(0,100)+'</div>':'')+'<div class="stat-row">'+generation+(task?'<span>↻ '+task.attempts+'</span>':'')+(session.lastActivity?'<span>'+esc(clock(session.lastActivity))+'</span>':'')+'</div></div>';
  }).join("");
}
function renderKanban(board){
  const tasks=board.tasks||[],el=document.getElementById("kanban");
  document.getElementById("board-count").textContent=tasks.length+" tasks";
  if(!tasks.length){el.innerHTML='<div class="empty">No tasks yet — the orchestrator is decomposing the goal…</div>';return;}
  const doneIds=new Set(tasks.filter(function(task){return task.status==="done";}).map(function(task){return task.id;}));
  const byStatus={};LANES.forEach(function(state){byStatus[state]=[];});tasks.forEach(function(task){byStatus[task.status].push(task);});
  el.innerHTML=LANES.filter(function(state){return byStatus[state].length;}).map(function(state){
    const tickets=byStatus[state].slice().sort(function(a,b){return b.priority-a.priority||a.id.localeCompare(b.id);}).map(function(task){
      const dependencies=task.dependsOn.map(function(dependency){return '<span class="chip '+(doneIds.has(dependency)?'ok':'block')+'">'+esc(dependency)+'</span>';}).join("");
      const ready=state==="open"&&task.dependsOn.length>0&&task.dependsOn.every(function(dependency){return doneIds.has(dependency);})?'<span class="badge-ready">ready ▶</span>':'';
      return '<div class="ticket bt-'+state+'"><div class="tid"><span>'+esc(task.id)+'</span></div><div class="ttitle">'+esc(task.title)+'</div><div class="tmeta"><span>'+esc(task.claimedBy||task.assignee)+'</span><span class="s-'+state+'">'+LANE_LABEL[state]+'</span></div>'+(dependencies?'<div>'+dependencies+' '+ready+'</div>':ready?'<div>'+ready+'</div>':'')+'</div>';
    }).join("");
    return '<div class="lane"><h3><span>'+LANE_LABEL[state]+'</span><span>'+byStatus[state].length+'</span></h3>'+tickets+'</div>';
  }).join("");
}
function renderTimeline(activity){
  const el=document.getElementById("timeline");
  if(!activity.length){el.innerHTML='<div class="empty">No activity yet.</div>';return;}
  el.innerHTML=activity.slice().reverse().map(function(entry){
    const actor=entry.actor||"system",summary=entry.summary||entry.kind;
    return '<div class="tl"><span class="when">'+esc(clock(entry.occurredAt))+'</span><span class="who '+(entry.status?"s-"+entry.status:"")+'">'+esc(actor)+'</span><span class="what">'+esc(summary).slice(0,150)+'</span></div>';
  }).join("");
}
function renderSteering(view){
  const el=document.getElementById("steering"),count=document.getElementById("steering-count");
  if(!view){count.textContent="0 pending";el.innerHTML='<div class="empty">No run-scoped steering facts.</div>';return;}
  count.textContent=view.queue.pendingCount+" pending";
  const freshness=view.stale?"projection stale at "+view.observedSeq+" / "+view.headSeq:"projection current at "+view.headSeq;
  const oldest=view.queue.oldestPendingAgeMs===null?"no queued command":"oldest pending "+formatAge(view.queue.oldestPendingAgeMs);
  const truncated=view.commandsTruncated?" · showing "+view.commands.length+" of "+view.commandCount:"";
  const sessions=view.sessions.map(function(session){
    const queue=session.queue.pendingCount?" · "+session.queue.pendingCount+" pending · next attempt "+session.queue.nextEligibleAttemptGeneration:"";
    return '<span class="steering-session"><strong>'+esc(session.sessionId)+'</strong> · gen '+session.sessionGeneration+' · '+esc(session.activityLabel)+queue+'</span>';
  }).join("");
  const commands=view.commands.map(function(command){
    const target='<div class="target">'+esc(command.sessionId)+' gen '+command.sessionGeneration+' · '+esc(command.taskId)+' gen '+command.taskGeneration+'</div>';
    const source=command.sourceKind===null?'':'<div class="source">'+esc(command.sourceKind)+' · admitted seq '+command.admittedSeq+'</div>';
    const preview=command.preview===null?'':'<div class="preview">'+esc(command.preview)+'</div>';
    return '<div class="steer '+esc(command.status)+'"><div class="top"><span class="sid">'+esc(command.commandId)+'</span><span class="status">'+esc(command.statusLabel)+'</span></div><div class="detail">'+esc(command.statusDetail)+'</div>'+target+source+preview+'</div>';
  }).join("");
  el.innerHTML='<div class="steering-summary"><span>'+esc(freshness)+'</span><span>'+esc(oldest)+truncated+'</span></div>'+(sessions?'<div class="steering-sessions">'+sessions+'</div>':'')+(commands?'<div class="steering-list">'+commands+'</div>':'<div class="empty">No steering commands recorded.</div>');
}
function renderObservations(snapshot){
  const el=document.getElementById("observations"),count=document.getElementById("observations-count");if(!el||!count)return;
  if(!snapshot){count.textContent="unavailable";el.innerHTML='<div class="empty">No normalized observation snapshot is available.</div>';return;}
  const page=snapshot.observationPage;count.textContent=page.records.length+" facts · "+page.freshness;
  const notices=[];
  if(page.freshness!=="fresh")notices.push('<span class="observation-notice warn">Projection '+esc(page.freshness)+' at #'+page.projectionSeq+' / #'+page.snapshotSeq+'</span>');
  if(page.truncated)notices.push('<span class="observation-notice warn">History is truncated</span>');
  if(page.droppedRecords||page.droppedBytes)notices.push('<span class="observation-notice warn">'+page.droppedRecords+' records / '+page.droppedBytes+' bytes dropped</span>');
  if(!page.records.length)notices.push('<span class="observation-notice">No normalized observations in this page</span>');
  const agents=snapshot.rows.map(function(row){
    return '<span class="observation-agent"><strong>'+esc(row.agentId)+'</strong> · '+esc(row.activity)+' · '+esc(row.sourceIntegrity)+' · runtime '+row.runtimeGeneration+' / attempt '+row.attemptGeneration+' / source '+row.sourceGeneration+'</span>';
  }).join("");
  const records=page.records.slice().reverse().map(function(record){
    const summary=record.summary?record.summary.text:(record.category+" update: "+record.code.replace(/[._-]+/g," "));
    return '<li class="observation-item"><time>'+esc(clock(record.observedAt))+'</time><strong>'+esc(record.generation.agentId)+'</strong><code>'+esc(record.category)+' · '+esc(record.code)+'</code><span class="observation-summary">'+esc(summary)+' · source '+esc(record.sourceIntegrity)+' · fact #'+record.seq+'</span></li>';
  }).join("");
  el.innerHTML='<div class="observation-notices">'+notices.join("")+'</div>'+(agents?'<div class="observation-agents">'+agents+'</div>':'')+(records?'<ol class="observation-list">'+records+'</ol>':'');
}
function formatAge(ms){if(ms<60000)return Math.floor(ms/1000)+"s";if(ms<3600000)return Math.floor(ms/60000)+"m";if(ms<86400000)return Math.floor(ms/3600000)+"h";return Math.floor(ms/86400000)+"d";}

const runtime={
  fetch:function(url,options){return globalThis.fetch(url,options);},
  EventSource:globalThis.EventSource,
  setTimeout:function(callback,delay){return globalThis.setTimeout(callback,delay);},
  clearTimeout:function(handle){globalThis.clearTimeout(handle);},
  random:function(){return Math.random();},
  location:globalThis.location
};
const controller=createClient(runtime);
const button=document.getElementById("refresh-button");if(button)button.addEventListener("click",controller.refresh);
if(typeof globalThis.addEventListener==="function"){
  globalThis.addEventListener("beforeunload",controller.stop,{once:true});
  globalThis.addEventListener("pagehide",controller.stop,{once:true});
}
if(typeof globalThis.__RELAYFORGE_DASHBOARD_TEST_HOOK__==="function")globalThis.__RELAYFORGE_DASHBOARD_TEST_HOOK__(controller);
controller.start();
})();
`;

const CLIENT_JS = DASHBOARD_CLIENT_JS;

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
