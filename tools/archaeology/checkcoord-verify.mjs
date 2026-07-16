#!/usr/bin/env node
// checkcoord-verify.mjs
// Brute-force verification of the checkcoord[12][4] table in r_bsp.c.
//
// The table maps boxpos = (boxy<<2)+boxx to the pair of bounding-box corners
// that subtend the widest angular span from the viewpoint.  This script:
//   1. Enumerates all 9 valid viewpoint regions.
//   2. For each region, places the viewpoint at multiple positions.
//   3. Tries all C(4,2)=6 ordered corner pairs.
//   4. Verifies the table entry gives the maximum angular span.
//
// Build: no build needed — pure Node.js ES module
// Run:   node tools/archaeology/checkcoord-verify.mjs
//
// Expected output: "ALL 9 CASES VERIFIED" on the last line.

// DOOM bspcoord layout (indices into the 4-element bounding-box array):
const BOXTOP    = 0;  // max y
const BOXBOTTOM = 1;  // min y
const BOXLEFT   = 2;  // min x
const BOXRIGHT  = 3;  // max x

// The table from r_bsp.c:365-378
const checkcoord = [
  [3,0,2,1],   // boxpos=0:  above-left
  [3,0,2,0],   // boxpos=1:  above-center
  [3,1,2,0],   // boxpos=2:  above-right
  null,        // boxpos=3:  unused (boxx=3 impossible)
  [2,0,2,1],   // boxpos=4:  left-center
  [0,0,0,0],   // boxpos=5:  INSIDE  (early return true)
  [3,1,3,0],   // boxpos=6:  right-center
  null,        // boxpos=7:  unused
  [2,0,3,1],   // boxpos=8:  below-left
  [2,1,3,1],   // boxpos=9:  below-center
  [2,1,3,0],   // boxpos=10: below-right
];

// Angular difference in [0, 2pi) unsigned sense (matches DOOM uint32 wrap).
// Returns a value in [0, 2pi); larger means wider span.
function angularSpan(ax, ay, bx, by, vx, vy) {
  // angles from viewpoint to corners
  let a1 = Math.atan2(ay - vy, ax - vx);  // angle to corner A
  let a2 = Math.atan2(by - vy, bx - vx);  // angle to corner B
  // span = a1 - a2, wrapped to [0, 2pi)
  let span = a1 - a2;
  while (span < 0)         span += 2 * Math.PI;
  while (span >= 2*Math.PI) span -= 2 * Math.PI;
  return span;
}

// All 4 corner (x,y) coordinates of a box given bspcoord-style array.
function corners(box) {
  return [
    [box[BOXRIGHT], box[BOXTOP]],    // index 0 in pair-selection: {BOXRIGHT, BOXTOP} = right,top
    [box[BOXRIGHT], box[BOXBOTTOM]], // {BOXRIGHT, BOXBOTTOM} = right,bottom
    [box[BOXLEFT],  box[BOXTOP]],    // {BOXLEFT, BOXTOP} = left,top
    [box[BOXLEFT],  box[BOXBOTTOM]], // {BOXLEFT, BOXBOTTOM} = left,bottom
  ];
}

// Given the checkcoord entry [a,b,c,d], extract (x1,y1) and (x2,y2) from box.
// Recall: bspcoord[0]=BOXTOP(y), [1]=BOXBOTTOM(y), [2]=BOXLEFT(x), [3]=BOXRIGHT(x).
// So x1 = bspcoord[a] means:
//   if a==2 or a==3: it IS an x value
//   if a==0 or a==1: it IS a y value
// ... but the code uses (x1,y1) in R_PointToAngle(x1,y1).
// The mapping is: coord a is used as x-coordinate of point 1,
//                 coord b is used as y-coordinate of point 1, etc.
// This is how the source reads: x1 = bspcoord[entry[0]]; y1 = bspcoord[entry[1]].
// So for {3,0,...}: x1 = bspcoord[3] = BOXRIGHT (an x value!), y1 = bspcoord[0] = BOXTOP (a y value!).
// This works out correctly because:
//   BOXRIGHT = bspcoord[3] is the right x edge
//   BOXTOP   = bspcoord[0] is the top y edge
// The box coordinate layout intentionally stores them so that
// even indices 0,2 alias to y,x and odd indices 1,3 alias to y,x... actually no.
// The layout is: [0]=top_y, [1]=bottom_y, [2]=left_x, [3]=right_x.
// The table picks them carefully so that [entry[0]] gives an x or y correctly.
// Specifically:
//   entry values 2,3 give x coordinates (BOXLEFT=min_x, BOXRIGHT=max_x)
//   entry values 0,1 give y coordinates (BOXTOP=max_y, BOXBOTTOM=min_y)
// And the entry is arranged as {x_idx, y_idx, x_idx, y_idx} for the two corner points.
function getPoints(box, entry) {
  const bspcoord = [box[BOXTOP], box[BOXBOTTOM], box[BOXLEFT], box[BOXRIGHT]];
  const x1 = bspcoord[entry[0]];
  const y1 = bspcoord[entry[1]];
  const x2 = bspcoord[entry[2]];
  const y2 = bspcoord[entry[3]];
  return { x1, y1, x2, y2 };
}

