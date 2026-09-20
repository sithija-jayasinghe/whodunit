#!/usr/bin/env bash
# Create a throwaway repo with a known regression, for testing culprit by hand.
#
#   ./test/make-fixture.sh            -> creates /tmp/culprit-fixture
#   ./test/make-fixture.sh /some/path -> creates it there
#
# The repo ends up with a passing commit at HEAD and a broken working tree,
# which is exactly the state culprit is built to investigate.
set -euo pipefail

# Resolve the repo root before we cd away from it.
CULPRIT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

DEST="${1:-/tmp/culprit-fixture}"
rm -rf "$DEST"
mkdir -p "$DEST"
cd "$DEST"

git init -q .
git config user.email fixture@example.com
git config user.name "culprit fixture"

echo '{"type":"module"}' > package.json

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

# Now make several changes the way an agent would -- most harmless, one fatal.
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

echo "Fixture ready at $DEST"
echo
echo "Try:"
echo "  cd $DEST"
echo "  node $CULPRIT_ROOT/dist/cli.js doctor -- node test.js"
