# whodunit

[![CI](https://github.com/sithija-jayasinghe/whodunit/actions/workflows/ci.yml/badge.svg)](https://github.com/sithija-jayasinghe/whodunit/actions/workflows/ci.yml)

**Find which single change broke your test.**

An AI agent just changed 12 files. Your test is red. Instead of reading a diff
you did not write, run:

```bash
whodunit -- node test.js
```

whodunit splits the change into individual hunks and searches them against
your failing test until it finds the smallest set that still reproduces the
failure. It does not guess — it proves the answer by running your test.

```
  Snapshotting working tree...
  Testing baseline (37 changes to search)...
  Confirming the current tree fails...
  Searching...
    [ 1]   19 of 37   PASS
    [ 2]   18 of 37   FAIL
    [ 3]    9 of 18   PASS
    [ 4]    9 of 18   FAIL
    [ 5]    5 of 9    FAIL
    [ 6]    3 of 5    FAIL
    [ 7]    2 of 3    FAIL
    [ 8]    1 of 2    PASS
    [ 9]    1 of 2    FAIL

  Found it. 1 change out of 37:

  src/mod7.js, line 7

    -  return input * 72 + 2;
    +  // normalized in refactor pass
    +  const scaled = input * 72;
    +  return scaled;

  Proven: the test passes without this change and fails with it.
  11 test runs in 1.1s.
```

That is real output, from the fixture `test/make-fixture.sh` builds.

## Why not just use rewind?

Claude Code and Cursor can undo a whole change. That throws away the good files
to remove the one bad line, and it never tells you what was wrong. whodunit
keeps the good and isolates the bad.

An AI can also *read* the diff and guess the cause. Sometimes it is right.
whodunit runs the test, so when it names a change it has watched the test pass
without it and fail with it.

## How it works

It is [delta debugging](https://en.wikipedia.org/wiki/Delta_debugging)
(Zeller's ddmin) applied to diff hunks rather than to program input.

A plain binary search is not enough, because hunks are not independent —
applying half a change often will not compile, and a failure can need two
changes together. ddmin handles that with a third outcome, `unresolved`, and
widens granularity instead of giving up.

Everything happens in a throwaway `git worktree` under your temp directory.
**Your real working tree is never modified**, and the sandbox is removed when
the run ends — including when you press Ctrl+C.

## Install

```bash
npm install -g whodunit
```

Or run it without installing, as `npx whodunit -- <test command>`.

From a clone instead:

```bash
npm install
npm run build
npm link
```

`npm link` puts your checkout's `whodunit` on your PATH. To run it without
linking, use `node dist/cli.js` in its place, or `npx tsx src/cli.ts` to skip
the build.

## Usage

Start with `doctor`. It runs your test twice, once at the baseline and once on
your current tree, and tells you whether there is anything to search:

```bash
whodunit doctor -- npm test auth.test.ts
```

Then search:

```bash
whodunit -- npm test auth.test.ts
```

Point it at the one failing test, not the whole suite. The search runs it many
times.

```
whodunit [options] -- <test command>

COMMANDS
  doctor    Check that the baseline passes and the current tree fails,
            without searching. Use this first.
  hunks     List the individual changes the search would bisect.
  prune     Delete snapshot refs left behind by a run that crashed or
            was force-killed. Normal runs clean up after themselves.
  mcp       Run as an MCP server on stdio, so an agent can call the
            search, doctor and hunks as tools.

OPTIONS
  --since <ref>     Baseline to compare against. Default: HEAD
  --timeout <ms>    Kill a test run after this long. Default: 600000 (10 min)
  --context <n>     Diff context lines. Higher values make Git merge
                    nearby changes into one hunk. Default: 1
  --max-probes <n>  Give up after this many search runs, not counting the
                    two initial checks. Default: 60
  --skip-exit-code <n>
                    Treat this exit code as "cannot test this state", e.g.
                    when the build fails. Repeatable. 125 always counts,
                    as in git bisect run.
  --link <path>     Extra gitignored path to link into the sandbox.
                    Repeatable. node_modules, .venv, venv and vendor/bundle
                    are linked already.
  --verbose         Print the output of every test run.
  --json            Print one JSON object instead of text, for scripts and
                    agents. With --verbose it includes test output.
  -h, --help        Show this help
  -v, --version     Show version
```

The baseline is `HEAD` by default, so whodunit searches your uncommitted
changes. To search the last commit as well, use `--since HEAD~1`.

### Exit codes

| Code | Meaning |
|---|---|
| 0 | Found the culprit (or `doctor`: ready to search) |
| 1 | Nothing to search: the baseline already fails, the current tree passes, or a run could not be judged |
| 2 | Bad usage: an unknown option or an invalid value |
| 130 / 143 | Interrupted by Ctrl+C / SIGTERM, after cleaning up |

### When a combination does not build

Leaving some hunks out can break the build — a function used but no longer
defined. That exits non-zero just like a real failure, and the search would
blame the hunk that broke the *build* instead of the one that broke the *test*.

Exit **125** to say "cannot judge this state", the same convention as
`git bisect run`:

```bash
whodunit -- sh -c 'npm run build || exit 125; npm test auth.test.ts'
```

If your tool already uses a different exit code for build errors, pass it with
`--skip-exit-code`. A timeout also counts as "cannot judge", and the timeout
kills everything the test started, not just the top process.

### Seeing what the test printed

`--verbose` prints each run's output under the line that started it:

```
    [ 2]    1 of 3    FAIL
           | FAIL sum: got -1, expected 5
```

### JSON output

`--json` works with the search, `doctor`, `hunks` and `prune`. stdout is then
exactly one JSON document, so a script or an agent can parse it without
scraping text:

```bash
whodunit --json -- npm test auth.test.ts
```

```json
{
  "schema": 1,
  "command": "run",
  "searchable": true,
  "reason": "Search completed.",
  "totalChanges": 37,
  "culprits": [
    { "file": "src/mod7.js", "line": 7, "added": 3, "removed": 1,
      "patch": "@@ -5,3 +7,5 @@ ..." }
  ],
  "minimal": true,
  "testRuns": 11
}
```

Abridged: the full object also has the commits, timings and each hunk's id.
Add `--verbose` to include the stdout and stderr of the baseline and current
runs. Errors are JSON too (`{ "schema": 1, "error": "..." }`), and the exit
codes are the same as without `--json`. `schema` goes up only when a field is
removed or changes meaning.

### As an MCP server, for agents

`whodunit mcp` serves the search over the
[Model Context Protocol](https://modelcontextprotocol.io), so a coding agent
can find the change that broke a test on its own, right after making it.

With Claude Code:

```bash
claude mcp add whodunit -- npx -y whodunit mcp
```

Any other MCP client takes the same command, `npx -y whodunit mcp`, over
stdio. If whodunit is installed globally, `whodunit mcp` works too.

It exposes three tools:

| Tool | Does |
|---|---|
| `whodunit_search` | The search. Returns the same object as `--json`. |
| `whodunit_doctor` | The two precondition runs, without searching. |
| `whodunit_hunks` | Lists the changes. Runs no tests. |

Each takes `cwd`, the repository to work in, and the search and doctor take
`command` as an argument list such as `["npm", "test", "auth.test.ts"]`. It is
not run through a shell; use `["sh", "-c", "..."]` when you need one. The other
options match the CLI flags.

Searches report progress as they go. Cancelling a call stops its search at
once: the running test is killed and the sandbox removed. Closing the
connection does the same for every search still running. The server speaks both
the current protocol (`2026-07-28`) and the earlier `initialize`-based versions
back to `2024-11-05`, and has no dependencies beyond Node.

### The sandbox and your dependencies

A fresh worktree has no `node_modules`, so a test command would fail for the
boring reason that its dependencies are missing. whodunit symlinks these in from
your real project: `node_modules`, `.venv`, `venv`, `vendor/bundle`. Add more
with `--link`.

These links are shared with the real project, so a test suite that *writes* to
one of them writes through. Keep `--link` to dependency caches.

## Known limits

**A brand-new file is one change.** There is no baseline to bisect against, so
it is included or excluded whole. Same for a file rewritten so completely that
no line survives. This is fundamental, not a setting.

**Binary files and mode changes cannot be split.** Included or excluded whole.

**It needs a fast, deterministic test.** The search runs your test command
many times. Point it at the single failing test, not the whole suite.

**A flaky test produces a confident wrong answer.** whodunit trusts the exit
code. If your test fails intermittently, the result is meaningless.

**Windows is untested.** whodunit is developed on macOS, and the sandbox
relies on symlinks, which Windows restricts by default.

## How many test runs it takes

One culprit is cheap: the count grows with the logarithm of the number of
changes. Two that only fail together are not — ddmin is quadratic in the worst
case, which is why there is a budget.

| Changes | 1 culprit | 2 that only fail together |
|---|---|---|
| 10 | 7 (at most 8) | 18 (at most 28) |
| 30 | 9 (at most 11) | 32 (at most 37) |
| 100 | 12 (at most 15) | 45 (at most 54) |
| 300 | 14 (at most 18) | 55 (at most 67) |

Typical (median) test runs, including the two initial checks, with the worst
case seen in brackets. Measured by running the search against simulated tests,
across every culprit position and 300 random pairs.

The default `--max-probes 60` covers all of these except the worst pairs among
hundreds of changes. When the budget runs out you still get a real failing
set, reported as "narrowed to" rather than "found it", because it was not
proven minimal.

## A note on context lines

Git merges hunks whose context windows overlap, so the `--context` setting
decides how finely a change can be split. This matters more than it sounds.

Thirty independent edits to thirty adjacent functions:

| Context | Hunks |
|---|---|
| `-U3` (Git's default) | 1 |
| `-U1` (whodunit's default) | 30 |

At Git's default the whole file is one unsplittable change. That is why
whodunit defaults to `--context 1`.

Zero is the floor: it splits no more finely than 1, and `git apply` rejects
zero-context patches unless given `--unidiff-zero`, which disables the
placement check that stops a hunk landing in the wrong place.

## Status

| Phase | What | Status |
|---|---|---|
| 1 | Snapshot, sandbox, test runner, `doctor` | done |
| 2 | Diff splitter, subset apply | done |
| 3 | ddmin search | done |
| 4 | Report and CLI: `--verbose`, `--json`, skip codes, clean interrupts | done |
| 5 | MCP server, so agents can call it | done |

## Requirements

- Node 20+
- Git 2.17+ (for `git worktree remove`)
- A test command that exits 0 when things are fine

No runtime dependencies.

## License

MIT