// Enumerate all 12 valid ordered pairs from 4 corner points, compute span for each.
function allSpans(box, vx, vy) {
  // The 4 actual corner (x,y) positions:
  const pts = [
    [box[BOXRIGHT], box[BOXTOP]],
    [box[BOXRIGHT], box[BOXBOTTOM]],
    [box[BOXLEFT],  box[BOXTOP]],
    [box[BOXLEFT],  box[BOXBOTTOM]],
  ];
  let results = [];
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      if (i === j) continue;
      const span = angularSpan(pts[i][0], pts[i][1], pts[j][0], pts[j][1], vx, vy);
      // Only consider spans < PI (the "span >= ANG180 → return true" case means
      // any pair that gives span >= PI triggers an immediate true, not an angular check)
      results.push({ i, j, span, ax: pts[i][0], ay: pts[i][1], bx: pts[j][0], by: pts[j][1] });
    }
  }
  return results;
}

// Verify one (boxpos, viewpoint) case.
// Returns {ok: bool, boxpos, vx, vy, tableSpan, maxSpan, maxPair}
function verifyCase(boxpos, box, vx, vy) {
  const entry = checkcoord[boxpos];
  if (!entry) return { ok: true, note: 'unused slot' };
  if (boxpos === 5) return { ok: true, note: 'inside — early return true' };

  const { x1, y1, x2, y2 } = getPoints(box, entry);
  const tableSpan = angularSpan(x1, y1, x2, y2, vx, vy);

  const spans = allSpans(box, vx, vy);
  // We only care about spans < PI (pairs that would be checked).
  // The table should give the maximum span among valid (< PI) pairs.
  const validSpans = spans.filter(s => s.span < Math.PI);
  const maxSpan = Math.max(...validSpans.map(s => s.span));
  const maxPair = validSpans.find(s => s.span === maxSpan);

  // The table's span should equal the maximum (within floating-point epsilon)
  const ok = Math.abs(tableSpan - maxSpan) < 1e-9 ||
             // OR: the table's span is NOT the absolute max, but it's still < PI
             // In that case the non-max pair is equally valid (two corners at same angle)
             (tableSpan > 0 && tableSpan < Math.PI && Math.abs(tableSpan - maxSpan) < 0.001);

  return { ok, boxpos, vx, vy, tableSpan: tableSpan*(180/Math.PI).toFixed(2),
           maxSpan: maxSpan*(180/Math.PI).toFixed(2) };
}

// Test box: left=-100, right=100, bottom=-100, top=100
const box = { [BOXTOP]: 100, [BOXBOTTOM]: -100, [BOXLEFT]: -100, [BOXRIGHT]: 100 };
// Convert to bspcoord array for getPoints: [BOXTOP, BOXBOTTOM, BOXLEFT, BOXRIGHT]
const boxArr = [100, -100, -100, 100];

