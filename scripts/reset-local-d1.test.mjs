import assert from "node:assert/strict";
import { access, lstat, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  EXPECTED_LOCAL_D1_SUFFIX,
  LOCAL_D1_SEGMENTS,
  assertExpectedLocalD1Path,
  assertLocalD1PathHasNoSymlinks,
  resetLocalD1,
} from "./reset-local-d1.mjs";

async function withTempRoot(fn) {
  const root = await mkdtemp(path.join(os.tmpdir(), "cutman-reset-d1-"));
  const webDir = path.join(root, "apps", "web");
  const localD1Dir = path.join(webDir, ...LOCAL_D1_SEGMENTS);
  try {
    await fn({ root, webDir, localD1Dir });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writeSentinel(dir, name = "keep-me") {
  await mkdir(dir, { recursive: true });
  const filePath = path.join(dir, name);
  await writeFile(filePath, "sentinel");
  return filePath;
}

const SYMLINK_CASES = [
  { name: "apps/web", linkIndex: 0 },
  { name: ".wrangler", linkIndex: 1 },
  { name: "state", linkIndex: 2 },
  { name: "v3", linkIndex: 3 },
  { name: "d1", linkIndex: 4 },
];

describe("reset-local-d1 path guards", () => {
  it("removes a normal nested D1 directory and leaves sibling state", async () => {
    await withTempRoot(async ({ webDir, localD1Dir }) => {
      const d1File = await writeSentinel(localD1Dir, "db.sqlite");
      const kvFile = await writeSentinel(
        path.join(webDir, ".wrangler", "state", "v3", "kv"),
        "kv.sqlite",
      );

      await resetLocalD1(localD1Dir);

      await assert.rejects(() => access(d1File), { code: "ENOENT" });
      await assert.rejects(() => access(localD1Dir), { code: "ENOENT" });
      await access(kvFile);
    });
  });

  it("treats a missing tail as safe and does not throw", async () => {
    await withTempRoot(async ({ webDir, localD1Dir }) => {
      await mkdir(path.join(webDir, ".wrangler", "state"), { recursive: true });

      await assertLocalD1PathHasNoSymlinks(webDir);
      await resetLocalD1(localD1Dir);
    });
  });

  it("treats a fully missing apps/web tail as safe", async () => {
    await withTempRoot(async ({ webDir, localD1Dir }) => {
      await assertLocalD1PathHasNoSymlinks(webDir);
      await resetLocalD1(localD1Dir);
    });
  });

  for (const { name, linkIndex } of SYMLINK_CASES) {
    it(`rejects a symbolic link at ${name} before rm`, async () => {
      await withTempRoot(async ({ root, webDir, localD1Dir }) => {
        const target = path.join(root, "link-target");
        const remaining = LOCAL_D1_SEGMENTS.slice(linkIndex);
        const keepPath = await writeSentinel(path.join(target, ...remaining));
        const chain = [
          webDir,
          ...LOCAL_D1_SEGMENTS.map((_, index) =>
            path.join(webDir, ...LOCAL_D1_SEGMENTS.slice(0, index + 1)),
          ),
        ];
        const linkPath = chain[linkIndex];
        await mkdir(path.dirname(linkPath), { recursive: true });
        await symlink(target, linkPath);

        await assert.rejects(
          () => resetLocalD1(localD1Dir),
          (error) => {
            assert.match(error.message, /symbolic link/);
            assert.ok(error.message.includes(linkPath));
            return true;
          },
        );
        await access(keepPath);
        assert.equal((await lstat(linkPath)).isSymbolicLink(), true);
      });
    });
  }

  it("rejects an unexpected suffix before any deletion", async () => {
    await withTempRoot(async ({ webDir }) => {
      const unexpected = path.join(webDir, ".wrangler", "state", "v3", "kv");
      const keepPath = await writeSentinel(unexpected);

      assert.throws(
        () => assertExpectedLocalD1Path(unexpected),
        new Error(`Refusing to delete unexpected path: ${unexpected}`),
      );
      await assert.rejects(
        () => resetLocalD1(unexpected),
        new Error(`Refusing to delete unexpected path: ${unexpected}`),
      );
      await access(keepPath);
    });
  });

  it("rejects a path that does not end with the hardcoded local D1 suffix", () => {
    const unexpected = path.join(os.tmpdir(), "not-the-d1-dir");
    assert.throws(
      () => assertExpectedLocalD1Path(unexpected),
      new Error(`Refusing to delete unexpected path: ${unexpected}`),
    );
    assert.ok(EXPECTED_LOCAL_D1_SUFFIX.endsWith(path.join("apps", "web", ...LOCAL_D1_SEGMENTS)));
  });
});
