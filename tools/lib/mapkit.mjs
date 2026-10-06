// Build small test maps and demos as PWAD bytes, without a node builder.
//
// A map with no NODES is legal: R_RenderBSPNode, R_PointInSubsector and
// P_CrossBSPNode all treat numnodes == 0 as "everything is subsector 0".  So
// buildMap puts every seg in one subsector, in linedef order, and the renderer
// draws them in that order -- list linedefs nearest-first wherever one hides
// another.  Collision uses the blockmap built here, sight crosses the one
// subsector's segs, and neither needs a convex sector.
//
//   import { pwad, buildMap, demoLump } from './lib/mapkit.mjs';
//   const map = buildMap({ vertices, sectors, sides, lines, things });
//   const bytes = pwad([['MAP01', Buffer.alloc(0)], ...map, ['DEMO', demo]]);
// Copyright (C) 2026, GPL-2.0-or-later.

const name8 = s => { const b = Buffer.alloc(8); b.write(s.toUpperCase().slice(0, 8), 'ascii'); return b; };

// [[name, Buffer], ...] -> PWAD bytes
export function pwad(lumps) {
    const body = Buffer.concat(lumps.map(([, b]) => b));
    const dirOfs = 12 + body.length;
    const out = Buffer.alloc(dirOfs + 16 * lumps.length);
    out.write('PWAD', 0, 'ascii');
    out.writeInt32LE(lumps.length, 4);
    out.writeInt32LE(dirOfs, 8);
    body.copy(out, 12);
    let at = 12, e = dirOfs;
    for (const [n, b] of lumps) {
        out.writeInt32LE(at, e);
        out.writeInt32LE(b.length, e + 4);
        name8(n).copy(out, e + 8);
        at += b.length; e += 16;
    }
    return out;
}

