import { describe, expect, it } from "vitest";
import { assertRepositoryScope, materializeRepositoryRegistry, materializeRepositorySet, MultiRepositoryDomainError } from "../src/multirepo/domain.js";

const definition = (repositoryId: string, configuredPath = `./${repositoryId}`) => ({ schemaVersion: 1 as const, repositoryId, configuredPath, defaultBranch: "main", protectedBranches: ["main"] });
const resolver = (offset = 0) => (value: ReturnType<typeof definition>) => ({ canonicalRoot: `/repos/${value.repositoryId}`, rootDevice: 1, rootInode: 100 + offset + value.repositoryId.length, gitCommonDirDevice: 1, gitCommonDirInode: 200 + offset + value.repositoryId.length });

describe("multi-repository domain", () => {
  it("materializes stable identity-sorted registries and ordered set digests", () => {
    const registry = materializeRepositoryRegistry([definition("beta"), definition("alpha")], resolver());
    expect(registry.repositories.map((item) => item.repositoryId)).toEqual(["alpha", "beta"]);
    const ab = materializeRepositorySet(registry, ["alpha", "beta"]);
    const ba = materializeRepositorySet(registry, ["beta", "alpha"]);
    expect(ab.repositorySetId).toMatch(/^[a-f0-9]{64}$/u);
    expect(ab.repositorySetId).not.toBe(ba.repositorySetId);
    expect(materializeRepositorySet(registry, ["alpha", "beta"])).toEqual(ab);
  });

  it("rejects ID, root inode, Git common-dir, canonical path, and nested aliases", () => {
    expect(() => materializeRepositoryRegistry([definition("same"), definition("same")], resolver())).toThrowError(expect.objectContaining({ code: "DUPLICATE_REPOSITORY" }));
    expect(() => materializeRepositoryRegistry([definition("one"), definition("two")], () => ({ canonicalRoot: "/repos/same", rootDevice: 1, rootInode: 1, gitCommonDirDevice: 1, gitCommonDirInode: 2 }))).toThrowError(expect.objectContaining({ code: "PHYSICAL_ALIAS" }));
    expect(() => materializeRepositoryRegistry([definition("one"), definition("two")], (value) => ({ canonicalRoot: `/repos/${value.repositoryId}`, rootDevice: 1, rootInode: value.repositoryId === "one" ? 1 : 2, gitCommonDirDevice: 1, gitCommonDirInode: 9 }))).toThrowError(expect.objectContaining({ code: "PHYSICAL_ALIAS" }));
    expect(() => materializeRepositoryRegistry([definition("one"), definition("two")], (value) => ({ canonicalRoot: value.repositoryId === "one" ? "/repos/root" : "/repos/root/child", rootDevice: 1, rootInode: value.repositoryId === "one" ? 1 : 2, gitCommonDirDevice: 1, gitCommonDirInode: value.repositoryId === "one" ? 3 : 4 }))).toThrowError(expect.objectContaining({ code: "NESTED_REPOSITORY" }));
  });

  it("rejects unknown, duplicate, empty, and over-capability sets", () => {
    const registry = materializeRepositoryRegistry([definition("alpha"), definition("beta")], resolver());
    for (const ids of [[], ["alpha", "alpha"], ["missing"]]) expect(() => materializeRepositorySet(registry, ids)).toThrow(MultiRepositoryDomainError);
    const set = materializeRepositorySet(registry, ["alpha", "beta"]);
    expect(() => assertRepositoryScope(set, { repositoryIds: ["alpha"] }, { repositoryIds: ["alpha", "beta"] })).toThrowError(expect.objectContaining({ code: "SCOPE_EXCEEDED" }));
    expect(() => assertRepositoryScope(set, { repositoryIds: ["alpha", "beta"] }, { repositoryIds: ["alpha", "beta"] })).not.toThrow();
  });

  it("binds policy changes into the repository-set digest", () => {
    const first = materializeRepositorySet(materializeRepositoryRegistry([definition("alpha")], resolver()), ["alpha"]);
    const changed = materializeRepositorySet(materializeRepositoryRegistry([{ ...definition("alpha"), protectedBranches: ["main", "release"] }], resolver(10)), ["alpha"]);
    expect(first.repositorySetId).not.toBe(changed.repositorySetId);
  });
});
