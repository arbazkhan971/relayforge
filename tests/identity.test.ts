import { describe, expect, it } from "vitest";
import {
  assertRelayForgeEnvironmentCompatibility,
  invokedRelayForgeCommand,
  LOOP_CONFIG_BASENAMES,
  relayForgeIdentity,
  RelayForgeIdentityError,
  RELAYFORGE_CONFIG_BASENAMES,
  resolveRelayForgeEnvironment
} from "../src/identity.js";

describe("RelayForge public identity", () => {
  it("publishes one immutable primary identity with only the audited v1 aliases", () => {
    expect(relayForgeIdentity).toEqual({
      product: "RelayForge",
      packageName: "relayforge",
      command: "relayforge",
      legacyCommands: ["loop", "loop-orchestrator"],
      configBasenames: ["relayforge.config.yaml", "relayforge.config.yml", "relayforge.config.json"],
      legacyConfigBasenames: ["loop.config.yaml", "loop.config.yml", "loop.config.json"],
      durableStateDirectory: ".loop"
    });
    expect(Object.isFrozen(relayForgeIdentity)).toBe(true);
    expect(Object.isFrozen(RELAYFORGE_CONFIG_BASENAMES)).toBe(true);
    expect(Object.isFrozen(LOOP_CONFIG_BASENAMES)).toBe(true);
  });

  it("recognizes all three installed commands without inventing another alias", () => {
    expect(invokedRelayForgeCommand("/prefix/bin/relayforge")).toBe("relayforge");
    expect(invokedRelayForgeCommand("/prefix/bin/loop")).toBe("loop");
    expect(invokedRelayForgeCommand("C:\\prefix\\loop-orchestrator.cmd")).toBeUndefined();
    expect(invokedRelayForgeCommand("/prefix/bin/loop-orchestrator.cmd")).toBe("loop-orchestrator");
    expect(invokedRelayForgeCommand("/prefix/bin/other")).toBeUndefined();
  });

  it("prefers the canonical public env spelling only when values do not conflict", () => {
    expect(resolveRelayForgeEnvironment("TMUX", { RELAYFORGE_TMUX: "off" })).toBe("off");
    expect(resolveRelayForgeEnvironment("TMUX", { LOOP_TMUX: "off" })).toBe("off");
    expect(resolveRelayForgeEnvironment("TMUX", { RELAYFORGE_TMUX: "off", LOOP_TMUX: "off" })).toBe("off");
    expect(resolveRelayForgeEnvironment("TMUX_SOCKET", {})).toBeUndefined();
  });

  it("refuses differing canonical/legacy env values with a typed, bounded error", () => {
    expect(() => resolveRelayForgeEnvironment("SANDBOX", {
      RELAYFORGE_SANDBOX: "off",
      LOOP_SANDBOX: "on"
    })).toThrowError(expect.objectContaining<Partial<RelayForgeIdentityError>>({ code: "ENV_CONFLICT" }));
    expect(() => assertRelayForgeEnvironmentCompatibility({
      RELAYFORGE_TMUX_SOCKET: "/one",
      LOOP_TMUX_SOCKET: "/two"
    })).toThrow(/ENV_CONFLICT/u);
  });
});
