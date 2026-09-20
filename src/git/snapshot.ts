import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { execOrThrow } from "../util/exec.js";
import { hasCommits } from "./repo.js";

const SNAPSHOT_REF_PREFIX = "refs/culprit/snapshots";

export interface Snapshot {
  /** Commit sha holding the captured tree. */
  commit: string;
  /** Ref the commit is parked under so Git will not garbage-collect it. */
  ref: string;
}

/**
 * Capture the current working tree -- including files that are untracked but
 * not ignored -- as a real commit object.
 *
 * The user's index and HEAD are never touched. We stage into a throwaway index
 * file via GIT_INDEX_FILE, so running this is safe even mid-rebase or with a
 * carefully staged index the user is not finished with.
 */
export async function snapshotWorkingTree(repo: string, message: string): Promise<Snapshot> {
  const scratch = await mkdtemp(join(tmpdir(), "culprit-index-"));
  const indexFile = join(scratch, "index");
  const env = { GIT_INDEX_FILE: indexFile };

  try {
    // Seed the throwaway index from HEAD so unchanged files keep their entries.
    if (await hasCommits(repo)) {
      await execOrThrow("git", ["read-tree", "HEAD"], { cwd: repo, env });
    } else {
      await execOrThrow("git", ["read-tree", "--empty"], { cwd: repo, env });
    }

    // Stage everything in the working tree. `.gitignore` still applies, which
    // is what keeps node_modules and build output out of the snapshot.
    await execOrThrow("git", ["add", "--all", "--", "."], { cwd: repo, env });

    const tree = (await execOrThrow("git", ["write-tree"], { cwd: repo, env })).stdout.trim();

    const commitArgs = ["commit-tree", tree, "-m", message];
    if (await hasCommits(repo)) {
      const head = (await execOrThrow("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();
      commitArgs.push("-p", head);
    }
    const commit = (await execOrThrow("git", commitArgs, { cwd: repo, env })).stdout.trim();

    const ref = `${SNAPSHOT_REF_PREFIX}/${Date.now()}-${commit.slice(0, 7)}`;
    await execOrThrow("git", ["update-ref", ref, commit], { cwd: repo });

    return { commit, ref };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/** Remove every snapshot ref this tool has created in `repo`. */
export async function pruneSnapshots(repo: string): Promise<number> {
  const listed = await execOrThrow(
    "git",
    ["for-each-ref", "--format=%(refname)", SNAPSHOT_REF_PREFIX],
    { cwd: repo },
  );
  const refs = listed.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  for (const ref of refs) {
    await execOrThrow("git", ["update-ref", "-d", ref], { cwd: repo });
  }
  return refs.length;
}
