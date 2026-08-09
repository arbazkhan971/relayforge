import { defineAdapterDescriptor } from "../registry.js";
import {
  ADAPTER_CONTRACT_VERSION,
  ADAPTER_DESCRIPTOR_SCHEMA_VERSION,
  type AdapterDescriptor
} from "../types.js";

/** Pure description of the installed Codex 0.144.0 `exec --json` contract. */
export const codexAdapterDescriptor: AdapterDescriptor = defineAdapterDescriptor({
  schemaVersion: ADAPTER_DESCRIPTOR_SCHEMA_VERSION,
  contractVersion: ADAPTER_CONTRACT_VERSION,
  id: "codex",
  providerId: "codex",
  transportKind: "oneshot-jsonl",
  runtimeIdentity: {
    kind: "installed-executable",
    executable: "codex",
    trustedHelpers: [],
    resolution: "canonical-installed-only"
  },
  compatibility: {
    executableVersion: {
      scheme: "semver",
      minInclusive: "0.144.0",
      maxExclusive: "0.145.0"
    },
    wireVersions: ["codex-exec-json/0.144.0"],
    behavioralProbe: {
      id: "codex-cli-0.144.0",
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
    fixedArguments: ["exec", "--json", "--ephemeral", "-"],
    controlledOptions: [
      { name: "model", kind: "model", required: false },
      { name: "effort", kind: "effort", required: false },
      { name: "sandbox-mode", kind: "mode", required: true }
    ],
    allowedEnvironmentNames: [
      "OPENAI_API_KEY",
      "OPENAI_BASE_URL",
      "OPENAI_ORG",
      "OPENAI_ORGANIZATION",
      "LOOP_ROLE",
      "LOOP_READONLY",
      "LOOP_SYSTEM_PROMPT_FILE"
    ],
    promptTransport: "stdin-text",
    systemPromptChannel: "combined"
  },
  capabilityPolicy: {
    "model-discovery": "unsupported",
    "session-create": "unsupported",
    "session-resume": "unsupported",
    streaming: "required",
    cancellation: "unsupported",
    usage: "required",
    cost: "unsupported",
    context: "unsupported",
    "rate-limits": "unsupported",
    steering: "unsupported",
    attachments: "unsupported",
    "inner-read-only": "required"
  },
  codec: { id: "codex-stdin-combined-v1", version: 1 },
  normalizer: { id: "codex-json-0.144.0", version: 1 },
  roles: {
    worker: {
      status: "enabled",
      outerSandbox: "required",
      filesystem: "workspace-write",
      innerReadOnly: "not-required",
      requiredCapabilities: ["streaming", "usage"]
    },
    reviewer: {
      status: "enabled",
      outerSandbox: "required",
      filesystem: "read-only",
      innerReadOnly: "required",
      requiredCapabilities: ["streaming", "usage", "inner-read-only"]
    }
  }
});
