#!/usr/bin/env bash
# Create a throwaway repo with a known regression, for testing whodunit by hand.
#
#   ./test/make-fixture.sh                 -> small case in /tmp/whodunit-fixture
#   ./test/make-fixture.sh /some/path      -> creates it there
#   ./test/make-fixture.sh /some/path big  -> agent-sized change, one culprit
#
# The repo ends up with a passing commit at HEAD and a broken working tree,
# which is exactly the state whodunit is built to investigate.
set -euo pipefail

# Resolve the repo root before we cd away from it.
WHODUNIT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

DEST="${1:-/tmp/whodunit-fixture}"
SIZE="${2:-small}"
rm -rf "$DEST"
mkdir -p "$DEST"
cd "$DEST"

git init -q .
git config user.email fixture@example.com
git config user.name "whodunit fixture"

echo '{"type":"module"}' > package.json

if [ "$SIZE" = "big" ]; then
  mkdir -p src

  # The generator lives outside the repo so it never lands in a commit.
  GEN="$(mktemp -t whodunit-gen-XXXXXX)"
  cat > "$GEN" <<'PYEOF'
import sys

MODULES = 12
FUNCS = 3
stage = sys.argv[1]

# Twelve modules of three functions each. Stage "after" is the agent's turn:
# it touches every module and breaks exactly one function.
for m in range(1, MODULES + 1):
    lines = []
    for f in range(1, FUNCS + 1):
        n = m * 10 + f
        lines.append("export function calc%d_%d(input) {" % (m, f))
        if stage == "after":
            lines.append("  // normalized in refactor pass")
            if m == 7 and f == 2:
                lines.append("  const scaled = input * %d;" % n)  # the culprit
            else:
                lines.append("  const scaled = input * %d + %d;" % (n, f))
            lines.append("  return scaled;")
        else:
            lines.append("  return input * %d + %d;" % (n, f))
        lines.append("}")
        lines.append("")
    open("src/mod%d.js" % m, "w").write("\n".join(lines) + "\n")

if stage != "before":
    sys.exit(0)

imports, checks = [], []
for m in range(1, MODULES + 1):
    names = ", ".join("calc%d_%d" % (m, f) for f in range(1, FUNCS + 1))
    imports.append("import { %s } from './src/mod%d.js';" % (names, m))
    for f in range(1, FUNCS + 1):
        n = m * 10 + f
        checks.append("check('calc%d_%d', calc%d_%d(2), %d);" % (m, f, m, f, 2 * n + f))

open("test.js", "w").write(
    "\n".join(imports)
    + """

let failed = 0;
function check(label, actual, expected) {
  if (actual !== expected) {
    console.error(`FAIL ${label}: got ${actual}, expected ${expected}`);
    failed++;
  }
}

"""
    + "\n".join(checks)
    + """

if (failed > 0) process.exit(1);
console.log("ok");
"""
)
PYEOF

  python3 "$GEN" before
  git add -A
  git commit -qm "green: everything passes"

  python3 "$GEN" after
  rm -f "$GEN"
  echo "# refactor notes" > NOTES.md

  echo "Fixture ready at $DEST"
  echo "  12 files changed. The culprit is calc7_2 in src/mod7.js."
else
  cat > sum.js <<'JS'
export function sum(a, b) {
  return a + b;
}
JS

  cat > greet.js <<'JS'
export function greet(name) {
  return `Hello, ${name}!`;
}
JS

  cat > test.js <<'JS'
import { sum } from "./sum.js";
import { greet } from "./greet.js";

let failed = 0;
function check(label, actual, expected) {
  if (actual !== expected) {
    console.error(`FAIL ${label}: got ${actual}, expected ${expected}`);
    failed++;
  }
}

check("sum", sum(2, 3), 5);
check("greet", greet("world"), "Hello, world!");

if (failed > 0) process.exit(1);
console.log("ok");
JS

  git add -A
  git commit -qm "green: everything passes"

  # Several changes the way an agent would -- most harmless, one fatal.
  cat > sum.js <<'JS'
export function sum(a, b) {
  // harmless: added a comment
  return a - b;
}
JS

  cat > greet.js <<'JS'
export function greet(name) {
  // harmless: same output, different style
  return "Hello, " + name + "!";
}
JS

  echo "# fixture" > NOTES.md

  echo "Fixture ready at $DEST  (the culprit is sum.js)"
fi

echo
echo "Try:"
echo "  cd $DEST"
echo "  node $WHODUNIT_ROOT/dist/cli.js -- node test.js"
