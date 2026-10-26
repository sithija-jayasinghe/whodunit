#!/usr/bin/env bash
# Build a harder practice repo for trying whodunit with a real AI agent.
#
#   ./test/make-playground-hard.sh               -> ~/whodunit-playground-hard
#   ./test/make-playground-hard.sh /some/path    -> creates it there
#
# Like make-playground.sh, but the "cleanup" spans fifteen files and dozens of
# hunks, most of them rewriting comparisons and numbers into named constants.
# One of those rewrites is subtly wrong. The failing test names an order
# total, not the file, so reading the diff is slow and easy to get wrong.
#
# Running the script again resets it.
set -euo pipefail

DEST="${1:-$HOME/whodunit-playground-hard}"
rm -rf "$DEST"
mkdir -p "$DEST/src"
cd "$DEST"

git init -q .
git config user.email playground@example.com
git config user.name "whodunit playground"

echo '{ "name": "orders", "type": "module", "scripts": { "test": "node test.js" } }' > package.json

# ---------------------------------------------------------------- baseline --

cat > src/round.js <<'EOF'
export function roundCents(amount) {
  return Math.round(amount * 100) / 100;
}
EOF

cat > src/cart.js <<'EOF'
export function lineTotal(item) {
  return item.price * item.quantity;
}

export function subtotal(items) {
  let sum = 0;
  for (const item of items) {
    sum += lineTotal(item);
  }
  return sum;
}
EOF

cat > src/bulk.js <<'EOF'
import { roundCents } from "./round.js";

export function isBulk(quantity) {
  return quantity >= 10;
}

export function bulkSavings(items) {
  let savings = 0;
  for (const item of items) {
    if (isBulk(item.quantity)) {
      savings += item.price * item.quantity * 0.05;
    }
  }
  return roundCents(savings);
}
EOF

cat > src/tiers.js <<'EOF'
export function tierFor(points) {
  if (points >= 1000) return "gold";
  if (points >= 500) return "silver";
  return "bronze";
}

export function tierDiscountPercent(tier) {
  if (tier === "gold") return 10;
  if (tier === "silver") return 5;
  return 0;
}
EOF

cat > src/coupons.js <<'EOF'
const COUPONS = { SAVE5: 5, WELCOME10: 10 };

