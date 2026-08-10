import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const releaseText = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
const sourceSmokeText = readFileSync(new URL("../scripts/smoke.mjs", import.meta.url), "utf8");
const vitestConfigText = readFileSync(new URL("../vitest.config.ts", import.meta.url), "utf8");
const release = parse(releaseText) as { jobs: Record<string, { needs?: string | string[]; if?: string; permissions?: Record<string, string>; "runs-on"?: string | string[]; steps?: Array<Record<string, unknown>> }> };
const ci = parse(readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8")) as { jobs: Record<string, unknown> };

describe("release workflow authority", () => {
  it("makes publication depend on the artifact and every required real-host gate", () => {
    expect(release.jobs.publish?.needs).toEqual(["artifact", "required-cgroup"]);
    expect(release.jobs.artifact?.needs).toEqual(["gate", "required-cgroup"]);
    expect(release.jobs["required-cgroup"]?.needs).toBe("gate");
    expect(release.jobs).not.toHaveProperty("required-adapters");
    expect(release.jobs.artifact?.["runs-on"]).toEqual([
      "self-hosted",
      "linux",
      "relayforge-adapters",
      "relayforge-cgroup"
    ]);
  });

  it("contains no failure-propagation bypass and grants publish only minimal token authority", () => {
    expect(releaseText).not.toContain("continue-on-error");
    expect(release.jobs.publish?.permissions).toEqual({ contents: "read", "id-token": "write" });
    const alwaysSteps = (release.jobs.artifact?.steps ?? []).filter((step) => String(step.if).includes("always()"));
    expect(alwaysSteps).toHaveLength(1);
    expect(alwaysSteps[0]?.name).toBe("Remove private native-evidence workspace");
    expect(String(alwaysSteps[0]?.run)).not.toContain("release-artifact.mjs");
  });

  it("publishes the downloaded tested tarball only after exact registry preflight", () => {
    const steps = release.jobs.publish?.steps ?? [];
    expect(steps.some((step) => step.id === "preflight" && String(step.run).includes("release-policy.mjs preflight"))).toBe(true);
    expect(steps.some((step) => String(step.run).includes("npm publish") && String(step.run).includes("steps.preflight.outputs.dist_tag"))).toBe(true);
    expect(steps.some((step) => String(step.run).includes("release-policy.mjs converge"))).toBe(true);
  });

  it("collects, consumes, and binds all private native evidence before building the tested artifact", () => {
    const steps = release.jobs.artifact?.steps ?? [];
    const artifact = steps.find((step) => String(step.run).includes("release-artifact.mjs --output"));
    const artifactRun = String(artifact?.run);
    const localCgroupIndex = steps.findIndex((step) => String(step.run).includes("RELAYFORGE_TEST_REQUIRE_CGROUP=1"));
    const artifactIndex = steps.indexOf(artifact!);
    expect(localCgroupIndex).toBeGreaterThan(-1);
    expect(localCgroupIndex).toBeLessThan(artifactIndex);
    expect(artifactRun).toContain("set -euo pipefail");
    expect(artifactRun).toContain("set +x");
    expect(artifactRun).toContain("create-native-adapter-receipt-bundle.mjs --output");
    expect(artifactRun).toContain("--native-adapter-receipts \"$receipt_bundle\"");
    expect(artifactRun.indexOf("create-native-adapter-receipt-bundle.mjs --output")).toBeLessThan(artifactRun.indexOf("release-artifact.mjs --output"));

    const expectedSecret = { opencode: "OPENAI_API_KEY", pi: "ANTHROPIC_API_KEY", grok: "XAI_API_KEY" } as const;
    for (const adapter of ["opencode", "pi", "grok"] as const) {
      const upper = adapter.toUpperCase();
      const collect = "collect-contained-adapter-evidence.mjs";
      const consume = `RELAYFORGE_TEST_REQUIRE_${upper}=1`;
      const step = steps.find((candidate) => String(candidate.run).includes(collect) && String(candidate.run).includes(`--adapter ${adapter}`));
      const stepIndex = steps.indexOf(step!);
      const run = String(step?.run);
      expect(localCgroupIndex).toBeLessThan(stepIndex);
      expect(run).toContain(collect);
      expect(run).toContain("--authorize-paid-probe");
      expect(run).toContain(`--adapter ${adapter}`);
      expect(run).toContain(consume);
      expect(run).toContain(`RELAYFORGE_TEST_${upper}_CONTAINED_EVIDENCE_FILE`);
      expect(run.indexOf(collect)).toBeLessThan(run.indexOf(consume));
      expect(run.indexOf(consume)).toBeLessThan(run.indexOf(`--extract --adapter ${adapter}`));
      expect(step?.env).toEqual({ [expectedSecret[adapter]]: `\${{ secrets.${expectedSecret[adapter]} }}` });
      for (const secret of Object.values(expectedSecret).filter((name) => name !== expectedSecret[adapter])) {
        expect(step?.env).not.toHaveProperty(secret);
      }
      expect(run).toContain("trap 'status=$?");
    }
    expect(JSON.stringify(artifact?.env ?? {})).toBe("{}");
    expect(artifactRun).toContain("RELAYFORGE_RELEASE_CGROUP_GATE=passed");
    expect(releaseText).not.toContain("GITHUB_ENV");
    expect(releaseText).not.toContain("::set-output");
    expect(release.jobs.artifact?.steps?.find((step) => String(step.uses).startsWith("actions/upload-artifact@"))).toBeTruthy();
  });

  it("forces strong containment, the real steering journey, contained delivery, and packed-browser recovery on the artifact runner", () => {
    const steps = release.jobs.artifact?.steps ?? [];
    const strong = steps.findIndex((step) => String(step.run).includes("RELAYFORGE_TEST_REQUIRE_CGROUP=1 npm run validate"));
    const steering = steps.findIndex((step) => String(step.run).includes("RELAYFORGE_TEST_REQUIRE_CGROUP=1 npx vitest run tests/steering-cli-run-e2e.test.ts"));
    const productSmoke = steps.findIndex((step) => String(step.run).includes("npm run smoke") && String(step.run).includes("SMOKE PASS (contained host — verified delivery on the run branch):"));
    const privateRoot = steps.findIndex((step) => String(step.name).includes("Prepare private native-evidence workspace"));
    const artifact = steps.findIndex((step) => String(step.run).includes("release-artifact.mjs --output .release"));
    const cleanup = steps.findIndex((step) => String(step.name) === "Remove private native-evidence workspace");
    const browser = steps.findIndex((step) => String(step.run).includes("smoke-packed-dashboard.mjs --tarball"));
    const upload = steps.findIndex((step) => String(step.uses).startsWith("actions/upload-artifact@"));
    expect(strong).toBeGreaterThan(-1);
    expect(steering).toBeGreaterThan(strong);
    expect(productSmoke).toBeGreaterThan(steering);
    expect(privateRoot).toBeGreaterThan(productSmoke);
    expect(artifact).toBeGreaterThan(privateRoot);
    expect(cleanup).toBeGreaterThan(artifact);
    expect(browser).toBeGreaterThan(cleanup);
    expect(upload).toBeGreaterThan(browser);
    // Strong gate is full validate under cgroup requirement — not only the probe suite.
    expect(String(steps[strong]?.run)).toBe("RELAYFORGE_TEST_REQUIRE_CGROUP=1 npm run validate");
    expect(String(steps[strong]?.run)).not.toContain("cgroup-delegation-linux.test.ts");
    expect(String(steps[steering]?.run)).toContain("tests/steering-cli-run-e2e.test.ts");
    expect(String(steps[steering]?.run)).toContain("RELAYFORGE_TEST_REQUIRE_CGROUP=1");
    const smokeRun = String(steps[productSmoke]?.run);
    expect(smokeRun).toContain("grep -Fqx");
    expect(smokeRun).toContain("SMOKE PASS (contained host — verified delivery on the run branch):");
    expect(smokeRun).not.toContain("fail-closed on a host without containment");
    expect(smokeRun).toContain("set -euo pipefail");
    expect(sourceSmokeText).toContain("verification: feature present");
    expect(sourceSmokeText).not.toMatch(/\$\{?RANDOM|\$\(date/iu);
    expect(vitestConfigText).toContain('process.env.RELAYFORGE_TEST_REQUIRE_CGROUP === "1"');
    expect(vitestConfigText).toContain("maxWorkers: requiredCgroupGate ? 1 : 2");
    // Browser proof is same-job, after exact artifact build, driven by the manifest tarball path.
    const browserRun = String(steps[browser]?.run);
    expect(browserRun).toContain("set -euo pipefail");
    expect(browserRun).toContain("require('./.release/release-manifest.json').tarball.path");
    expect(browserRun).toContain("node scripts/smoke-packed-dashboard.mjs --tarball");
    expect(browserRun).not.toMatch(/continue-on-error|skip|optional/iu);
    expect(steps[browser]).not.toHaveProperty("continue-on-error");
    expect(steps[cleanup]?.if).toEqual("${{ always() }}");
    expect(String(steps[cleanup]?.run)).toContain("rm -f --");
    expect(String(steps[cleanup]?.run)).toContain("relayforge-native-");
    // Paid native probes remain explicitly authorized on the same artifact job only.
    for (const adapter of ["opencode", "pi", "grok"]) {
      const step = steps.find((candidate) => String(candidate.run).includes(`--adapter ${adapter}`) && String(candidate.run).includes("collect-contained-adapter-evidence.mjs"));
      expect(String(step?.run)).toContain("--authorize-paid-probe");
      expect(step).not.toHaveProperty("continue-on-error");
    }
  });

  it("tests the supported Node floor, LTS, and current line before product smoke", () => {
    expect(JSON.stringify(ci.jobs)).toContain('"node":[20,22,24]');
    expect((ci.jobs["product-smoke"] as { needs?: string }).needs).toBe("validate");
  });

  it("builds and uploads a real packed preview artifact for pull requests", () => {
    const preview = ci.jobs["preview-artifact"] as {
      if?: string;
      needs?: string;
      steps?: Array<Record<string, unknown>>;
    };
    expect(preview.if).toContain("pull_request");
    expect(preview.needs).toBe("validate");
    // Preview is built under RUNNER_TEMP (not the checkout) so upload-artifact always sees it.
    expect(preview.steps?.some((step) => String(step.run).includes("release-artifact.mjs --preview --output"))).toBe(true);
    expect(preview.steps?.some((step) => String(step.run).includes("RUNNER_TEMP") && String(step.run).includes("relayforge-preview"))).toBe(true);
    expect(preview.steps?.some((step) => String(step.run).includes("smoke-packed-dashboard.mjs --tarball"))).toBe(true);
    expect(preview.steps?.some((step) => String(step.uses).startsWith("actions/upload-artifact@"))).toBe(true);
  });
});
