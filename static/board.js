/* Board geometry for the circular Ludo board (2-10 players).
 *
 * Pure functions with no DOM access so the layout can be unit-tested in Node.
 * Coordinates live in a 1000x1000 viewBox centred on (0, 0).
 *
 *   - a ring of L = seg * n cells; seat s starts at ring cell s * seg
 *   - each seat has a 4-cell home lane running from the cell just before its
 *     start cell towards the centre hub
 *   - each seat has a yard (circle) outside the ring, centred on its segment
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

  const R = 322;            // ring radius
  const HUB = 72;           // centre hub radius
  const YARD_DIST = R + 92; // distance of yard centres from the middle
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

  /** Build every position needed to draw and animate a board. */
  function layout(n, seg, k) {
    const L = seg * n;
    const HOME = L + LANE;
    const spacing = (2 * Math.PI * R) / L;
    const cr = clamp(spacing * 0.42, 8, 20);   // cell radius
    const tr = Math.min(17, cr * 0.95);        // token radius

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
      if (p < L) return ring[(seat * seg + p) % L];
      if (p < HOME) return lane[seat][p - L];
      return hub[seat][t];
    }

    return { n, seg, k, L, HOME, cr, tr, spacing, ring, lane, hub, yard,
             yardCenter, laneAngle, laneStep, tokenXY };
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

  /** Markup for everything on the board that never moves. */
  function staticSvg(B, players) {
    const out = [];
    const f = (v) => v.toFixed(1);
    const { n, seg, L, cr, ring, lane, yardCenter, laneAngle } = B;
    const safeOff = B.safe || [0, Math.floor((seg * 5) / 8)];

    out.push('<defs><radialGradient id="felt" cx="50%" cy="45%" r="60%">' +
      '<stop offset="0" stop-color="#fffaf0"/><stop offset="1" stop-color="#f4ead2"/></radialGradient></defs>');
    out.push('<circle r="492" fill="url(#felt)" stroke="#d9c9a1" stroke-width="4"/>');

    // track bed
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
    out.push(`<circle r="20" fill="#fffaf0" stroke="#d9c9a1" stroke-width="2"/>`);
    out.push(`<text y="1" text-anchor="middle" dominant-baseline="central" font-size="22">&#127922;</text>`);

    // lane beds + lane cells
    for (let s = 0; s < n; s++) {
      const e = ring[(s * seg - 1 + L) % L];
      const end = lane[s][LANE - 1];
      out.push(`<line x1="${f(e.x)}" y1="${f(e.y)}" x2="${f(end.x)}" y2="${f(end.y)}" ` +
        `stroke="${COLORS[s]}" stroke-opacity="0.28" stroke-width="${f(cr * 2 + 6)}" stroke-linecap="round"/>`);
      for (const q of lane[s]) {
        out.push(`<circle cx="${f(q.x)}" cy="${f(q.y)}" r="${f(cr)}" fill="${COLORS[s]}" fill-opacity="0.55" ` +
          `stroke="${COLORS[s]}" stroke-width="2"/>`);
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
        out.push(`<text x="${f(q.x)}" y="${f(q.y + 1)}" text-anchor="middle" dominant-baseline="central" ` +
          `font-size="${f(cr * 1.25)}" fill="${ink}" opacity="0.9" pointer-events="none">&#9733;</text>`);
      }
    }

    // yards
    for (let s = 0; s < n; s++) {
      const y = yardCenter[s];
      out.push(`<g id="yard-${s}" class="yard">` +
        `<circle class="yard-ring" cx="${f(y.x)}" cy="${f(y.y)}" r="${YARD_R + 6}" fill="none" stroke="${COLORS[s]}" stroke-width="0"/>` +
        `<circle cx="${f(y.x)}" cy="${f(y.y)}" r="${YARD_R}" fill="${COLORS[s]}" fill-opacity="0.22" stroke="${COLORS[s]}" stroke-width="4"/>` +
        B.yard[s].map((q) => `<circle cx="${f(q.x)}" cy="${f(q.y)}" r="${f(B.tr + 3)}" fill="#fffaf0" fill-opacity="0.75" stroke="${COLORS[s]}" stroke-opacity="0.5" stroke-width="2"/>`).join('') +
        `<text class="yard-name" x="${f(y.x)}" y="${f(y.y + 46)}" text-anchor="middle" dominant-baseline="central" ` +
        `font-size="15" font-weight="700" fill="#3a2f12">${escapeXml(shorten(players && players[s] ? players[s].name : NAMES[s], 11))}</text>` +
        `</g>`);
    }
    return out.join('');
  }

  function shorten(s, max) {
    s = String(s);
    return s.length > max ? s.slice(0, max - 1) + '…' : s;
  }
  function escapeXml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  return { COLORS, INK, NAMES, R, HUB, YARD_R, YARD_DIST, LANE,
           layout, stackLayout, staticSvg, shorten };
});
