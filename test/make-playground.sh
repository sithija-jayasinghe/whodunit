#!/usr/bin/env bash
# Build a practice repo for trying whodunit with a real AI agent.
#
#   ./test/make-playground.sh                  -> ~/whodunit-playground
#   ./test/make-playground.sh /some/path       -> creates it there
#
# The repo is a small invoicing module with a passing test at HEAD. On top of
# that sits an uncommitted "cleanup" across seven files, the kind of change an
# agent makes. One edit in it quietly breaks the invoice total. The failing
# test names the total, not the file that broke it.
#
# It also writes .mcp.json, so Claude Code offers the whodunit MCP server when
# a session is opened in the folder. Running the script again resets it.
set -euo pipefail

DEST="${1:-$HOME/whodunit-playground}"
rm -rf "$DEST"
mkdir -p "$DEST/src"
cd "$DEST"

git init -q .
git config user.email playground@example.com
git config user.name "whodunit playground"

echo '{ "name": "invoicing", "type": "module", "scripts": { "test": "node test.js" } }' > package.json

# ---------------------------------------------------------------- baseline --

cat > src/round.js <<'EOF'
export function roundCents(amount) {
  return Math.round(amount * 100) / 100;
}
EOF

cat > src/cart.js <<'EOF'
export function subtotal(items) {
  let sum = 0;
  for (const item of items) {
    sum += item.price * item.quantity;
  }
  return sum;
}
EOF

cat > src/discount.js <<'EOF'
import { roundCents } from "./round.js";

export function discount(amount, percent) {
  if (percent <= 0) return 0;
  return roundCents((amount * percent) / 100);
}
EOF

cat > src/tax.js <<'EOF'
import { roundCents } from "./round.js";

export function tax(amount, rate) {
  return roundCents(amount * rate);
}
EOF

cat > src/shipping.js <<'EOF'
export function shipping(amount) {
  if (amount >= 100) return 0;
  return 5.99;
}
EOF

cat > src/format.js <<'EOF'
export function formatMoney(amount) {
  return "$" + amount.toFixed(2);
}
EOF

cat > src/invoice.js <<'EOF'
import { subtotal } from "./cart.js";
import { discount } from "./discount.js";
import { tax } from "./tax.js";
import { shipping } from "./shipping.js";
import { roundCents } from "./round.js";

export function invoice(items, { discountPercent = 0, taxRate = 0 } = {}) {
  const sub = subtotal(items);
  const off = discount(sub, discountPercent);
  const taxed = tax(sub - off, taxRate);
  const ship = shipping(sub - off);
  return { subtotal: sub, discount: off, tax: taxed, shipping: ship, total: roundCents(sub - off + taxed + ship) };
}
EOF

cat > test.js <<'EOF'
import { invoice } from "./src/invoice.js";
import { formatMoney } from "./src/format.js";

let failed = 0;
function check(label, actual, expected) {
  if (actual !== expected) {
    console.error(`FAIL ${label}: expected ${expected}, got ${actual}`);
    failed++;
  }
}

const items = [
  { name: "Keyboard", price: 49.99, quantity: 1 },
  { name: "Headphones", price: 39.95, quantity: 1 },
];

const small = invoice(items, { discountPercent: 10, taxRate: 0.0825 });
check("small order total", formatMoney(small.total), "$93.62");
check("small order ships for a fee", small.shipping, 5.99);

const large = invoice([{ name: "Monitor", price: 189, quantity: 1 }], { taxRate: 0.0825 });
check("large order total", formatMoney(large.total), "$204.59");
check("large order ships free", large.shipping, 0);

if (failed > 0) process.exit(1);
console.log("all invoice tests passed");
EOF

git add -A
git commit -qm "Invoicing module with tests"

# ------------------------------------------------- the agent's cleanup ------
# Seven files touched. Six edits are harmless refactors. One is not.

cat > src/round.js <<'EOF'
/**
 * Round a money amount to whole cents.
 * Uses truncation to avoid floating point drift on repeated rounding.
 */
export function roundCents(amount) {
  return Math.trunc(amount * 100) / 100;
}
EOF

cat > src/cart.js <<'EOF'
/** Sum of price times quantity over every line item. */
export function subtotal(items) {
  return items.reduce((sum, item) => sum + item.price * item.quantity, 0);
}
EOF

cat > src/discount.js <<'EOF'
import { roundCents } from "./round.js";

/** Percentage discount, in currency units. */
export function discount(amount, percent) {
  if (!percent || percent <= 0) return 0;
  const fraction = percent / 100;
  return roundCents(amount * fraction);
}
EOF

cat > src/tax.js <<'EOF'
import { roundCents } from "./round.js";

/**
 * Sales tax on an amount.
 * @param {number} rate e.g. 0.0825 for 8.25%
 */
export function tax(amount, rate) {
  if (rate < 0) throw new RangeError("Tax rate cannot be negative");
  return roundCents(amount * rate);
}
EOF

cat > src/shipping.js <<'EOF'
const FREE_SHIPPING_THRESHOLD = 100;
const FLAT_RATE = 5.99;

export function shipping(amount) {
  return amount >= FREE_SHIPPING_THRESHOLD ? 0 : FLAT_RATE;
}
EOF

cat > src/format.js <<'EOF'
const CURRENCY_SYMBOL = "$";

/** Format a number as a currency string with two decimals. */
export function formatMoney(amount) {
  return `${CURRENCY_SYMBOL}${amount.toFixed(2)}`;
}
EOF

cat > src/invoice.js <<'EOF'
import { subtotal } from "./cart.js";
import { discount } from "./discount.js";
import { tax } from "./tax.js";
import { shipping } from "./shipping.js";
import { roundCents } from "./round.js";

/** Build an invoice: subtotal, discount, tax, shipping and total. */
export function invoice(items, { discountPercent = 0, taxRate = 0 } = {}) {
  const sub = subtotal(items);
  const off = discount(sub, discountPercent);
  const afterDiscount = sub - off;
  const taxed = tax(afterDiscount, taxRate);
  const ship = shipping(afterDiscount);
  return {
    subtotal: sub,
    discount: off,
    tax: taxed,
    shipping: ship,
    total: roundCents(afterDiscount + taxed + ship),
  };
}
EOF

# Lets Claude Code find the server. Ignored by git, so it is not part of the
# "agent's change" the search looks at.
cat > .mcp.json <<'EOF'
{
  "mcpServers": {
    "whodunit": {
      "command": "npx",
      "args": ["-y", "whodunit@latest", "mcp"]
    }
  }
}
EOF
echo ".mcp.json" >> .git/info/exclude

echo "Playground ready at $DEST"
echo "  git diff --stat   shows the agent's cleanup"
echo "  node test.js      fails"
