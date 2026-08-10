import type { ControlRoomViewModelV1 } from "./view-model.js";

export const CONTROL_ROOM_TERMINAL_LIMITS = Object.freeze({ minimumWidth: 32, maximumWidth: 240, minimumHeight: 6, maximumHeight: 200 });

function scalarWidth(value: string): number {
  let width = 0;
  for (const scalar of value) width += /[\u1100-\u115f\u2329\u232a\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/u.test(scalar) ? 2 : 1;
  return width;
}

function fit(value: string, width: number): string {
  const clean = value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ").replace(/\s+/gu, " ").trim();
  if (scalarWidth(clean) <= width) return clean;
  if (width <= 1) return "…".slice(0, width);
  let result = "";
  for (const scalar of clean) {
    if (scalarWidth(result) + scalarWidth(scalar) > width - 1) break;
    result += scalar;
  }
  return `${result}…`;
}

/** Render the same public view model without inspecting terminals or invoking tmux. */
export function renderControlRoomTerminal(model: ControlRoomViewModelV1, options: Readonly<{ width?: number; height?: number }> = {}): string {
  const width = options.width ?? 100;
  const height = options.height ?? 40;
  if (!Number.isSafeInteger(width) || width < CONTROL_ROOM_TERMINAL_LIMITS.minimumWidth || width > CONTROL_ROOM_TERMINAL_LIMITS.maximumWidth) throw new RangeError("terminal width is outside the closed bound");
  if (!Number.isSafeInteger(height) || height < CONTROL_ROOM_TERMINAL_LIMITS.minimumHeight || height > CONTROL_ROOM_TERMINAL_LIMITS.maximumHeight) throw new RangeError("terminal height is outside the closed bound");
  const lines: string[] = [model.title, `${model.connectionLabel} | ${model.headLabel}`];
  for (const item of model.notices) lines.push(`[${item.severity.toUpperCase()}] ${item.text}`);
  lines.push("AGENTS");
  for (const bucket of model.buckets) {
    if (bucket.count === 0) continue;
    lines.push(`${bucket.label.toUpperCase()} (${bucket.count})`);
    for (const row of bucket.rows) {
      lines.push(`  ${row.agentId} | ${row.activityLabel} | ${row.taskLabel}`);
      lines.push(`    ${row.sourceLabel} | ${row.steeringLabel} | ${row.verificationLabel}`);
      if (row.latestSummary !== undefined) lines.push(`    ${row.latestSummary}`);
    }
  }
  if (model.rows.length === 0) lines.push("  No agents in the verified snapshot.");
  lines.push("ACTIVITY");
  for (const item of model.timeline) lines.push(`#${item.seq} ${item.agentId} ${item.categoryLabel}: ${item.text} (${item.integrityLabel})`);
  if (model.timeline.length === 0) lines.push("  No normalized observations.");
  const omitted = Math.max(0, lines.length - height);
  const retained = omitted === 0 ? lines : [...lines.slice(0, Math.max(0, height - 1)), `… ${omitted + 1} lines omitted`];
  return retained.map((line) => fit(line, width)).join("\n");
}
