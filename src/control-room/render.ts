import type { ControlRoomViewModelV1 } from "./view-model.js";

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

/** Render a self-contained semantic fragment. Callers own the document/CSP shell. */
export function renderControlRoomHtml(model: ControlRoomViewModelV1): string {
  const notices = model.notices.map((item) =>
    `<li class="notice notice-${item.severity}" data-code="${item.code}">${escapeHtml(item.text)}</li>`).join("");
  const buckets = model.buckets.map((bucket) => {
    const rows = bucket.rows.map((row) => `<article class="agent-row" data-key="${escapeHtml(row.key)}">
<h3>${escapeHtml(row.agentId)}</h3><p>${escapeHtml(row.taskLabel)}</p>
<dl><dt>Activity</dt><dd>${escapeHtml(row.activityLabel)}</dd><dt>Generation</dt><dd>${escapeHtml(row.generationLabel)}</dd><dt>Source</dt><dd>${escapeHtml(row.sourceLabel)}</dd><dt>Steering</dt><dd>${escapeHtml(row.steeringLabel)}</dd><dt>SCM</dt><dd>${escapeHtml(row.scmLabel)}</dd><dt>Verification</dt><dd>${escapeHtml(row.verificationLabel)}</dd></dl>
<p>${escapeHtml(row.lastFactLabel)}</p>${row.latestSummary === undefined ? "" : `<p class="summary">${escapeHtml(row.latestSummary)}</p>`}</article>`).join("");
    return `<section class="attention-bucket" data-attention="${bucket.id}" aria-labelledby="bucket-${bucket.id}"><h2 id="bucket-${bucket.id}">${escapeHtml(bucket.label)} <span aria-label="${bucket.count} agents">${bucket.count}</span></h2>${rows || "<p>No agents</p>"}</section>`;
  }).join("");
  const timeline = model.timeline.map((item) => `<li data-key="${escapeHtml(item.key)}"><time>${escapeHtml(item.timeLabel)}</time> <strong>${escapeHtml(item.agentId)}</strong> <span>${escapeHtml(item.categoryLabel)}</span><p>${escapeHtml(item.text)}</p><small>${escapeHtml(item.integrityLabel)} · fact #${item.seq}</small></li>`).join("");
  return `<main class="relayforge-control-room" data-mode="${model.mode}" data-degraded="${String(model.degraded)}">
<header><h1>${escapeHtml(model.title)}</h1><p role="status">${escapeHtml(model.connectionLabel)} · ${escapeHtml(model.headLabel)}</p></header>
<section aria-label="Control-room notices"><ul>${notices || "<li>No active notices.</li>"}</ul></section>
<section aria-label="Agent attention">${buckets}</section>
<section aria-labelledby="timeline-title"><h2 id="timeline-title">Normalized activity</h2><ol>${timeline || "<li>No normalized observations.</li>"}</ol></section>
</main>`;
}
