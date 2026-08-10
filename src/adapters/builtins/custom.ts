import { defineAdapterDescriptor } from "../registry.js";
import {
  ADAPTER_CONTRACT_VERSION,
  ADAPTER_DESCRIPTOR_SCHEMA_VERSION,
  type AdapterDescriptor
} from "../types.js";

/**
 * Pure, deliberately capability-minimal description of the existing custom
 * command surface. Configuration still supplies only data; it cannot register
 * code or gain cost, quota, fallback, cancellation, or containment authority.
 */
export const customAdapterDescriptor: AdapterDescriptor = defineAdapterDescriptor({
  schemaVersion: ADAPTER_DESCRIPTOR_SCHEMA_VERSION,
  contractVersion: ADAPTER_CONTRACT_VERSION,
  id: "custom",
  providerId: "custom",
  transportKind: "oneshot-text",
  runtimeIdentity: {
    kind: "installed-executable",
    executable: "custom-configured",
    trustedHelpers: [],
    resolution: "canonical-installed-only"
  },
  compatibility: {
    executableVersion: {
      scheme: "semver",
      minInclusive: "0.0.0",
      maxExclusive: "1.0.0"
    },
    wireVersions: ["custom-terminal/legacy-v1"],
    behavioralProbe: {
      id: "custom-legacy-terminal",
      version: 1,
      requiredChecks: ["executable-version", "transport-handshake", "prompt-roundtrip"]
    }
  },
  invocationPolicy: {
    fixedArguments: [],
    controlledOptions: [],
    allowedEnvironmentNames: ["LOOP_ROLE", "LOOP_READONLY", "LOOP_SYSTEM_PROMPT_FILE"],
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
  codec: { id: "custom-argv-combined-v1", version: 1 },
  normalizer: { id: "custom-raw-v1", version: 1 },
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
