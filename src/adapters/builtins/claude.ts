import { defineAdapterDescriptor } from "../registry.js";
import {
  ADAPTER_CONTRACT_VERSION,
  ADAPTER_DESCRIPTOR_SCHEMA_VERSION,
  type AdapterDescriptor
} from "../types.js";

/**
 * Pure description of the existing Claude Code 2.1.207 one-shot contract.
 *
 * The descriptor contains no executable behavior. The parent-owned provider
 * builder and bounded normalizer select their already-characterized state
 * machines by this immutable identity.
 */
export const claudeAdapterDescriptor: AdapterDescriptor = defineAdapterDescriptor({
  schemaVersion: ADAPTER_DESCRIPTOR_SCHEMA_VERSION,
  contractVersion: ADAPTER_CONTRACT_VERSION,
  id: "claude",
  providerId: "claude",
  transportKind: "oneshot-jsonl",
  runtimeIdentity: {
    kind: "installed-executable",
    executable: "claude",
    trustedHelpers: [],
    resolution: "canonical-installed-only"
  },
  compatibility: {
    executableVersion: {
      scheme: "semver",
      minInclusive: "2.1.207",
      maxExclusive: "2.1.208"
    },
    wireVersions: ["claude-stream-json/2.1.207"],
    behavioralProbe: {
      id: "claude-cli-2.1.207",
      version: 1,
      requiredChecks: [
        "executable-version",
        "transport-handshake",
        "framing",
        "prompt-roundtrip",
        "read-only-denial",
        "accounting"
      ]
    }
  },
  invocationPolicy: {
    fixedArguments: [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--no-session-persistence",
      "--append-system-prompt-file"
    ],
    controlledOptions: [
      { name: "model", kind: "model", required: false },
      { name: "permission-mode", kind: "mode", required: true }
    ],
    allowedEnvironmentNames: [
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "ANTHROPIC_BASE_URL",
      "ANTHROPIC_MODEL",
      "LOOP_ROLE",
      "LOOP_READONLY",
      "LOOP_SYSTEM_PROMPT_FILE"
    ],
    promptTransport: "stdin-text",
    systemPromptChannel: "separate"
  },
  capabilityPolicy: {
    "model-discovery": "unsupported",
    "session-create": "unsupported",
    "session-resume": "unsupported",
    streaming: "required",
    cancellation: "unsupported",
    usage: "optional",
    cost: "optional",
    context: "unsupported",
    "rate-limits": "optional",
    steering: "unsupported",
    attachments: "unsupported",
    "inner-read-only": "required"
  },
  codec: { id: "claude-stdin-goal-v1", version: 1 },
  normalizer: { id: "claude-stream-json-2.1.207", version: 1 },
  roles: {
    worker: {
      status: "enabled",
      outerSandbox: "required",
      filesystem: "workspace-write",
      innerReadOnly: "not-required",
      requiredCapabilities: ["streaming"]
    },
    reviewer: {
      status: "enabled",
      outerSandbox: "required",
      filesystem: "read-only",
      innerReadOnly: "required",
      requiredCapabilities: ["streaming", "inner-read-only"]
    }
  }
});
