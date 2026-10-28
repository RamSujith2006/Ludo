/* Board geometry for Ludo (2-10 players).
 *
 * Three visual layouts:
 *   - Classic square cross (4 players, seg=13, L=52)
 *   - Hexagonal / polygon   (5-6 players)
 *   - Circular              (2-3 and 7-10 players)
 *
 * Pure functions with no DOM access so the layout can be unit-tested in Node.
 * Coordinates live in a 1000x1000 viewBox centred on (0, 0).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LudoBoard = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const COLORS = ['#e5484d', '#3b82f6', '#22a559', '#f5b301', '#8e4ec6',
                  '#f76b15', '#06b6d4', '#ec4899', '#8b5e3c', '#475569'];
  const INK = ['#ffffff', '#ffffff', '#ffffff', '#2b2100', '#ffffff',
               '#ffffff', '#00323d', '#ffffff', '#ffffff', '#ffffff'];
  const NAMES = ['Red', 'Blue', 'Green', 'Yellow', 'Purple',
                 'Orange', 'Cyan', 'Pink', 'Brown', 'Slate'];

  const R = 322;            // ring radius (circular)
  const HUB = 72;           // centre hub radius
  const YARD_DIST = R + 92;
  const YARD_R = 66;
  const LANE = 4;

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const cellAngle = (c, L) => (2 * Math.PI * c) / L - Math.PI / 2;
  const polar = (r, a) => ({ x: r * Math.cos(a), y: r * Math.sin(a) });

  function yardSlots(k) {
    switch (k) {
      case 1: return [[0, -8]];
      case 2: return [[-20, -8], [20, -8]];
      case 3: return [[-20, -24], [20, -24], [0, 6]];
      default: return [[-20, -24], [20, -24], [-20, 6], [20, 6]];
    }
  }
  function shorten(s, max) {
    s = String(s);
    return s.length > max ? s.slice(0, max - 1) + '\u2026' : s;
  }
  function escapeXml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  }

  // ========================= CIRCULAR LAYOUT (2-3, 7-10 players) =========================

  function layoutCircular(n, seg, k) {
    const L = seg * n, HOME = L + LANE;
    const spacing = (2 * Math.PI * R) / L;
    const cr = clamp(spacing * 0.42, 8, 20);
    const tr = Math.min(17, cr * 0.95);
    const ring = [];
    for (let c = 0; c < L; c++) ring.push(Object.assign({ a: cellAngle(c, L) }, polar(R, cellAngle(c, L))));
    const laneStep = (R - HUB - 30) / LANE;
    const lane = [], hub = [], yard = [], yardCenter = [], laneAngle = [];
    for (let s = 0; s < n; s++) {
      const entrance = (s * seg - 1 + L) % L;
      const la = cellAngle(entrance, L);
      laneAngle.push(la);
      lane.push(Array.from({ length: LANE }, (_, j) => polar(R - laneStep * (j + 1), la)));
      hub.push(Array.from({ length: k }, (_, t) => polar(28 + t * 12, la)));
      const ya = cellAngle(s * seg + (seg - 1) / 2, L);
      const yc = polar(YARD_DIST, ya);
      yardCenter.push(yc);
      yard.push(yardSlots(k).map(([dx, dy]) => ({ x: yc.x + dx, y: yc.y + dy })));
    }
    function tokenXY(seat, p, t) {
      if (p < 0) return yard[seat][t];
      if (p < L)  return ring[(seat * seg + p) % L];
      if (p < HOME) return lane[seat][p - L];
      return hub[seat][t];
    }
    return { n, seg, k, L, HOME, cr, tr, spacing, ring, lane, hub, yard,
             yardCenter, laneAngle, laneStep, tokenXY, boardType: 'circular' };
  }

  function staticSvgCircular(B, players) {
    const out = [];
    const f = v => v.toFixed(1);
    const { n, seg, L, cr, ring, lane, yardCenter, laneAngle } = B;
    const safeOff = B.safe || [0, Math.floor((seg * 5) / 8)];

    out.push('<defs><radialGradient id="felt" cx="50%" cy="45%" r="60%">' +
      '<stop offset="0" stop-color="#fffaf0"/><stop offset="1" stop-color="#f4ead2"/></radialGradient></defs>');
    out.push('<circle r="492" fill="url(#felt)" stroke="#d9c9a1" stroke-width="4"/>');
    out.push(`<circle r="${R}" fill="none" stroke="#e9dcbc" stroke-width="${f(cr * 2 + 12)}"/>`);

    // hub wedges
    for (let s = 0; s < n; s++) {
      const half = Math.PI / n;
      const a0 = laneAngle[s] - half, a1 = laneAngle[s] + half;
      const p0 = polar(HUB, a0), p1 = polar(HUB, a1);
      const large = n === 2 ? 1 : 0;
      const d = n === 2
        ? `M0 0 L${f(p0.x)} ${f(p0.y)} A${HUB} ${HUB} 0 ${large} 1 ${f(p1.x)} ${f(p1.y)} Z`
        : `M0 0 L${f(p0.x)} ${f(p0.y)} A${HUB} ${HUB} 0 0 1 ${f(p1.x)} ${f(p1.y)} Z`;
      out.push(`<path d="${d}" fill="${COLORS[s]}" opacity="0.9" stroke="#fffaf0" stroke-width="3"/>`);
    }
    out.push(`<circle r="${HUB}" fill="none" stroke="#fffaf0" stroke-width="5"/>`);
    out.push('<circle r="20" fill="#fffaf0" stroke="#d9c9a1" stroke-width="2"/>');
    out.push('<text y="1" text-anchor="middle" dominant-baseline="central" font-size="22">&#127922;</text>');

    // lane beds + lane cells
    for (let s = 0; s < n; s++) {
      const e = ring[(s * seg - 1 + L) % L];
      const end = lane[s][LANE - 1];
      out.push(`<line x1="${f(e.x)}" y1="${f(e.y)}" x2="${f(end.x)}" y2="${f(end.y)}" ` +
        `stroke="${COLORS[s]}" stroke-opacity="0.28" stroke-width="${f(cr * 2 + 6)}" stroke-linecap="round"/>`);
      for (const q of lane[s]) {
        out.push(`<circle cx="${f(q.x)}" cy="${f(q.y)}" r="${f(cr)}" fill="${COLORS[s]}" fill-opacity="0.55" stroke="${COLORS[s]}" stroke-width="2"/>`);
      }
    }

    // ring cells
    for (let c = 0; c < L; c++) {
      const q = ring[c];
      const owner = c % seg === 0 ? c / seg : -1;
      const star = safeOff.includes(c % seg);
      const fill = owner >= 0 ? COLORS[owner] : '#fffdf6';
      const stroke = owner >= 0 ? '#ffffff' : '#c9b98d';
      out.push(`<circle cx="${f(q.x)}" cy="${f(q.y)}" r="${f(cr)}" fill="${fill}" stroke="${stroke}" stroke-width="2.5"/>`);
      if (star) {
        const ink = owner >= 0 ? INK[owner] : '#c9a227';
        out.push(`<text x="${f(q.x)}" y="${f(q.y + 1)}" text-anchor="middle" dominant-baseline="central" font-size="${f(cr * 1.25)}" fill="${ink}" opacity="0.9" pointer-events="none">&#9733;</text>`);
      }
    }

    // yards
    for (let s = 0; s < n; s++) {
      const y = yardCenter[s];
      out.push(`<g id="yard-${s}" class="yard">` +
        `<circle class="yard-ring" cx="${f(y.x)}" cy="${f(y.y)}" r="${YARD_R + 6}" fill="none" stroke="${COLORS[s]}" stroke-width="0"/>` +
        `<circle cx="${f(y.x)}" cy="${f(y.y)}" r="${YARD_R}" fill="${COLORS[s]}" fill-opacity="0.22" stroke="${COLORS[s]}" stroke-width="4"/>` +
        B.yard[s].map(q => `<circle cx="${f(q.x)}" cy="${f(q.y)}" r="${f(B.tr + 3)}" fill="#fffaf0" fill-opacity="0.75" stroke="${COLORS[s]}" stroke-opacity="0.5" stroke-width="2"/>`).join('') +
        `<text class="yard-name" x="${f(y.x)}" y="${f(y.y + 46)}" text-anchor="middle" dominant-baseline="central" font-size="15" font-weight="700" fill="#3a2f12">${escapeXml(shorten(players && players[s] ? players[s].name : NAMES[s], 11))}</text>` +
        '</g>');
    }
    return out.join('');
  }

  // ========================= CLASSIC SQUARE LAYOUT (4 players) =========================

  const CC = 60; // cell size

  function cxy(row, col) { return { x: (col - 7) * CC, y: (row - 7) * CC }; }

  // 52 ring cells clockwise on 15x15 grid
  const RG = [
    [6,1],[6,2],[6,3],[6,4],[6,5],
    [5,6],[4,6],[3,6],[2,6],[1,6],[0,6],
    [0,7],
    [0,8],[1,8],[2,8],[3,8],[4,8],[5,8],
    [6,9],[6,10],[6,11],[6,12],[6,13],[6,14],
    [7,14],
    [8,14],[8,13],[8,12],[8,11],[8,10],[8,9],
    [9,8],[10,8],[11,8],[12,8],[13,8],[14,8],
    [14,7],
    [14,6],[13,6],[12,6],[11,6],[10,6],[9,6],
    [8,5],[8,4],[8,3],[8,2],[8,1],[8,0],
    [7,0],
    [6,0]
  ];

  // 4 home-lane cells per seat, moving toward centre
  const LG = [
    [[7,1],[7,2],[7,3],[7,4]],
    [[1,7],[2,7],[3,7],[4,7]],
    [[7,13],[7,12],[7,11],[7,10]],
    [[13,7],[12,7],[11,7],[10,7]]
  ];

  // gap cells between lane end and centre (visual only)
  const GAP = [
    [[7,5],[7,6]],
    [[5,7],[6,7]],
    [[7,9],[7,8]],
    [[9,7],[8,7]]
  ];

  function classicYardSlots(k) {
    switch (k) {
      case 1: return [[0, 0]];
      case 2: return [[-48, 0], [48, 0]];
      case 3: return [[-48, -34], [48, -34], [0, 34]];
      default: return [[-48, -48], [48, -48], [-48, 48], [48, 48]];
    }
  }

  function layoutClassic(n, seg, k) {
    const L = seg * n, HOME = L + LANE;
    const cr = 24, tr = 18;
    const ring = RG.map(([r, c]) => cxy(r, c));
    const lane = [], hub = [], yard = [], yardCenter = [], laneAngle = [];
    const ycGrid = [[2.5,2.5],[2.5,11.5],[11.5,11.5],[11.5,2.5]];

    for (let s = 0; s < n; s++) {
      lane.push(LG[s].map(([r, c]) => cxy(r, c)));
      const le = cxy(LG[s][LANE - 1][0], LG[s][LANE - 1][1]);
      const la = Math.atan2(le.y, le.x);
      laneAngle.push(la);
      hub.push(Array.from({ length: k }, (_, t) => ({
        x: Math.cos(la) * (22 + t * 14), y: Math.sin(la) * (22 + t * 14)
      })));
      const yc = cxy(ycGrid[s][0], ycGrid[s][1]);
      yardCenter.push(yc);
      yard.push(classicYardSlots(k).map(([dx, dy]) => ({ x: yc.x + dx, y: yc.y + dy })));
    }
    function tokenXY(seat, p, t) {
      if (p < 0) return yard[seat][t];
      if (p < L)  return ring[(seat * seg + p) % L];
      if (p < HOME) return lane[seat][p - L];
      return hub[seat][t];
    }
    return { n, seg, k, L, HOME, cr, tr, spacing: CC, ring, lane, hub, yard,
             yardCenter, laneAngle, laneStep: CC, tokenXY, boardType: 'classic' };
  }

  function staticSvgClassic(B, players) {
    const out = [];
    const f = v => v.toFixed(1);
    const { n, seg, L } = B;
    const C = CC;
    const safeOff = B.safe || [0, Math.floor((seg * 5) / 8)];
    const H = 7.5 * C;   // 450
    const aW = 3 * C;    // 180 (arm width)
    const aL = 6 * C;    // 360 (arm length)
    const yS = 6 * C;    // 360 (yard size)

    // board background
    out.push(`<rect x="${f(-H-12)}" y="${f(-H-12)}" width="${f(2*H+24)}" height="${f(2*H+24)}" rx="24" fill="#162440"/>`);
    out.push(`<rect x="${f(-H-8)}" y="${f(-H-8)}" width="${f(2*H+16)}" height="${f(2*H+16)}" rx="20" fill="none" stroke="#1e4070" stroke-width="3"/>`);

    // cross path background
    out.push(`<rect x="${f(-aW/2)}" y="${f(-H)}" width="${f(aW)}" height="${f(aL)}" fill="#fffdf6"/>`);
    out.push(`<rect x="${f(aW/2)}" y="${f(-aW/2)}" width="${f(aL)}" height="${f(aW)}" fill="#fffdf6"/>`);
    out.push(`<rect x="${f(-aW/2)}" y="${f(aW/2)}" width="${f(aW)}" height="${f(aL)}" fill="#fffdf6"/>`);
    out.push(`<rect x="${f(-H)}" y="${f(-aW/2)}" width="${f(aL)}" height="${f(aW)}" fill="#fffdf6"/>`);
    out.push(`<rect x="${f(-aW/2)}" y="${f(-aW/2)}" width="${f(aW)}" height="${f(aW)}" fill="#fffdf6"/>`);

    // yard areas
    const yardCorners = [[-H,-H],[aW/2,-H],[aW/2,aW/2],[-H,aW/2]];
    for (let s = 0; s < n; s++) {
      const [yx, yy] = yardCorners[s];
      const yc = B.yardCenter[s];
      const col = COLORS[s];
      out.push(`<g id="yard-${s}" class="yard">`);
      out.push(`<rect class="yard-ring" x="${f(yx)}" y="${f(yy)}" width="${f(yS)}" height="${f(yS)}" rx="16" fill="${col}" stroke="${col}" stroke-width="0" opacity="0.92"/>`);
      const ins = 32;
      out.push(`<rect x="${f(yx+ins)}" y="${f(yy+ins)}" width="${f(yS-2*ins)}" height="${f(yS-2*ins)}" rx="14" fill="#fffdf6" stroke="#fff" stroke-width="3"/>`);
      for (const q of B.yard[s]) {
        out.push(`<circle cx="${f(q.x)}" cy="${f(q.y)}" r="${f(B.tr+5)}" fill="#fffdf6" stroke="${col}" stroke-width="2.5" stroke-opacity="0.5"/>`);
      }
      const nm = players && players[s] ? players[s].name : NAMES[s];
      out.push(`<text class="yard-name" x="${f(yc.x)}" y="${f(yy+yS-12)}" text-anchor="middle" font-size="15" font-weight="700" fill="#fff">${escapeXml(shorten(nm, 14))}</text>`);
      out.push('</g>');
    }

    // home-lane cells
    for (let s = 0; s < n; s++) {
      for (let j = 0; j < LANE; j++) {
        const p = cxy(LG[s][j][0], LG[s][j][1]);
        out.push(`<rect x="${f(p.x-C/2)}" y="${f(p.y-C/2)}" width="${C}" height="${C}" fill="${COLORS[s]}" fill-opacity="0.38" stroke="${COLORS[s]}" stroke-width="1.5" stroke-opacity="0.4"/>`);
      }
      for (const [r, c] of GAP[s]) {
        const p = cxy(r, c);
        out.push(`<rect x="${f(p.x-C/2)}" y="${f(p.y-C/2)}" width="${C}" height="${C}" fill="${COLORS[s]}" fill-opacity="0.2" stroke="${COLORS[s]}" stroke-width="1" stroke-opacity="0.25"/>`);
      }
    }

    // ring cells
    for (let c = 0; c < L; c++) {
      const p = cxy(RG[c][0], RG[c][1]);
      const owner = c % seg === 0 ? c / seg : -1;
      const isSafe = safeOff.includes(c % seg);
      const isStart = owner >= 0;
      const fill = isStart ? COLORS[owner] : 'none';
      const stroke = isStart ? '#fff' : '#c9b98d';
      out.push(`<rect x="${f(p.x-C/2)}" y="${f(p.y-C/2)}" width="${C}" height="${C}" fill="${fill}" stroke="${stroke}" stroke-width="${isStart ? 2 : 1}"/>`);
      if (isSafe) {
        const ink = isStart ? INK[owner] : '#c9a227';
        out.push(`<text x="${f(p.x)}" y="${f(p.y+1)}" text-anchor="middle" dominant-baseline="central" font-size="${isStart ? 24 : 20}" fill="${ink}" opacity="0.9" pointer-events="none">&#9733;</text>`);
      }
    }

    // grid lines for empty cross cells
    const drawn = new Set();
    RG.forEach(([r,c]) => drawn.add(r+','+c));
    for (let s = 0; s < 4; s++) { LG[s].forEach(([r,c]) => drawn.add(r+','+c)); GAP[s].forEach(([r,c]) => drawn.add(r+','+c)); }
    for (let r = 0; r < 15; r++) {
      for (let c = 0; c < 15; c++) {
        const inCross = (r >= 6 && r <= 8) || (c >= 6 && c <= 8);
        const inYard = (r < 6 && c < 6) || (r < 6 && c > 8) || (r > 8 && c < 6) || (r > 8 && c > 8);
        if (inCross && !inYard && !drawn.has(r+','+c)) {
          const p = cxy(r, c);
          out.push(`<rect x="${f(p.x-C/2)}" y="${f(p.y-C/2)}" width="${C}" height="${C}" fill="none" stroke="#d4c6a0" stroke-width="0.7"/>`);
        }
      }
    }

    // centre hub - 4 coloured triangles
    const ch = aW / 2;
    const triVerts = [
      `M${f(-ch)} ${f(-ch)} L${f(-ch)} ${f(ch)} L0 0 Z`,
      `M${f(-ch)} ${f(-ch)} L${f(ch)} ${f(-ch)} L0 0 Z`,
      `M${f(ch)} ${f(-ch)} L${f(ch)} ${f(ch)} L0 0 Z`,
      `M${f(-ch)} ${f(ch)} L${f(ch)} ${f(ch)} L0 0 Z`
    ];
    for (let s = 0; s < n; s++) {
      out.push(`<path d="${triVerts[s]}" fill="${COLORS[s]}" opacity="0.82" stroke="#fffdf6" stroke-width="3"/>`);
    }
    out.push('<circle r="22" fill="#fffdf6" stroke="#d9c9a1" stroke-width="2"/>');
    out.push('<text y="1" text-anchor="middle" dominant-baseline="central" font-size="22">&#127922;</text>');

    // direction arrows at start cells
    const arrows = [
      { c: 0, dx: 1, dy: 0 },   // seat 0: right
      { c: 13, dx: 0, dy: 1 },  // seat 1: down
      { c: 26, dx: -1, dy: 0 }, // seat 2: left
      { c: 39, dx: 0, dy: -1 }  // seat 3: up
    ];
    for (let s = 0; s < n; s++) {
      const a = arrows[s];
      const p = cxy(RG[a.c][0], RG[a.c][1]);
      const ax = p.x + a.dx * C * 0.55;
      const ay = p.y + a.dy * C * 0.55;
      const sz = 8;
      // perpendicular
      const px = -a.dy, py = a.dx;
      const d = `M${f(ax+a.dx*sz)} ${f(ay+a.dy*sz)} L${f(ax+px*sz)} ${f(ay+py*sz)} L${f(ax-px*sz)} ${f(ay-py*sz)} Z`;
      out.push(`<path d="${d}" fill="${INK[s]}" opacity="0.7"/>`);
    }

    return out.join('');
  }

  // ========================= RADIAL LUDO BOARD (5-6 players) =========================
  // Implements the circular 6-player and 5-player board matching the reference design:
  // - Yellow canvas with crisp circular board disk
  // - 6 radial arms (Green, Purple, Orange, Red, Yellow, Blue)
  // - 6 circular yards with white dice cards and 4 colored holes
  // - Central red medallion with colored "HOME" wedges and curved transition arrows
  // - Start cells with "START" markers and pink star ★ safe cells

  function layoutHex(n, seg, k) {
    const L = seg * n, HOME = L + LANE;
    const R_BOARD = 468;
    const HUB_R = 92;
    const W = 32.5; // cell width (arm total width ~ 97.5)
    const H = 64.0; // cell length along arm
    const cr = 15;
    const tr = 14;

    const inner_r = HUB_R; // base of the arm touching hub

    // Arm angles for 6 players:
    // Green (11 o'clock = 240°), Purple (1 o'clock = 300°), Orange (3 o'clock = 0°),
    // Red (5 o'clock = 60°), Yellow (7 o'clock = 120°), Blue (9 o'clock = 180°)
    const armAngle = [];
    if (n === 6) {
      armAngle.push((240 * Math.PI) / 180); // Seat 0: Green (11 o'clock)
      armAngle.push((300 * Math.PI) / 180); // Seat 1: Purple (1 o'clock)
      armAngle.push(0);                     // Seat 2: Orange (3 o'clock)
      armAngle.push((60 * Math.PI) / 180);  // Seat 3: Red (5 o'clock)
      armAngle.push((120 * Math.PI) / 180); // Seat 4: Yellow (7 o'clock)
      armAngle.push(Math.PI);               // Seat 5: Blue (9 o'clock)
    } else {
      for (let s = 0; s < n; s++) {
        armAngle.push((2 * Math.PI * s) / n - Math.PI / 2);
      }
    }

    // Colors matching user reference image:
    // Green, Purple, Orange, Red, Yellow, Blue
    const hexColors = n === 6
      ? ['#0d8744', '#a83279', '#f17621', '#df2529', '#f2cf1d', '#2c55a5']
      : ['#0d8744', '#a83279', '#f17621', '#df2529', '#2c55a5'];
    const hexInk = n === 6
      ? ['#ffffff', '#ffffff', '#ffffff', '#ffffff', '#1e293b', '#ffffff']
      : ['#ffffff', '#ffffff', '#ffffff', '#ffffff', '#ffffff'];
    const hexNames = n === 6
      ? ['Green', 'Purple', 'Orange', 'Red', 'Yellow', 'Blue']
      : ['Green', 'Purple', 'Orange', 'Red', 'Blue'];

    // Ring cells: exactly 8 cells per arm in clockwise loop:
    // Incoming column (left side of arm looking outward):
    //   Cell 0 (Start cell): Row 5 (outer tip)
    //   Cell 1: Row 4 ("START" marker)
    //   Cell 2: Row 3
    //   Cell 3: Row 2
    // Outgoing column (right side of arm looking outward):
    //   Cell 4: Row 2
    //   Cell 5: Row 3 (Safe pink star ★ cell)
    //   Cell 6: Row 4
    //   Cell 7: Row 5 (outer tip crossover)
    const ring = [];
    for (let s = 0; s < n; s++) {
      const theta = armAngle[s];
      const cosT = Math.cos(theta), sinT = Math.sin(theta);
      const px = -sinT, py = cosT; // perpendicular (clockwise)
      const dx = cosT, dy = sinT;  // along arm (outward)

      // Incoming cells (inward along -W*p): Row 5, 4, 3, 2
      for (const row of [5, 4, 3, 2]) {
        const r = inner_r + (row - 0.5) * H;
        ring.push({
          x: r * dx - W * px,
          y: r * dy - W * py,
          a: theta
        });
      }

      // Outgoing cells (outward along +W*p): Row 2, 3, 4, 5
      for (const row of [2, 3, 4, 5]) {
        const r = inner_r + (row - 0.5) * H;
        ring.push({
          x: r * dx + W * px,
          y: r * dy + W * py,
          a: theta
        });
      }
    }

    // Home lanes, hubs, yards
    const lane = [], hub = [], yard = [], yardCenter = [];
    const YARD_DIST = 328;
    const YARD_R = 64;

    for (let s = 0; s < n; s++) {
      const theta = armAngle[s];
      const cosT = Math.cos(theta), sinT = Math.sin(theta);
      const dx = cosT, dy = sinT;

      // Home lane: 4 cells along center column (Row 5 to Row 2, moving toward center)
      const playerLane = [];
      for (let j = 0; j < LANE; j++) {
        const row = 5 - j; // Row 5 (tip) down to Row 2
        const r = inner_r + (row - 0.5) * H;
        playerLane.push({ x: r * dx, y: r * dy });
      }
      lane.push(playerLane);

      // Finished tokens in HOME central wedge
      hub.push(Array.from({ length: k }, (_, t) => ({
        x: Math.cos(theta) * (42 + t * 14),
        y: Math.sin(theta) * (42 + t * 14)
      })));

      // Yard center placed at the bisector between arms:
      // For 6 players: exactly at -90° (12 o'clock, Green), -30° (2 o'clock, Purple), etc.
      let ya;
      if (n === 6) {
        ya = theta + Math.PI / 6; // exactly 30 degrees clockwise of arm
      } else {
        ya = theta + Math.PI / n;
      }
      const yc = { x: YARD_DIST * Math.cos(ya), y: YARD_DIST * Math.sin(ya) };
      yardCenter.push(yc);

      // 4 token slots inside the white dice card
      const d = 19;
      const holeOffsets = [[-d, -d], [d, -d], [-d, d], [d, d]];
      yard.push(holeOffsets.map(([ox, oy]) => ({ x: yc.x + ox, y: yc.y + oy })));
    }

    function tokenXY(seat, p, t) {
      if (p < 0)    return yard[seat][t];
      if (p < L)    return ring[(seat * seg + p) % L];
      if (p < HOME) return lane[seat][p - L];
      return hub[seat][t];
    }

    return {
      n, seg, k, L, HOME, cr, tr, spacing: H, ring, lane, hub, yard,
      yardCenter, laneAngle: armAngle, laneStep: H, tokenXY,
      boardType: 'hex', R_BOARD, HUB_R, YARD_R, W, H, inner_r, armAngle,
      colors: hexColors, ink: hexInk, names: hexNames
    };
  }

  function staticSvgHex(B, players) {
    const out = [];
    const f = v => v.toFixed(1);
    const { n, R_BOARD, HUB_R, YARD_R, W, H, inner_r, armAngle, yardCenter, colors, ink, names } = B;

    // Defs: Subtle gradients and filters
    out.push('<defs>' +
      '<radialGradient id="hubRed" cx="50%" cy="45%" r="60%">' +
        '<stop offset="0%" stop-color="#ef4444"/><stop offset="100%" stop-color="#b91c1c"/>' +
      '</radialGradient>' +
      '<filter id="bShadow" x="-10%" y="-10%" width="120%" height="120%">' +
        '<feDropShadow dx="0" dy="6" stdDeviation="12" flood-color="#000000" flood-opacity="0.4"/>' +
      '</filter>' +
      '<filter id="cardShadow" x="-20%" y="-20%" width="140%" height="140%">' +
        '<feDropShadow dx="0" dy="3" stdDeviation="4" flood-color="#000000" flood-opacity="0.25"/>' +
      '</filter>' +
    '</defs>');

    // 1. Outer Bright Yellow Canvas Frame (matching reference image)
    out.push('<rect x="-500" y="-500" width="1000" height="1000" fill="#f6bc19"/>');

    // 2. Main Circular Board Disk
    out.push(`<circle r="${R_BOARD}" fill="#e8eaed" stroke="#222222" stroke-width="4.5" filter="url(#bShadow)"/>`);
    out.push(`<circle r="${R_BOARD - 4}" fill="none" stroke="#ffffff" stroke-width="2"/>`);

    // 3. Central Hub: 6 HOME wedges + transition sectors + central red circle
    for (let s = 0; s < n; s++) {
      const col = colors[s];
      const theta = armAngle[s];
      const halfW = (Math.PI / n) * 0.72; // wedge angle
      const a1 = theta - halfW;
      const a2 = theta + halfW;
      const rInner = 28, rOuter = HUB_R + 2;

      const p0 = { x: rInner * Math.cos(a1), y: rInner * Math.sin(a1) };
      const p1 = { x: rOuter * Math.cos(a1), y: rOuter * Math.sin(a1) };
      const p2 = { x: rOuter * Math.cos(a2), y: rOuter * Math.sin(a2) };
      const p3 = { x: rInner * Math.cos(a2), y: rInner * Math.sin(a2) };

      // Wedge shape
      out.push(`<polygon points="${f(p0.x)},${f(p0.y)} ${f(p1.x)},${f(p1.y)} ${f(p2.x)},${f(p2.y)} ${f(p3.x)},${f(p3.y)}" fill="${col}" stroke="#222222" stroke-width="1.8"/>`);

      // "HOME" text aligned radially along the lane
      const textR = (rInner + rOuter) * 0.52;
      const tx = textR * Math.cos(theta);
      const ty = textR * Math.sin(theta);
      let deg = (theta * 180) / Math.PI + 90;
      if (deg > 90 && deg < 270) deg += 180;
      out.push(`<text x="${f(tx)}" y="${f(ty)}" text-anchor="middle" dominant-baseline="central" fill="#ffffff" font-size="13" font-weight="900" transform="rotate(${f(deg)}, ${f(tx)}, ${f(ty)})" letter-spacing="1">HOME</text>`);
    }

    // Curved arrows between wedges around the hub
    for (let s = 0; s < n; s++) {
      let ya;
      if (n === 6) ya = armAngle[s] + Math.PI / 6;
      else ya = armAngle[s] + Math.PI / n;

      const arrowR = 56;
      const ax = arrowR * Math.cos(ya);
      const ay = arrowR * Math.sin(ya);
      const rot = (ya * 180) / Math.PI + 90;

      out.push(`<g transform="translate(${f(ax)}, ${f(ay)}) rotate(${f(rot)})">` +
        '<path d="M-14 3 C-6 -5, 6 -5, 14 3" fill="none" stroke="#64748b" stroke-width="2" stroke-linecap="round"/>' +
        '<polygon points="14,3 9,-1 11,6" fill="#64748b"/>' +
      '</g>');
    }

    // Central Red Medallion
    out.push('<circle r="28" fill="url(#hubRed)" stroke="#222222" stroke-width="2.5"/>');
    out.push('<circle r="25" fill="none" stroke="#ffffff" stroke-width="1.2" opacity="0.6"/>');
    out.push('<circle r="3" fill="#ffffff" opacity="0.9"/>');

    // 4. Arms with 5 rows x 3 columns each
    for (let s = 0; s < n; s++) {
      const theta = armAngle[s];
      const deg = (theta * 180) / Math.PI - 90;
      const col = colors[s];
      const iCol = ink[s];

      out.push(`<g transform="rotate(${f(deg)})">`);

      for (let row = 1; row <= 5; row++) {
        // row 1 is inner (near hub), row 5 is outer (tip)
        const y = inner_r + (row - 1) * H;
        const cy = y + H * 0.5;

        // Left Column (lx = -1.5*W to -0.5*W, tokens move inward)
        const lx = -1.5 * W;
        out.push(`<rect x="${f(lx)}" y="${f(y)}" width="${W}" height="${H}" fill="#ffffff" stroke="#222222" stroke-width="1.5"/>`);
        if (row === 5) {
          // Entrance cell with colored inward arrow
          out.push(`<polygon points="${f(lx + W * 0.5)},${f(cy + 13)} ${f(lx + W * 0.2)},${f(cy - 9)} ${f(lx + W * 0.8)},${f(cy - 9)}" fill="${col}" stroke="#222222" stroke-width="1.2"/>`);
        } else if (row === 4) {
          // "START" circle marker
          out.push(`<circle cx="${f(lx + W * 0.5)}" cy="${f(cy)}" r="${f(W * 0.38)}" fill="#ffffff" stroke="${col}" stroke-width="2.2"/>`);
          out.push(`<text x="${f(lx + W * 0.5)}" y="${f(cy)}" text-anchor="middle" dominant-baseline="central" fill="${col}" font-size="8.5" font-weight="900">START</text>`);
        } else {
          // Faint arrow indicating inward direction
          out.push(`<line x1="${f(lx + W * 0.5)}" y1="${f(cy - 12)}" x2="${f(lx + W * 0.5)}" y2="${f(cy + 12)}" stroke="#cbd5e1" stroke-width="1.5" stroke-linecap="round"/>`);
          out.push(`<polygon points="${f(lx + W * 0.5)},${f(cy - 14)} ${f(lx + W * 0.35)},${f(cy - 8)} ${f(lx + W * 0.65)},${f(cy - 8)}" fill="#cbd5e1"/>`);
        }

        // Center Column (Home Lane, colored)
        const cx = -0.5 * W;
        if (row >= 2) {
          out.push(`<rect x="${f(cx)}" y="${f(y)}" width="${W}" height="${H}" fill="${col}" stroke="#222222" stroke-width="1.5"/>`);
          // White arrows pointing inward toward center hub
          out.push(`<polygon points="0,${f(cy - 12)} -7,${f(cy + 6)} 7,${f(cy + 6)}" fill="#ffffff" opacity="0.95"/>`);
        } else {
          out.push(`<rect x="${f(cx)}" y="${f(y)}" width="${W}" height="${H}" fill="${col}" stroke="#222222" stroke-width="1.5"/>`);
        }

        // Right Column (rx = 0.5*W to 1.5*W, tokens move outward)
        const rx = 0.5 * W;
        out.push(`<rect x="${f(rx)}" y="${f(y)}" width="${W}" height="${H}" fill="#ffffff" stroke="#222222" stroke-width="1.5"/>`);
        if (row === 3) {
          // Safe Star Cell ★: Pink 5-point star
          out.push(`<text x="${f(rx + W * 0.5)}" y="${f(cy + 1)}" text-anchor="middle" dominant-baseline="central" fill="#ec4899" font-size="28" font-weight="900">&#9733;</text>`);
        } else if (row === 2 || row === 4) {
          // Faint arrow indicating outward direction
          out.push(`<line x1="${f(rx + W * 0.5)}" y1="${f(cy - 12)}" x2="${f(rx + W * 0.5)}" y2="${f(cy + 12)}" stroke="#cbd5e1" stroke-width="1.5" stroke-linecap="round"/>`);
          out.push(`<polygon points="${f(rx + W * 0.5)},${f(cy + 14)} ${f(rx + W * 0.35)},${f(cy + 8)} ${f(rx + W * 0.65)},${f(cy + 8)}" fill="#cbd5e1"/>`);
        }
      }

      out.push('</g>');
    }

    // 5. Circular Yards (Dice Pad with 4 holes)
    for (let s = 0; s < n; s++) {
      const yc = yardCenter[s];
      const col = colors[s];
      const nm = players && players[s] ? players[s].name : names[s];

      out.push(`<g id="yard-${s}" class="yard">`);
      // Outer colored circle
      out.push(`<circle class="yard-ring" cx="${f(yc.x)}" cy="${f(yc.y)}" r="${YARD_R}" fill="${col}" stroke="#222222" stroke-width="3" filter="url(#cardShadow)"/>`);
      // White rounded dice card
      const cW = 86;
      out.push(`<rect x="${f(yc.x - cW * 0.5)}" y="${f(yc.y - cW * 0.5)}" width="${cW}" height="${cW}" rx="22" fill="#ffffff" stroke="#cbd5e1" stroke-width="2"/>`);
      // 4 colored token slot holes
      for (const q of B.yard[s]) {
        out.push(`<circle cx="${f(q.x)}" cy="${f(q.y)}" r="13.5" fill="${col}" stroke="#ffffff" stroke-width="2"/>`);
      }
      // Player name underneath
      out.push(`<text class="yard-name" x="${f(yc.x)}" y="${f(yc.y + YARD_R + 18)}" text-anchor="middle" font-size="13" font-weight="900" fill="#1e293b">${escapeXml(shorten(nm, 12))}</text>`);
      out.push('</g>');
    }

    return out.join('');
  }

  // ========================= DISPATCH =========================

  /** Build every position needed to draw and animate a board. */
  function layout(n, seg, k) {
    if (n <= 4) return layoutClassic(n, seg, k);
    if (n >= 5 && n <= 6) return layoutHex(n, seg, k);
    return layoutCircular(n, seg, k);
  }

  /** Markup for everything on the board that never moves. */
  function staticSvg(B, players) {
    if (B.boardType === 'classic') return staticSvgClassic(B, players);
    if (B.boardType === 'hex')     return staticSvgHex(B, players);
    return staticSvgCircular(B, players);
  }

  /** Offsets for several tokens sharing one cell, plus a size scale. */
  function stackLayout(m, tr) {
    if (m <= 1) return { offsets: [[0, 0]], scale: 1 };
    if (m <= 6) {
      const r = tr * 0.62;
      const offsets = Array.from({ length: m }, (_, i) => {
        const a = (2 * Math.PI * i) / m - Math.PI / 2;
        return [r * Math.cos(a), r * Math.sin(a)];
      });
      return { offsets, scale: m <= 3 ? 0.78 : 0.68 };
    }
    const golden = Math.PI * (3 - Math.sqrt(5));
    const offsets = Array.from({ length: m }, (_, i) => {
      const r = tr * 0.42 * Math.sqrt(i + 0.5);
      return [r * Math.cos(i * golden), r * Math.sin(i * golden)];
    });
    return { offsets, scale: 0.5 };
  }

  return { COLORS, INK, NAMES, R, HUB, YARD_R, YARD_DIST, LANE,
           layout, stackLayout, staticSvg, shorten };
});
