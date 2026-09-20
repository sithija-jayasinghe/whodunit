export type { Hunk, FilePatch, Outcome, TestResult } from "./types.js";
export { snapshotWorkingTree, pruneSnapshots } from "./git/snapshot.js";
export { createSandbox, DEFAULT_LINKED_PATHS } from "./git/worktree.js";
export type { Sandbox, SandboxOptions } from "./git/worktree.js";
export { runTest, DEFAULT_TEST_TIMEOUT_MS } from "./runner/test.js";
export { repoRoot, resolveRef, isDirty, hasCommits } from "./git/repo.js";
export { checkPreconditions } from "./commands/doctor.js";
export type { PreconditionReport } from "./commands/doctor.js";