export function couponPercent(code) {
  if (!code) return 0;
  return COUPONS[code] || 0;
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

cat > src/dates.js <<'EOF'
export function isWeekend(date) {
  const day = date.getUTCDay();
  return day === 0 || day === 6;
}
EOF

cat > src/shipping.js <<'EOF'
export function shipping(amount, weekend) {
  if (amount >= 100) return 0;
  if (weekend) return 7.99;
  return 5.99;
}
EOF

cat > src/inventory.js <<'EOF'
export function inStock(item, stock) {
  return (stock[item.sku] || 0) >= item.quantity;
}

export function missingItems(items, stock) {
  return items.filter((item) => !inStock(item, stock)).map((item) => item.sku);
}
EOF

cat > src/validate.js <<'EOF'
export function validateItem(item) {
  if (typeof item.price !== "number" || item.price < 0) return "bad price";
  if (!Number.isInteger(item.quantity) || item.quantity < 1) return "bad quantity";
  return null;
}
EOF

cat > src/currency.js <<'EOF'
import { roundCents } from "./round.js";

export function convert(amount, code) {
  if (code === "EUR") return roundCents(amount * 0.92);
  if (code === "GBP") return roundCents(amount * 0.79);
  return amount;
}
EOF

cat > src/format.js <<'EOF'
export function formatMoney(amount) {
  return "$" + amount.toFixed(2);
}
EOF

cat > src/invoice.js <<'EOF'
import { subtotal } from "./cart.js";
import { bulkSavings } from "./bulk.js";
import { tierFor, tierDiscountPercent } from "./tiers.js";
import { couponPercent } from "./coupons.js";
import { discount } from "./discount.js";
import { tax } from "./tax.js";
import { shipping } from "./shipping.js";
import { isWeekend } from "./dates.js";
import { roundCents } from "./round.js";

export function invoice(items, options = {}) {
  const points = options.points || 0;
  const taxRate = options.taxRate || 0;
  const date = options.date || new Date();
  const sub = subtotal(items);
  const bulk = bulkSavings(items);
  const percent = tierDiscountPercent(tierFor(points)) + couponPercent(options.coupon);
  const off = discount(sub - bulk, percent);
  const net = sub - bulk - off;
  const taxed = tax(net, taxRate);
  const ship = shipping(net, isWeekend(date));
  return { subtotal: sub, bulk, discount: off, tax: taxed, shipping: ship, total: roundCents(net + taxed + ship) };
}
EOF

cat > src/receipt.js <<'EOF'
import { formatMoney } from "./format.js";

export function receiptLines(items, inv) {
  const lines = [];
  for (const item of items) {
    lines.push(item.quantity + " x " + item.sku + "  " + formatMoney(item.price * item.quantity));
  }
  lines.push("Subtotal  " + formatMoney(inv.subtotal));
  lines.push("Total  " + formatMoney(inv.total));
  return lines;
}
EOF

cat > test.js <<'EOF'
import { invoice } from "./src/invoice.js";
import { formatMoney } from "./src/format.js";
import { tierFor } from "./src/tiers.js";
import { couponPercent } from "./src/coupons.js";
import { missingItems } from "./src/inventory.js";
import { validateItem } from "./src/validate.js";
import { convert } from "./src/currency.js";
import { receiptLines } from "./src/receipt.js";

let failed = 0;
function check(label, actual, expected) {
  if (actual !== expected) {
    console.error(`FAIL ${label}: expected ${expected}, got ${actual}`);
    failed++;
  }
}

const wednesday = new Date("2026-03-04T12:00:00Z");
const saturday = new Date("2026-03-07T12:00:00Z");

const office = [
  { sku: "PAPER", price: 4.25, quantity: 10 },
  { sku: "PENS", price: 2.4, quantity: 3 },
  { sku: "STAPLER", price: 18.5, quantity: 1 },
];
const officeInvoice = invoice(office, { points: 620, coupon: "SAVE5", taxRate: 0.0825, date: wednesday });
check("office order total", formatMoney(officeInvoice.total), "$70.36");

const home = [{ sku: "LAMP", price: 39.99, quantity: 2 }];
const homeInvoice = invoice(home, { taxRate: 0.0825, date: saturday });
check("home order total", formatMoney(homeInvoice.total), "$94.57");
check("home order weekend shipping", homeInvoice.shipping, 7.99);

const studio = [{ sku: "DESK", price: 249, quantity: 1 }];
check("studio order total", formatMoney(invoice(studio, { points: 1200, taxRate: 0.0825, date: wednesday }).total), "$242.59");

check("tier at 500 points", tierFor(500), "silver");
check("tier at 1000 points", tierFor(1000), "gold");
check("unknown coupon", couponPercent("NOPE"), 0);
check("missing stock", missingItems(office, { PAPER: 10, PENS: 2, STAPLER: 1 }).join(","), "PENS");
check("valid item", validateItem(office[0]), null);
check("rejects zero quantity", validateItem({ price: 1, quantity: 0 }) !== null, true);
check("euro conversion", convert(100, "EUR"), 92);
check("receipt length", receiptLines(office, officeInvoice).length, 5);

if (failed > 0) process.exit(1);
console.log("all order tests passed");
EOF

git add -A
git commit -qm "Order module with tests"

# ------------------------------------------------- the agent's cleanup ------
# Fifteen files. Every change is a plausible tidy-up, and all but one keep the
# behavior exactly the same.

cat > src/round.js <<'EOF'
/** Round a money amount to whole cents. */
export function roundCents(amount) {
  return Math.round(amount * 100) / 100;
}
EOF

cat > src/cart.js <<'EOF'
/** Price of one line: unit price times quantity. */
export function lineTotal(item) {
  return item.price * item.quantity;
}

/** Sum of every line in the cart. */
export function subtotal(items) {
  return items.reduce((sum, item) => sum + lineTotal(item), 0);
}
EOF

cat > src/bulk.js <<'EOF'
import { roundCents } from "./round.js";

const BULK_MIN_QUANTITY = 10;
const BULK_RATE = 0.05;

/** True when a line is large enough for the bulk rate. */
export function isBulk(quantity) {
  return quantity > BULK_MIN_QUANTITY;
}

/** Savings from the bulk rate across every qualifying line. */
export function bulkSavings(items) {
  let savings = 0;
  for (const item of items) {
    if (isBulk(item.quantity)) {
      savings += item.price * item.quantity * BULK_RATE;
    }
  }
  return roundCents(savings);
}
EOF

cat > src/tiers.js <<'EOF'
const GOLD_MIN_POINTS = 1000;
const SILVER_MIN_POINTS = 500;

/** Loyalty tier for a points balance. */
export function tierFor(points) {
  if (points >= GOLD_MIN_POINTS) return "gold";
  if (points >= SILVER_MIN_POINTS) return "silver";
  return "bronze";
}

const TIER_DISCOUNT_PERCENT = { gold: 10, silver: 5 };

/** Discount percentage that comes with a tier. */
export function tierDiscountPercent(tier) {
  return TIER_DISCOUNT_PERCENT[tier] ?? 0;
}
EOF

cat > src/coupons.js <<'EOF'
const COUPONS = new Map([
  ["SAVE5", 5],
  ["WELCOME10", 10],
]);

/** Percent off for a coupon code. Unknown or missing codes give 0. */
export function couponPercent(code) {
  if (!code) return 0;
  return COUPONS.get(code) ?? 0;
}
EOF

cat > src/discount.js <<'EOF'
import { roundCents } from "./round.js";

/** A percentage of an amount, in currency units. */
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

cat > src/dates.js <<'EOF'
const SUNDAY = 0;
const SATURDAY = 6;

/** True on Saturday or Sunday, in UTC. */
export function isWeekend(date) {
  return [SUNDAY, SATURDAY].includes(date.getUTCDay());
}
EOF

cat > src/shipping.js <<'EOF'
const FREE_SHIPPING_MIN = 100;
const WEEKEND_RATE = 7.99;
const STANDARD_RATE = 5.99;

/** Shipping cost for an order amount. Free from the threshold up. */
export function shipping(amount, weekend) {
  if (amount >= FREE_SHIPPING_MIN) return 0;
  return weekend ? WEEKEND_RATE : STANDARD_RATE;
}
EOF

cat > src/inventory.js <<'EOF'
/** True when the stock covers the whole line. */
export function inStock(item, stock) {
  const available = stock[item.sku] ?? 0;
  return available >= item.quantity;
}

/** SKUs of the lines the stock cannot cover. */
export function missingItems(items, stock) {
  return items.filter((item) => !inStock(item, stock)).map(({ sku }) => sku);
}
EOF

cat > src/validate.js <<'EOF'
const MIN_QUANTITY = 1;

/** An error message for a malformed line, or null when it is fine. */
export function validateItem(item) {
  const priceOk = typeof item.price === "number" && item.price >= 0;
  if (!priceOk) return `bad price for ${item.sku ?? "item"}`;
  const quantityOk = Number.isInteger(item.quantity) && item.quantity >= MIN_QUANTITY;
  if (!quantityOk) return `bad quantity for ${item.sku ?? "item"}`;
  return null;
}
EOF

cat > src/currency.js <<'EOF'
import { roundCents } from "./round.js";

const RATES = { EUR: 0.92, GBP: 0.79 };

/** Convert a USD amount to another currency. Unknown codes are left as USD. */
export function convert(amount, code) {
  const rate = RATES[code];
  return rate === undefined ? amount : roundCents(amount * rate);
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
import { bulkSavings } from "./bulk.js";
import { tierFor, tierDiscountPercent } from "./tiers.js";
import { couponPercent } from "./coupons.js";
import { discount } from "./discount.js";
import { tax } from "./tax.js";
import { shipping } from "./shipping.js";
import { isWeekend } from "./dates.js";
import { roundCents } from "./round.js";

/** Build an invoice: every saving, the tax, the shipping and the total. */
export function invoice(items, { points = 0, taxRate = 0, date = new Date(), coupon } = {}) {
  const sub = subtotal(items);
  const bulk = bulkSavings(items);
  const loyaltyPercent = tierDiscountPercent(tierFor(points));
  const off = discount(sub - bulk, loyaltyPercent + couponPercent(coupon));
  const net = sub - bulk - off;
  const taxed = tax(net, taxRate);
  const ship = shipping(net, isWeekend(date));
  return {
    subtotal: sub,
    bulk,
    discount: off,
    tax: taxed,
    shipping: ship,
    total: roundCents(net + taxed + ship),
  };
}
EOF

cat > src/receipt.js <<'EOF'
import { formatMoney } from "./format.js";

/** Printable receipt lines: one per item, then the subtotal and total. */
export function receiptLines(items, inv) {
  const itemLines = items.map(
    ({ sku, price, quantity }) => `${quantity} x ${sku}  ${formatMoney(price * quantity)}`,
  );
  return [...itemLines, `Subtotal  ${formatMoney(inv.subtotal)}`, `Total  ${formatMoney(inv.total)}`];
}
EOF

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

echo "Hard playground ready at $DEST"
echo "  git diff --stat   shows the agent's cleanup"
echo "  node test.js      fails"