// The ten map lumps, after the marker, for:
//   vertices: [[x, y], ...]
//   sectors:  [{ floor, ceil, floorpic, ceilpic, light, special = 0, tag = 0 }, ...]
//   sides:    [{ sector, top = '-', bottom = '-', mid = '-', xoff = 0, yoff = 0 }, ...]
//   lines:    [{ v1, v2, front, back = -1, flags = 1, special = 0, tag = 0 }, ...]
//             (the front side is on the right walking v1 -> v2)
//   things:   [{ x, y, angle = 0, type, flags = 7 }, ...]
export function buildMap({ vertices, sectors, sides, lines, things }) {
    const rec = (n, size, fill) => { const b = Buffer.alloc(n * size); for (let i = 0; i < n; i++) fill(b, i * size, i); return b; };

    const THINGS = rec(things.length, 10, (b, o, i) => {
        const t = things[i];
        b.writeInt16LE(t.x, o); b.writeInt16LE(t.y, o + 2); b.writeInt16LE(t.angle ?? 0, o + 4);
        b.writeInt16LE(t.type, o + 6); b.writeInt16LE(t.flags ?? 7, o + 8);
    });
    const LINEDEFS = rec(lines.length, 14, (b, o, i) => {
        const l = lines[i];
        b.writeInt16LE(l.v1, o); b.writeInt16LE(l.v2, o + 2); b.writeInt16LE(l.flags ?? 1, o + 4);
        b.writeInt16LE(l.special ?? 0, o + 6); b.writeInt16LE(l.tag ?? 0, o + 8);
        b.writeInt16LE(l.front, o + 10); b.writeInt16LE(l.back ?? -1, o + 12);
    });
    const SIDEDEFS = rec(sides.length, 30, (b, o, i) => {
        const s = sides[i];
        b.writeInt16LE(s.xoff ?? 0, o); b.writeInt16LE(s.yoff ?? 0, o + 2);
        name8(s.top ?? '-').copy(b, o + 4); name8(s.bottom ?? '-').copy(b, o + 12); name8(s.mid ?? '-').copy(b, o + 20);
        b.writeInt16LE(s.sector, o + 28);
    });
    const VERTEXES = rec(vertices.length, 4, (b, o, i) => { b.writeInt16LE(vertices[i][0], o); b.writeInt16LE(vertices[i][1], o + 2); });
    const SECTORS = rec(sectors.length, 26, (b, o, i) => {
        const s = sectors[i];
        b.writeInt16LE(s.floor, o); b.writeInt16LE(s.ceil, o + 2);
        name8(s.floorpic).copy(b, o + 4); name8(s.ceilpic).copy(b, o + 12);
        b.writeInt16LE(s.light, o + 20); b.writeInt16LE(s.special ?? 0, o + 22); b.writeInt16LE(s.tag ?? 0, o + 24);
    });

    // one seg per side present: side 0 runs v1 -> v2, side 1 back again
    const segs = [];
    lines.forEach((l, i) => {
        segs.push([l.v1, l.v2, i, 0]);
        if ((l.back ?? -1) !== -1) segs.push([l.v2, l.v1, i, 1]);
    });
    const SEGS = rec(segs.length, 12, (b, o, i) => {
        const [a, z, ld, side] = segs[i];
        const [x1, y1] = vertices[a], [x2, y2] = vertices[z];
        const bam = Math.round(Math.atan2(y2 - y1, x2 - x1) / (2 * Math.PI) * 65536) & 0xffff;
        b.writeInt16LE(a, o); b.writeInt16LE(z, o + 2); b.writeUInt16LE(bam, o + 4);
        b.writeInt16LE(ld, o + 6); b.writeInt16LE(side, o + 8); b.writeInt16LE(0, o + 10);
    });
    const SSECTORS = Buffer.alloc(4);
    SSECTORS.writeInt16LE(segs.length, 0);
    SSECTORS.writeInt16LE(0, 2);
    const REJECT = Buffer.alloc(Math.ceil(sectors.length * sectors.length / 8));

    // every line in every 128-unit block its bounding box touches (a line
    // listed in a block it misses only costs a test)
    const xs = vertices.map(v => v[0]), ys = vertices.map(v => v[1]);
    const ox = Math.min(...xs) - 8, oy = Math.min(...ys) - 8;
    const w = ((Math.max(...xs) - ox) >> 7) + 1, h = ((Math.max(...ys) - oy) >> 7) + 1;
    const lists = Array.from({ length: w * h }, () => []);
    lines.forEach((l, i) => {
        const [x1, y1] = vertices[l.v1], [x2, y2] = vertices[l.v2];
        for (let by = (Math.min(y1, y2) - oy) >> 7; by <= (Math.max(y1, y2) - oy) >> 7; by++)
            for (let bx = (Math.min(x1, x2) - ox) >> 7; bx <= (Math.max(x1, x2) - ox) >> 7; bx++)
                lists[by * w + bx].push(i);
    });
    const words = [ox, oy, w, h, ...new Array(w * h).fill(0)];
    lists.forEach((list, b) => { words[4 + b] = words.length; words.push(...list, -1); });
    const BLOCKMAP = Buffer.alloc(words.length * 2);
    words.forEach((v, i) => BLOCKMAP.writeInt16LE(v, 2 * i));

    return [['THINGS', THINGS], ['LINEDEFS', LINEDEFS], ['SIDEDEFS', SIDEDEFS], ['VERTEXES', VERTEXES],
            ['SEGS', SEGS], ['SSECTORS', SSECTORS], ['NODES', Buffer.alloc(0)], ['SECTORS', SECTORS],
            ['REJECT', REJECT], ['BLOCKMAP', BLOCKMAP]];
}

// A v1.9 demo.  tics: [[cmd for each player in game], ...] with cmd
// { forward = 0, side = 0, turn = 0, buttons = 0 }.
export function demoLump({ skill = 2, episode = 1, map = 1, deathmatch = 0, players = 1, tics }) {
    const head = [109, skill, episode, map, deathmatch, 0, 0, 0, 0];
    for (let i = 0; i < 4; i++) head.push(i < players ? 1 : 0);
    const body = [];
    for (const cmds of tics)
        for (const c of cmds) body.push(c.forward ?? 0, c.side ?? 0, c.turn ?? 0, c.buttons ?? 0);
    return Buffer.from([...head, ...body.map(v => v & 0xff), 0x80]);
}
