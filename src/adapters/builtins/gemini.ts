import { defineAdapterDescriptor } from "../registry.js";
import {
  ADAPTER_CONTRACT_VERSION,
  ADAPTER_DESCRIPTOR_SCHEMA_VERSION,
  type AdapterDescriptor
} from "../types.js";

/**
 * Pure description of the characterized legacy Gemini invocation.
 *
 * Gemini has no proven structured streaming terminal contract in this
 * release. Its prompt remains combined and argv-delivered for compatibility,
 * and all accounting facts remain optional/unknown unless the legacy raw
 * terminal shape supplies them.
 */
export const geminiAdapterDescriptor: AdapterDescriptor = defineAdapterDescriptor({
  schemaVersion: ADAPTER_DESCRIPTOR_SCHEMA_VERSION,
  contractVersion: ADAPTER_CONTRACT_VERSION,
  id: "gemini",
  providerId: "gemini",
  transportKind: "oneshot-jsonl",
  runtimeIdentity: {
    kind: "installed-executable",
    executable: "gemini",
    trustedHelpers: [],
    resolution: "canonical-installed-only"
  },
  compatibility: {
    executableVersion: {
      scheme: "semver",
      minInclusive: "0.0.0",
      maxExclusive: "1.0.0"
    },
    wireVersions: ["gemini-json/legacy-v1"],
    behavioralProbe: {
      id: "gemini-legacy-json",
      version: 1,
      requiredChecks: ["executable-version", "transport-handshake", "prompt-roundtrip"]
    }
  },
  invocationPolicy: {
    fixedArguments: ["-p", "--output-format", "json"],
    controlledOptions: [{ name: "model", kind: "model", required: false }],
    allowedEnvironmentNames: [
      "GEMINI_API_KEY",
      "GOOGLE_API_KEY",
      "GOOGLE_APPLICATION_CREDENTIALS",
      "GOOGLE_CLOUD_PROJECT",
      "LOOP_ROLE",
      "LOOP_READONLY",
      "LOOP_SYSTEM_PROMPT_FILE"
    ],
    promptTransport: "argv-legacy",
    systemPromptChannel: "combined"
  },
  capabilityPolicy: {
    "model-discovery": "unsupported",
    "session-create": "unsupported",
    "session-resume": "unsupported",
    streaming: "unsupported",
    cancellation: "unsupported",
    usage: "optional",
    cost: "optional",
    context: "unsupported",
    "rate-limits": "unsupported",
    steering: "unsupported",
    attachments: "unsupported",
    "inner-read-only": "unsupported"
  },
  codec: { id: "gemini-argv-combined-v1", version: 1 },
  normalizer: { id: "gemini-raw-v1", version: 1 },
  roles: {
    worker: {
      status: "enabled",
      outerSandbox: "required",
      filesystem: "workspace-write",
      innerReadOnly: "not-required",
      requiredCapabilities: []
    },
    reviewer: {
      status: "enabled",
      outerSandbox: "required",
      filesystem: "read-only",
      innerReadOnly: "not-required",
      requiredCapabilities: []
    }
  }
});
