# culprit

**Find which single change broke your test.**

An AI agent just changed 14 files. Your test is red. Instead of reading a diff
you did not write, run:

```bash
culprit -- npm test auth.test.ts
```

culprit splits the change into individual hunks and binary-searches them against
your failing test until it finds the smallest set that still reproduces the
failure. It does not guess — it proves the answer by running your test.

```
Found 31 changes across 14 files
Confirming test fails... yes

Searching:
  [1/5]  16 changes  ->  FAIL
  [2/5]   8 changes  ->  FAIL
  [3/5]   4 changes  ->  PASS
  [4/5]   2 changes  ->  FAIL
  [5/5]   1 change   ->  FAIL

Found it. 1 change out of 31:

  src/auth/token.ts, line 42

  -  const expiry = Date.now() + ttl * 1000
  +  const expiry = Date.now() + ttl
```

## Why not just use rewind?

Claude Code and Cursor can undo a whole change. That throws away the thirteen
good files to remove the one bad line, and it never tells you what was wrong.
culprit keeps the good and isolates the bad.

An AI can also *read* the diff and guess the cause. Sometimes it is right.
culprit runs the test, so when it names a change it has watched the test pass
without it and fail with it.

## How it works

It is [delta debugging](https://en.wikipedia.org/wiki/Delta_debugging)
(Zeller's ddmin) applied to diff hunks rather than to program input.

A plain binary search is not enough, because hunks are not independent —
applying half a change often will not compile. ddmin handles that with a third
outcome, `unresolved`, and widens granularity instead of giving up.

Everything happens in a throwaway `git worktree` under your temp directory.
**Your real working tree is never modified.**

## Status

Early. Built in phases:

| Phase | What | Status |
|---|---|---|
| 1 | Snapshot, sandbox, test runner, `doctor` | done |
| 2 | Diff splitter, subset apply | next |
| 3 | ddmin search | |
| 4 | Report and CLI polish | |
| 5 | MCP server, so agents can call it | |

Phase 1 is usable today via `culprit doctor`, which verifies that your baseline
passes and your current tree fails — the precondition for any search.

## Install

```bash
npm install
npm run build
```

Then run it locally:

```bash
node dist/cli.js doctor -- npm test
```

Or during development, without building:

```bash
npx tsx src/cli.ts doctor -- npm test
```

## Usage

```
culprit [options] -- <test command>

COMMANDS
  doctor    Check that the baseline passes and the current tree fails.
  prune     Delete every snapshot ref culprit created in this repo.

OPTIONS
  --since <ref>     Baseline to compare against. Default: HEAD
  --timeout <ms>    Kill a test run after this long.
  --link <path>     Extra gitignored path to link into the sandbox. Repeatable.
```

### The sandbox and your dependencies

A fresh worktree has no `node_modules`, so a test command would fail for the
boring reason that its dependencies are missing. culprit symlinks these in from
your real project: `node_modules`, `.venv`, `venv`, `vendor/bundle`. Add more
with `--link`.

These links are shared with the real project, so a test suite that *writes* to
one of them writes through. Keep `--link` to dependency caches.

## Requirements

- Node 20+
- Git 2.5+ (for `git worktree`)
- A test command that exits 0 when things are fine

No runtime dependencies.

## License

MIT
