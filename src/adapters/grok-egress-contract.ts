import { createHash } from "node:crypto";

export const GROK_EGRESS_POLICY_VERSION = "relayforge.grok-egress.connect.v1" as const;
export const GROK_EGRESS_ALLOWED_AUTHORITY = "api.x.ai:443" as const;
export const GROK_EGRESS_SOCKET_NAME = "grok-egress-v1.sock" as const;
export const GROK_EGRESS_RELAY_RUNTIME = "grok-egress-relay.mjs" as const;
export const GROK_EGRESS_MAX_HEADER_BYTES = 8_192;
export const GROK_EGRESS_MAX_CONNECTIONS = 8;
export const GROK_EGRESS_MAX_DECISIONS = 64;
export const GROK_EGRESS_CONNECT_TIMEOUT_MS = 5_000;
export const GROK_EGRESS_MAX_LIFETIME_MS = 10 * 60_000;
export const GROK_EGRESS_ALLOWED_HEADERS = Object.freeze(["host", "proxy-connection", "user-agent"] as const);

export const GROK_EGRESS_POLICY_SHA256 = createHash("sha256").update(JSON.stringify({
  allowedAuthorities: [GROK_EGRESS_ALLOWED_AUTHORITY],
  allowedHeaders: [...GROK_EGRESS_ALLOWED_HEADERS],
  maxConnections: GROK_EGRESS_MAX_CONNECTIONS,
  maxDecisions: GROK_EGRESS_MAX_DECISIONS,
  maxHeaderBytes: GROK_EGRESS_MAX_HEADER_BYTES,
  maxLifetimeMs: GROK_EGRESS_MAX_LIFETIME_MS,
  upstreamAddressPolicy: "global-unicast-v1",
  version: GROK_EGRESS_POLICY_VERSION
})).digest("hex");

export type GrokEgressEvidenceBinding = Readonly<{
  policySha256: string;
  probeReceiptSha256: string;
  decisionLogSha256: string;
  socketIdentitySha256: string;
  cleanupSha256: string;
}>;

export function grokEgressDenialEvidenceSha256(input: GrokEgressEvidenceBinding): string {
  return createHash("sha256").update(JSON.stringify({
    cleanupSha256: input.cleanupSha256,
    decisionLogSha256: input.decisionLogSha256,
    policySha256: input.policySha256,
    probeReceiptSha256: input.probeReceiptSha256,
    socketIdentitySha256: input.socketIdentitySha256
  })).digest("hex");
}
