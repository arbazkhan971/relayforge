/**
 * RelayForge's public root is deliberately authority-free.
 *
 * Execution, durable-store ownership, steering mutation, provider launch,
 * settlement, and parent lifecycle factories stay package-internal. Public
 * consumers receive configuration/data contracts, pure adapter codecs, and
 * bounded read-model clients and projections.
 */
export {
  RELAYFORGE_PRODUCT_NAME,
  RELAYFORGE_PACKAGE_NAME,
  RELAYFORGE_COMMAND,
  RELAYFORGE_CONFIG_BASENAMES,
  LOOP_CONFIG_BASENAMES,
  RELAYFORGE_LEGACY_COMMANDS,
  relayForgeIdentity,
  RELAYFORGE_PUBLIC_ENVIRONMENT_NAMES,
  RelayForgeIdentityError,
  resolveRelayForgeEnvironment,
  assertRelayForgeEnvironmentCompatibility,
  invokedRelayForgeCommand,
  type RelayForgePublicEnvironment
} from "./identity.js";

export {
  AuthSchema,
  ProviderSchema,
  ProvisionSpecSchema,
  RepositorySchema,
  ScmRepositoryConfigSchema,
  ScmProjectConfigSchema,
  MultiRepositoryTaskConfigSchema,
  MultiRepositoryProjectConfigSchema,
  SmeDisciplineSchema,
  RoleSchema,
  LoopSchema,
  ProjectSchema,
  RootConfigSchema,
  type ProviderConfig,
  type AuthConfig,
  type RepositoryConfig,
  type ScmRepositoryConfig,
  type ScmProjectConfig,
  type MultiRepositoryTaskConfig,
  type MultiRepositoryProjectConfig,
  type RoleConfig,
  type LoopConfig,
  type ProjectConfig,
  type RootConfig,
  type SmeDiscipline
} from "./config/schema.js";
export {
  ConfigDiscoveryError,
  configCandidatesInDirectory,
  findConfig,
  loadConfig,
  getProject,
  type LoadedConfig,
  type ConfigDiscoveryErrorCode
} from "./config/load.js";
export { getAuthStatus, type ProviderAuthStatus } from "./auth.js";
export {
  builtinAdapterDescriptors,
  getBuiltinAdapterDescriptor,
  type BuiltinProviderKind
} from "./providers.js";

// These leaf modules contain schemas, immutable descriptors, pure codecs, and
// read-only projections only. They do not own stores, processes, or leases.
export * from "./control/protocol.js";
export * from "./control/redaction.js";
export * from "./control/views.js";
export * from "./control/client.js";

export * from "./adapters/types.js";
export * from "./adapters/registry.js";
export {
  shippedAdapterIds,
  isShippedAdapterId,
  getShippedAdapterDescriptor,
  selectShippedAdapter,
  shippedAdapterConfigSha256,
  type ShippedAdapterId,
  type ShippedAdapterSelection
} from "./adapters/bootstrap.js";
export * from "./adapters/codec.js";
export * from "./adapters/acp-v1.js";
export * from "./adapters/pi-rpc.js";
export * from "./adapters/grok-acp.js";

// These index modules are themselves explicit authority-free public facades.
export * from "./observability/index.js";
export * from "./control-room/index.js";
export * from "./steering/index.js";