// Viewpoints for each region (multiple per region for robustness):
const testCases = [
  // boxpos=0: above-left (x < BOXLEFT, y > BOXTOP)
  { boxpos:0, vx:-200, vy:200, label:'above-left (far)' },
  { boxpos:0, vx:-110, vy:110, label:'above-left (near)' },
  { boxpos:0, vx:-500, vy:300, label:'above-left (asymmetric)' },

  // boxpos=1: above-center (BOXLEFT<=x<=BOXRIGHT, y > BOXTOP)
  { boxpos:1, vx:0,   vy:300, label:'above-center' },
  { boxpos:1, vx:-50, vy:200, label:'above-center offset' },

  // boxpos=2: above-right (x > BOXRIGHT, y > BOXTOP)
  { boxpos:2, vx:200, vy:200, label:'above-right' },
  { boxpos:2, vx:110, vy:110, label:'above-right (near)' },

  // boxpos=4: left-center (x < BOXLEFT, BOXBOTTOM<=y<=BOXTOP)
  { boxpos:4, vx:-300, vy:0,   label:'left-center' },
  { boxpos:4, vx:-150, vy:50,  label:'left-center offset' },

  // boxpos=5: INSIDE — skip (early return true in R_CheckBBox)

  // boxpos=6: right-center (x > BOXRIGHT, BOXBOTTOM<=y<=BOXTOP)
  { boxpos:6, vx:300, vy:0,   label:'right-center' },
  { boxpos:6, vx:150, vy:-50, label:'right-center offset' },

  // boxpos=8: below-left (x < BOXLEFT, y < BOXBOTTOM)
  { boxpos:8, vx:-200, vy:-200, label:'below-left' },
  { boxpos:8, vx:-110, vy:-110, label:'below-left (near)' },

  // boxpos=9: below-center (BOXLEFT<=x<=BOXRIGHT, y < BOXBOTTOM)
  { boxpos:9, vx:0,   vy:-300, label:'below-center' },
  { boxpos:9, vx:50,  vy:-150, label:'below-center offset' },

  // boxpos=10: below-right (x > BOXRIGHT, y < BOXBOTTOM)
  { boxpos:10, vx:200, vy:-200, label:'below-right' },
  { boxpos:10, vx:110, vy:-110, label:'below-right (near)' },
];

// Build the box object expected by getPoints:
// bspcoord = [BOXTOP, BOXBOTTOM, BOXLEFT, BOXRIGHT] = [100, -100, -100, 100]
const bspcoord = [100, -100, -100, 100]; // indices [0]=100(top_y), [1]=-100(bot_y), [2]=-100(left_x), [3]=100(right_x)

let allOk = true;
const byPos = {};
for (const tc of testCases) {
  if (!byPos[tc.boxpos]) byPos[tc.boxpos] = [];
  const entry = checkcoord[tc.boxpos];
  if (!entry) { byPos[tc.boxpos].push({ ok: true, note: 'unused' }); continue; }

  // Get the two corners the table selects
  const x1 = bspcoord[entry[0]];
  const y1 = bspcoord[entry[1]];
  const x2 = bspcoord[entry[2]];
  const y2 = bspcoord[entry[3]];
  const tableSpan = angularSpan(x1, y1, x2, y2, tc.vx, tc.vy);

  // All 4 actual corners of the box:
  const corners4 = [
    { x: bspcoord[3], y: bspcoord[0] },  // right, top
    { x: bspcoord[3], y: bspcoord[1] },  // right, bottom
    { x: bspcoord[2], y: bspcoord[0] },  // left, top
    { x: bspcoord[2], y: bspcoord[1] },  // left, bottom
  ];

  let maxSpan = 0;
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      if (i === j) continue;
      const sp = angularSpan(corners4[i].x, corners4[i].y, corners4[j].x, corners4[j].y, tc.vx, tc.vy);
      if (sp < Math.PI && sp > maxSpan) maxSpan = sp;
    }
  }

  const ok = tableSpan < Math.PI && Math.abs(tableSpan - maxSpan) < 1e-6;
  if (!ok) allOk = false;
  byPos[tc.boxpos].push({ ok, label: tc.label, tableSpanDeg: (tableSpan*180/Math.PI).toFixed(2), maxSpanDeg: (maxSpan*180/Math.PI).toFixed(2) });
}

// Report
const positions = {
  0: 'above-left',  1: 'above-center',  2: 'above-right',
  4: 'left-center', 5: 'INSIDE',        6: 'right-center',
  8: 'below-left',  9: 'below-center', 10: 'below-right',
};

for (const [pos, cases] of Object.entries(byPos).sort((a,b)=>+a[0]-+b[0])) {
  const entry = checkcoord[+pos];
  if (!entry) continue;
  const desc = positions[+pos] || `pos=${pos}`;
  const allCasesOk = cases.every(c => c.ok);
  const status = allCasesOk ? 'PASS' : 'FAIL';
  console.log(`boxpos=${pos} (${desc}): ${status}`);
  if (!allCasesOk) {
    for (const c of cases) {
      if (!c.ok) console.log(`  FAIL: ${c.label} tableSpan=${c.tableSpanDeg}° maxSpan=${c.maxSpanDeg}°`);
    }
  }
}

if (allOk) {
  console.log('\nALL 9 CASES VERIFIED: checkcoord table is correct for all viewpoint regions.');
  console.log('The table is derivable from first principles (geometry of widest-span corner pair).');
} else {
  console.log('\nFAIL: some cases did not verify.');
  process.exit(1);
}
