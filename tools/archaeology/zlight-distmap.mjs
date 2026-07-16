#!/usr/bin/env node
// zlight-distmap.mjs
// Tabulates the zlight falloff curve for DISTMAP=1,2,3 at a median light level.
// Reproduces the exact integer arithmetic from r_main.c R_InitLightTables.
//
// Key constants (r_main.h / r_main.c):
//   LIGHTLEVELS = 16, MAXLIGHTZ = 128, NUMCOLORMAPS = 32
//   LIGHTZSHIFT = 20, LIGHTSCALESHIFT = 12
//   SCREENWIDTH = 320  (SCREENWIDTH/2 = 160)
//   DISTMAP = 2  (the canon value; this script tabulates 1,2,3 for comparison)
//
// Run: node tools/archaeology/zlight-distmap.mjs

const LIGHTLEVELS    = 16;
const MAXLIGHTZ      = 128;
const NUMCOLORMAPS   = 32;
const LIGHTZSHIFT    = 20;
const LIGHTSCALESHIFT = 12;
const SCREENWIDTH    = 320;
const FRACBITS       = 16;
const FRACUNIT       = 1 << FRACBITS;

// FixedDiv: integer fixed-point division. Returns (a/b)*FRACUNIT (as integer).
// Uses BigInt to avoid overflow on the 32-bit inputs.
function FixedDiv(a, b) {
  return Number((BigInt(a) * BigInt(FRACUNIT)) / BigInt(b));
}

// Compute the colormap index for zlight[i][j] with a given DISTMAP value.
function zlight_level(i, j, distmap) {
  const startmap = Math.floor(((LIGHTLEVELS - 1 - i) * 2) * NUMCOLORMAPS / LIGHTLEVELS);
  const scale_fp = FixedDiv(
    (SCREENWIDTH / 2) * FRACUNIT,
    (j + 1) << LIGHTZSHIFT
  );
  const scale = scale_fp >> LIGHTSCALESHIFT;
  let level = startmap - Math.floor(scale / distmap);
  if (level < 0) level = 0;
  if (level >= NUMCOLORMAPS) level = NUMCOLORMAPS - 1;
  return level;
}

// Print table for a given light sector index.
// i=15 → brightest sector (startmap=0), i=8 → median (startmap=28), i=0 → darkest (startmap=60)
function printTable(i) {
  const startmap = Math.floor(((LIGHTLEVELS - 1 - i) * 2) * NUMCOLORMAPS / LIGHTLEVELS);
  console.log(`\nzlight colormap index vs distance  (light index i=${i}, startmap=${startmap})`);
  console.log('colormap 0=full bright, 31=fully dark\n');
  console.log('  j  | dist (units) | DISTMAP=1 | DISTMAP=2 | DISTMAP=3');
  console.log('-----|--------------|-----------|-----------|----------');

  const rows = [0, 1, 2, 3, 4, 7, 9, 15, 23, 31, 47, 63, 79, 95, 111, 127];
  for (const j of rows) {
    const dist = (j + 1) * 16; // world units: (j+1) << (LIGHTZSHIFT - FRACBITS) = (j+1)<<4
    const d1 = zlight_level(i, j, 1);
    const d2 = zlight_level(i, j, 2);
    const d3 = zlight_level(i, j, 3);
    const bar1 = '#'.repeat(d1);
    const bar2 = '#'.repeat(d2);
    const bar3 = '#'.repeat(d3);
    console.log(`${String(j).padStart(4)} | ${String(dist).padStart(12)} | ${String(d1).padStart(9)} | ${String(d2).padStart(9)} | ${String(d3).padStart(8)}`);
  }
}

// Print bright-floor distances: j value where level first departs from 0
function printFloorDist(distmap) {
  console.log(`\nFor DISTMAP=${distmap}: distance at which each light level first darkens (colormap index > 0):`);
  for (let i = 15; i >= 0; i--) {
    let firstDark = -1;
    for (let j = MAXLIGHTZ - 1; j >= 0; j--) {
      if (zlight_level(i, j, distmap) === 0) { firstDark = j; break; }
    }
    const dist = firstDark >= 0 ? `${(firstDark + 1) * 16}+ units (j=${firstDark})` : 'always bright';
    console.log(`  i=${String(i).padStart(2)} startmap=${String(Math.floor(((LIGHTLEVELS-1-i)*2)*NUMCOLORMAPS/LIGHTLEVELS)).padStart(2)}: full-bright within ${dist}`);
  }
}

console.log('=== zlight falloff curve: DISTMAP comparison ===');
console.log('Distance in map units = (j+1) * 16.  j=0 → 16 units, j=127 → 2048 units.');
printTable(8);   // median light level

console.log('\n=== Full-bright distance boundary by light level ===');
printFloorDist(1);
printFloorDist(2);
printFloorDist(3);

console.log('\n=== Canon DISTMAP=2 summary ===');
console.log('LIGHTZSHIFT=20 encodes: j=0 → 16 world units, j=127 → 2048 world units.');
console.log('DISTMAP=2: moderate falloff slope.  DISTMAP=1 is 2× steeper; DISTMAP=3 is 1.5× gentler.');
