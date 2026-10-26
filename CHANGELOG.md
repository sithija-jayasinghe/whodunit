# Changelog

All notable changes to whodunit are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/). Until 1.0, a minor version may
change behavior.

## [0.1.1] - 2026-10-26

The first release on npm, and otherwise identical to 0.1.0.

0.1.0 could not be published: an unrelated package named `whodunit` released
that version in 2015 before being removed, and npm never lets a version number
be reused. The `v0.1.0` tag in git marks the same code.

## [0.1.0] - 2026-10-26

The first release. Tagged in git, not published to npm (see 0.1.1).

### Added

- `whodunit -- <test command>`: splits the working tree's changes into hunks
  and runs delta debugging (Zeller's ddmin) against the failing test until it
  proves the smallest set of changes that still fails.
- `doctor`, to check that the baseline passes and the current tree fails before
  searching; `hunks`, to list the changes; `prune`, to remove snapshot refs left
  by a crashed run.
- Every candidate state is built in a throwaway `git worktree`. The real
  working tree is never modified.
- Exit code 125 means "cannot test this state", as in `git bisect run`, so a
  combination that does not build is skipped instead of blamed.
  `--skip-exit-code` adds more codes.
- `--timeout` kills the test and every process it started.
- `--verbose` prints each test run's output.
- `--json` prints one JSON document, for scripts and agents. Errors are JSON
  too.
- `--since`, `--context`, `--max-probes` and `--link` options.
- `whodunit mcp`: an MCP server on stdio exposing `whodunit_search`,
  `whodunit_doctor` and `whodunit_hunks`. It speaks the `2026-07-28` protocol
  and the earlier `initialize`-based versions back to `2024-11-05`, reports
  progress, and stops a search when the client cancels it.
- Ctrl+C, SIGTERM, and an MCP client disconnecting all stop the running test
  and remove the sandbox before exiting.
- No runtime dependencies.

[0.1.1]: https://github.com/sithija-jayasinghe/whodunit/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/sithija-jayasinghe/whodunit/releases/tag/v0.1.0
