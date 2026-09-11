import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, lstat, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  LOCAL_D1_SEGMENTS,
  assertCanonicalResolvedPath,
  assertExpectedLocalD1Path,
  assertLocalD1PathHasNoSymlinks,
  isCliEntrypoint,
  isSameRealPath,
  resetLocalD1,
  resetLocalD1MatchingExpected,
  resolveLocalD1WebDir,
} from "./reset-local-d1.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = path.join(repoRoot, "scripts/reset-local-d1.mjs");
const localD1Suffix = path.join("apps", "web", ...LOCAL_D1_SEGMENTS);

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

const SEGMENTS_AFTER_REPO_ROOT = Object.freeze(["apps", "web", ...LOCAL_D1_SEGMENTS]);

/**
 * chain = [repoRoot, apps, web, ...LOCAL_D1_SEGMENTS]. Skip index 0 (the real
 * mkdtemp root already exists). A checkout whose own root path is a symlink is
 * covered separately: the guard refuses it rather than following.
 */
const SYMLINK_CASES = [
  { name: "apps", linkIndex: 1 },
  { name: "apps/web", linkIndex: 2 },
  { name: ".wrangler", linkIndex: 3 },
  { name: "state", linkIndex: 4 },
  { name: "v3", linkIndex: 5 },
  { name: "d1", linkIndex: 6 },
];

function localD1PathChain(root) {
  const appsDir = path.join(root, "apps");
  const webDir = path.join(appsDir, "web");
  return [
    root,
    appsDir,
    webDir,
    ...LOCAL_D1_SEGMENTS.map((_, index) =>
      path.join(webDir, ...LOCAL_D1_SEGMENTS.slice(0, index + 1)),
    ),
  ];
}

/**
 * Suffix under the symlink target where the D1 sentinel must live.
 * chain = [repoRoot, apps, web, ...LOCAL_D1_SEGMENTS]; `linkIndex` selects which entry is the link.
 * - Leaf (`d1`): the target *is* that directory, so there is no extra suffix.
 * - Replaced ancestor: skip that entry and keep the remaining segments under the target.
 */
function remainingSegmentsUnderLinkTarget(linkIndex) {
  if (linkIndex === 0) {
    return [...SEGMENTS_AFTER_REPO_ROOT];
  }
  if (linkIndex === SEGMENTS_AFTER_REPO_ROOT.length) {
    return [];
  }
  return SEGMENTS_AFTER_REPO_ROOT.slice(linkIndex);
}

