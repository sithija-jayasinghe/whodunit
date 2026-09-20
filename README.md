# whodunit

**Find which single change broke your test.**

An AI agent just changed 14 files. Your test is red. Instead of reading a diff
you did not write, run:

```bash
whodunit -- npm test auth.test.ts
```

whodunit splits the change into individual hunks and binary-searches them against
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
whodunit keeps the good and isolates the bad.

An AI can also *read* the diff and guess the cause. Sometimes it is right.
whodunit runs the test, so when it names a change it has watched the test pass
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
| 2 | Diff splitter, subset apply | done |
| 3 | ddmin search | next |
| 4 | Report and CLI polish | |
| 5 | MCP server, so agents can call it | |

Two commands work today:

- `whodunit doctor -- <test command>` verifies that your baseline passes and
  your current tree fails — the precondition for any search.
- `whodunit hunks` lists the individual changes the search will bisect.

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
whodunit [options] -- <test command>

COMMANDS
  doctor    Check that the baseline passes and the current tree fails.
  hunks     List the individual changes the search would bisect.
  prune     Delete every snapshot ref whodunit created in this repo.

OPTIONS
  --since <ref>     Baseline to compare against. Default: HEAD
  --timeout <ms>    Kill a test run after this long.
  --context <n>     Diff context lines. Default: 3
  --link <path>     Extra gitignored path to link into the sandbox. Repeatable.
```

### The sandbox and your dependencies

A fresh worktree has no `node_modules`, so a test command would fail for the
boring reason that its dependencies are missing. whodunit symlinks these in from
your real project: `node_modules`, `.venv`, `venv`, `vendor/bundle`. Add more
with `--link`.

These links are shared with the real project, so a test suite that *writes* to
one of them writes through. Keep `--link` to dependency caches.

## Known limits

**A rewritten file is one hunk.** Git emits a single hunk when a change has no
surviving context, so whodunit can narrow a full-file rewrite to the file but
not to a line within it. Lowering `--context` helps only when some context
survives.

**Binary files and mode changes cannot be split.** They are included or
excluded whole.

**It needs a fast, deterministic test.** The search runs your test command
several times. Point it at the single failing test, not the whole suite.

**A flaky test will produce a wrong answer confidently.** whodunit trusts the
exit code. If your test fails intermittently, the result is meaningless.

## Requirements

- Node 20+
- Git 2.5+ (for `git worktree`)
- A test command that exits 0 when things are fine

No runtime dependencies.

## License

MIT
