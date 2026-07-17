#!/usr/bin/env node
// ledger-count.mjs — parse §14 master verdict ledger and count rows per verdict.
// Usage: node tools/archaeology/ledger-count.mjs

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { resolve, dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const docPath = resolve(__dirname, '../../docs/engine-archaeology.md');
const text = readFileSync(docPath, 'utf8');

// Extract §14 table section
const match = text.match(/## 14\. Master verdict ledger[\s\S]*$/);
if (!match) {
  console.error('Could not find §14 section');
  process.exit(1);
}
const section = match[0];

const counts = { recipe: 0, equivalence: 0, irreducible: 0, declarative: 0 };
let total = 0;

for (const line of section.split('\n')) {
  // Match table data rows: start with '|' and contain a **verdict** cell
  if (!line.startsWith('|') || line.startsWith('| blob') || line.startsWith('|---')) continue;
  // Look for verdict keywords (bolded)
  if (/\*\*recipe\*\*/.test(line))       { counts.recipe++;      total++; }
  else if (/\*\*equivalence\*\*/.test(line)) { counts.equivalence++; total++; }
  else if (/\*\*irreducible\*\*/.test(line)) { counts.irreducible++; total++; }
  else if (/\*\*declarative\*\*/.test(line)) { counts.declarative++; total++; }
  else if (line.startsWith('|')) {
    // Data row with no recognised verdict — flag it
    console.warn('WARN: unclassified row:', line.slice(0, 80));
  }
}

console.log(`Total ledger rows: ${total}`);
console.log(`  recipe      : ${counts.recipe}`);
console.log(`  equivalence : ${counts.equivalence}`);
console.log(`  irreducible : ${counts.irreducible}`);
console.log(`  declarative : ${counts.declarative}`);
console.log(`  sum         : ${Object.values(counts).reduce((a, b) => a + b, 0)}`);

// Validate that sum == total
const sum = Object.values(counts).reduce((a, b) => a + b, 0);
if (sum !== total) {
  console.error(`ERROR: sum of verdicts (${sum}) !== total rows (${total})`);
  process.exit(1);
}
console.log('OK: counts consistent.');

// CLAIMS_JSON footer (task 6.3) — engine-archaeology.md §14 verdict ledger:
//   ea-029 total rows, ea-030..ea-033 the per-verdict category totals.
console.log(`CLAIMS_JSON ${JSON.stringify({
  'ea-029': String(total),
  'ea-030': String(counts.recipe),
  'ea-031': String(counts.equivalence),
  'ea-032': String(counts.irreducible),
  'ea-033': String(counts.declarative),
})}`);