describe("reset-local-d1 path guards", () => {
  it("walks up LOCAL_D1_SEGMENTS.length parents to reach the web dir", () => {
    const webDir = path.resolve("/tmp/cutman-apps-web");
    const localD1Dir = path.join(webDir, ...LOCAL_D1_SEGMENTS);

    assert.equal(resolveLocalD1WebDir(localD1Dir), webDir);
    assert.notEqual(
      path.resolve(
        localD1Dir,
        ...Array.from({ length: LOCAL_D1_SEGMENTS.length - 1 }, () => ".."),
      ),
      webDir,
    );
  });

  it("removes a normal nested D1 directory and leaves sibling state", async () => {
    await withTempRoot(async ({ webDir, localD1Dir }) => {
      const d1File = await writeSentinel(localD1Dir, "db.sqlite");
      const kvFile = await writeSentinel(
        path.join(webDir, ".wrangler", "state", "v3", "kv"),
        "kv.sqlite",
      );

      await resetLocalD1MatchingExpected(localD1Dir, localD1Dir);

      await assert.rejects(() => access(d1File), { code: "ENOENT" });
      await assert.rejects(() => access(localD1Dir), { code: "ENOENT" });
      await access(kvFile);
    });
  });

  it("treats a missing tail as safe and does not throw", async () => {
    await withTempRoot(async ({ webDir, localD1Dir }) => {
      await mkdir(path.join(webDir, ".wrangler", "state"), { recursive: true });

      await assertLocalD1PathHasNoSymlinks(webDir);
      await resetLocalD1MatchingExpected(localD1Dir, localD1Dir);
    });
  });

  it("treats a fully missing apps/web tail as safe", async () => {
    await withTempRoot(async ({ webDir, localD1Dir }) => {
      await assertLocalD1PathHasNoSymlinks(webDir);
      await resetLocalD1MatchingExpected(localD1Dir, localD1Dir);
    });
  });

  for (const { name, linkIndex } of SYMLINK_CASES) {
    it(`rejects a symbolic link at ${name} before rm`, async () => {
      await withTempRoot(async ({ root, localD1Dir }) => {
        const target = path.join(root, "link-target");
        const remaining = remainingSegmentsUnderLinkTarget(linkIndex);
        const keepPath = await writeSentinel(path.join(target, ...remaining));
        const chain = localD1PathChain(root);
        const linkPath = chain[linkIndex];
        await mkdir(path.dirname(linkPath), { recursive: true });
        await symlink(target, linkPath);

        const linkRealPath = await realpath(linkPath);
        const keepRealPath = await realpath(keepPath);
        const relativeKeep = path.relative(linkRealPath, keepRealPath);
        assert.ok(
          relativeKeep.length > 0 &&
            !relativeKeep.startsWith("..") &&
            !path.isAbsolute(relativeKeep),
          `sentinel ${keepRealPath} is not under link target ${linkRealPath}`,
        );

        await assert.rejects(
          () => resetLocalD1MatchingExpected(localD1Dir, localD1Dir),
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

  it("rejects a symbolic link at the derived repo root before rm", async () => {
    const outer = await mkdtemp(path.join(os.tmpdir(), "cutman-reset-d1-root-link-"));
    try {
      const realRoot = path.join(outer, "real-root");
      const linkRoot = path.join(outer, "link-root");
      await mkdir(realRoot);
      await symlink(realRoot, linkRoot);
      const webDir = path.join(linkRoot, "apps", "web");
      const localD1Dir = path.join(webDir, ...LOCAL_D1_SEGMENTS);
      const keepPath = await writeSentinel(path.join(realRoot, "apps", "web", ...LOCAL_D1_SEGMENTS));

      await assert.rejects(
        () => resetLocalD1MatchingExpected(localD1Dir, localD1Dir),
        (error) => {
          assert.match(error.message, /symbolic link/);
          assert.ok(error.message.includes(linkRoot));
          return true;
        },
      );
      await access(keepPath);
      assert.equal((await lstat(linkRoot)).isSymbolicLink(), true);
    } finally {
      await rm(outer, { recursive: true, force: true });
    }
  });

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

  it("rejects a lookalike path that only shares the local D1 suffix", async () => {
    await withTempRoot(async ({ localD1Dir }) => {
      const keepPath = await writeSentinel(localD1Dir, "db.sqlite");
      assert.ok(localD1Dir.endsWith(localD1Suffix));

      assert.throws(
        () => assertExpectedLocalD1Path(localD1Dir),
        new Error(`Refusing to delete unexpected path: ${localD1Dir}`),
      );
      await assert.rejects(
        () => resetLocalD1(localD1Dir),
        new Error(`Refusing to delete unexpected path: ${localD1Dir}`),
      );
      await access(keepPath);
    });
  });

  it("rejects a path that is not the hardcoded local D1 directory", () => {
    const unexpected = path.join(os.tmpdir(), "not-the-d1-dir");
    assert.throws(
      () => assertExpectedLocalD1Path(unexpected),
      new Error(`Refusing to delete unexpected path: ${unexpected}`),
    );
  });

  it("refuses helper deletion when the expected temp path does not match", async () => {
    await withTempRoot(async ({ localD1Dir }) => {
      const keepPath = await writeSentinel(localD1Dir, "db.sqlite");
      const otherExpected = path.join(os.tmpdir(), "other-expected-d1");

      assert.throws(
        () => assertCanonicalResolvedPath(localD1Dir, otherExpected),
        new Error(`Refusing to delete unexpected path: ${localD1Dir}`),
      );
      await assert.rejects(
        () => resetLocalD1MatchingExpected(localD1Dir, otherExpected),
        new Error(`Refusing to delete unexpected path: ${localD1Dir}`),
      );
      await access(keepPath);
    });
  });
});

describe("reset-local-d1 CLI entrypoint", () => {
  it("does not reset on a normal non-test import", async () => {
    const result = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", 'import "./scripts/reset-local-d1.mjs";'],
      {
        cwd: repoRoot,
        env: process.env,
        encoding: "utf8",
      },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
  });

  it("treats a missing argv path as not this module", async () => {
    assert.equal(
      await isSameRealPath("/this/path/does/not/exist.mjs", scriptPath),
      false,
    );
  });

  it("treats an absent argv path as a safe non-entrypoint", async () => {
    assert.equal(await isCliEntrypoint("", scriptPath), false);
    assert.equal(await isCliEntrypoint(undefined, scriptPath), false);
  });

  it("fails loudly when argv is present but unresolvable", async () => {
    await assert.rejects(
      () => isCliEntrypoint("/this/path/does/not/exist.mjs", scriptPath),
      { code: "ENOENT" },
    );

    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        'process.argv[1] = "/this/path/does/not/exist.mjs"; await import("./scripts/reset-local-d1.mjs");',
      ],
      {
        cwd: repoRoot,
        env: process.env,
        encoding: "utf8",
      },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /ENOENT/);
  });

  it("treats a valid path to this module as the CLI entrypoint", async () => {
    assert.equal(await isCliEntrypoint(scriptPath, scriptPath), true);
    assert.equal(
      await isCliEntrypoint(path.join(repoRoot, "package.json"), scriptPath),
      false,
    );
  });

  it("treats a symlink to this module as the CLI entrypoint", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cutman-reset-d1-cli-link-"));
    const linkPath = path.join(dir, "reset-local-d1.mjs");
    try {
      await symlink(scriptPath, linkPath);
      assert.equal(await isSameRealPath(linkPath, scriptPath), true);
      assert.equal(await isCliEntrypoint(linkPath, scriptPath), true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
