// The landing scene: an original illustrated landscape at first light, generated in SVG.
// Mountains, a lake, forested hills, drifting clouds and birds, with depth on pointer and scroll.
const NS = 'http://www.w3.org/2000/svg';
const W = 1600;
const H = 1000;

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

/** A ridge line across the scene. `sharp` turns rolling hills into peaked mountains. */
function ridge({ seed, base, amp, freq, sharp = 0, tilt = 0 }) {
  const r = rng(seed);
  const waves = Array.from({ length: 5 }, (_, i) => ({ f: freq * (1 + i * 0.9) * (0.8 + r() * 0.4), p: r() * Math.PI * 2, a: 1 / (1 + i * 1.3) }));
  const total = waves.reduce((sum, w) => sum + w.a, 0);
  return (x) => {
    let v = 0;
    for (const w of waves) {
      const s = Math.sin(x * w.f + w.p);
      v += w.a * (sharp ? (1 - Math.abs(s)) * 2 - 1 : s) * (sharp ? sharp : 1) + (sharp ? w.a * s * (1 - sharp) : 0);
    }
    return base - (v / total) * amp + (x / W - 0.5) * tilt;
  };
}

function areaPath(fn, step = 8) {
  let d = `M0 ${H} L0 ${fn(0).toFixed(1)}`;
  for (let x = step; x <= W; x += step) d += ` L${x} ${fn(x).toFixed(1)}`;
  return `${d} L${W} ${H} Z`;
}

const el = (name, attrs = {}, parent) => {
  const node = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (parent) parent.appendChild(node);
  return node;
};

function gradient(defs, id, stops, { x1 = 0, y1 = 0, x2 = 0, y2 = 1 } = {}) {
  const g = el('linearGradient', { id, x1, y1, x2, y2 }, defs);
  for (const [offset, color, opacity] of stops) el('stop', { offset, 'stop-color': color, ...(opacity !== undefined ? { 'stop-opacity': opacity } : {}) }, g);
}

function cloud(parent, cx, cy, scale, seed) {
  const r = rng(seed);
  const g = el('g', { filter: 'url(#soft)', class: 'cloud' }, parent);
  const puffs = 13;
  for (let i = 0; i < puffs; i++) {
    const t = i / (puffs - 1);
    const x = cx + (t - 0.5) * 420 * scale + (r() - 0.5) * 40 * scale;
    const lift = Math.sin(t * Math.PI) * 78 * scale * (0.6 + r() * 0.6);
    el('circle', { cx: x.toFixed(1), cy: (cy - lift * 0.55).toFixed(1), r: ((34 + lift * 0.75 + r() * 16) * scale).toFixed(1), fill: 'url(#cloudFill)' }, g);
  }
  // A flat, shaded underside is what makes it read as a cumulus cloud.
  el('ellipse', { cx, cy: cy + 26 * scale, rx: 250 * scale, ry: 30 * scale, fill: 'url(#cloudBase)' }, g);
  return g;
}

function pines(parent, fn, { seed, from, to, every, size, fill }) {
  const r = rng(seed);
  for (let x = from; x < to; x += every * (0.55 + r() * 0.9)) {
    const h = size * (0.6 + r() * 0.9);
    const y = fn(x) + 4;
    const w = h * 0.34;
    let d = '';
    for (let tier = 0; tier < 4; tier++) {
      const top = y - h + (tier * h) / 5.2;
      const bottom = y - h + ((tier + 1.9) * h) / 4.6;
      const half = w * (0.35 + tier * 0.24);
      d += `M${x.toFixed(1)} ${top.toFixed(1)} L${(x + half).toFixed(1)} ${bottom.toFixed(1)} L${(x - half).toFixed(1)} ${bottom.toFixed(1)} Z `;
    }
    el('path', { d, fill }, parent);
  }
}

export function startScene(host) {
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'xMidYMax slice', 'aria-hidden': 'true' });
  const defs = el('defs', {}, svg);
  gradient(defs, 'sky', [['0', '#ffffff'], ['0.42', '#fffaf3'], ['0.6', '#ffeedd'], ['0.74', '#f9d9cf'], ['1', '#dfd2f1']]);
  gradient(defs, 'cloudFill', [['0', '#fff3e2'], ['0.45', '#ffd7b8'], ['1', '#c9b3e6']]);
  gradient(defs, 'cloudBase', [['0', '#b9a6dd', 0.85], ['1', '#b9a6dd', 0]]);
  gradient(defs, 'far', [['0', '#c9c6ee'], ['1', '#b7b3e6']]);
  gradient(defs, 'mid', [['0', '#f3b9b4'], ['0.22', '#c9a9d6'], ['0.55', '#9a98d8'], ['1', '#8a8fd2']]);
  gradient(defs, 'near', [['0', '#8f8fd0'], ['1', '#6f7fc4']]);
  gradient(defs, 'lake', [['0', '#f6cfc6'], ['0.25', '#e3c4de'], ['0.6', '#9fb2e6'], ['1', '#6e95da']]);
  gradient(defs, 'glint', [['0', '#ffffff', 0], ['0.5', '#fff4e6', 0.85], ['1', '#ffffff', 0]], { x1: 0, y1: 0, x2: 1, y2: 0 });
  gradient(defs, 'hillFar', [['0', '#6f9f8f'], ['1', '#4f8576']]);
  gradient(defs, 'hillNear', [['0', '#4c8468'], ['1', '#2f6650']]);
  gradient(defs, 'meadow', [['0', '#a9c95b'], ['0.3', '#7fae45'], ['1', '#3e7a3a']]);
  gradient(defs, 'meadowDark', [['0', '#5f9a3f'], ['1', '#2c5f33']]);
  const sun = el('radialGradient', { id: 'sun', cx: 0.5, cy: 0.5, r: 0.5 }, defs);
  el('stop', { offset: '0', 'stop-color': '#fff1d6', 'stop-opacity': 0.95 }, sun);
  el('stop', { offset: '0.35', 'stop-color': '#ffd9b4', 'stop-opacity': 0.5 }, sun);
  el('stop', { offset: '1', 'stop-color': '#ffd9b4', 'stop-opacity': 0 }, sun);
  const soft = el('filter', { id: 'soft', x: '-20%', y: '-40%', width: '140%', height: '180%' }, defs);
  el('feGaussianBlur', { stdDeviation: 5 }, soft);
  const haze = el('filter', { id: 'haze', x: '-5%', y: '-5%', width: '110%', height: '110%' }, defs);
  el('feGaussianBlur', { stdDeviation: 1.2 }, haze);

  const layer = (depth) => el('g', { 'data-depth': depth }, svg);
  el('rect', { width: W, height: H, fill: 'url(#sky)' }, svg);
  el('circle', { cx: 1090, cy: 640, r: 430, fill: 'url(#sun)' }, layer(0.05));

  const clouds = layer(0.12);
  const c1 = cloud(clouds, 110, 150, 0.9, 11);
  const c2 = cloud(clouds, 1530, 150, 0.82, 23);
  const c3 = cloud(clouds, 1050, 330, 0.3, 37);
  c3.setAttribute('opacity', '0.75');

  const horizon = 690;
  el('path', { d: areaPath(ridge({ seed: 3, base: 640, amp: 80, freq: 0.004, sharp: 0.75 })), fill: 'url(#far)', filter: 'url(#haze)', opacity: 0.9 }, layer(0.1));
  el('path', { d: areaPath(ridge({ seed: 8, base: 662, amp: 180, freq: 0.0034, sharp: 0.9, tilt: -180 })), fill: 'url(#mid)' }, layer(0.16));
  el('path', { d: areaPath(ridge({ seed: 15, base: 690, amp: 56, freq: 0.0052, sharp: 0.6, tilt: 40 })), fill: 'url(#near)', opacity: 0.95 }, layer(0.2));

  const water = layer(0.22);
  el('rect', { x: 0, y: horizon, width: W, height: H - horizon, fill: 'url(#lake)' }, water);
  const glints = [];
  const gr = rng(71);
  for (let i = 0; i < 16; i++) {
    const y = horizon + 14 + gr() * 220;
    const w = 90 + gr() * 320;
    glints.push(el('rect', { x: (560 + gr() * 620 - w / 2).toFixed(0), y: y.toFixed(0), width: w.toFixed(0), height: (1.4 + gr() * 2).toFixed(1), rx: 2, fill: 'url(#glint)', class: 'glint', style: `animation-delay:${(gr() * -7).toFixed(2)}s` }, water));
  }

  // Land meets the lake along a shoreline: each hill is clipped at its own waterline and tapers down to it.
  let clipId = 0;
  const shoreLayer = (depth, shoreY) => {
    const id = `shore${clipId++}`;
    el('rect', { x: -200, y: 0, width: W + 400, height: shoreY }, el('clipPath', { id }, defs));
    const g = layer(depth);
    return el('g', { 'clip-path': `url(#${id})` }, g);
  };
  const taper = (x, edge, reach, side) => {
    const t = Math.min(1, Math.max(0, (side === 'right' ? edge - x : x - edge) / reach));
    return t * t * (3 - 2 * t);
  };

  const farShore = 716;
  const farHills = shoreLayer(0.3, farShore);
  const farRidge = ridge({ seed: 21, base: 672, amp: 20, freq: 0.006 });
  const farLeft = (x) => farRidge(x) + taper(x, 150, 330, 'left') * 70;
  const farRight = (x) => farRidge(x) - 18 + taper(x, 1260, 330, 'right') * 80;
  el('path', { d: areaPath((x) => (x < 560 ? farLeft(x) : H)), fill: 'url(#hillFar)' }, farHills);
  el('path', { d: areaPath((x) => (x > 880 ? farRight(x) : H)), fill: 'url(#hillFar)' }, farHills);
  pines(farHills, farLeft, { seed: 6, from: 0, to: 400, every: 14, size: 28, fill: '#4a8171' });
  pines(farHills, farRight, { seed: 5, from: 1010, to: W, every: 14, size: 28, fill: '#4a8171' });

  const island = layer(0.34);
  el('ellipse', { cx: 770, cy: 780, rx: 132, ry: 9, fill: '#3f7a62' }, island);
  pines(island, () => 774, { seed: 9, from: 660, to: 880, every: 11, size: 28, fill: '#346b56' });

  const nearShore = 812;
  const nearHills = shoreLayer(0.42, nearShore);
  const nearRidge = ridge({ seed: 33, base: 716, amp: 26, freq: 0.0046 });
  const nearRight = (x) => nearRidge(x) - (x - 1100) * 0.06 + taper(x, 1420, 420, 'right') * 150;
  el('path', { d: areaPath((x) => (x > 960 ? nearRight(x) : H)), fill: 'url(#hillNear)' }, nearHills);
  pines(nearHills, nearRight, { seed: 12, from: 1130, to: W, every: 21, size: 54, fill: '#2a5f4b' });

  const meadowBack = layer(0.55);
  const slopeBack = (x) => 706 + Math.pow(Math.max(0, x) / 700, 1.5) * 230 + Math.sin(x * 0.02) * 6;
  el('path', { d: areaPath((x) => (x < 760 ? slopeBack(x) : H + 40)), fill: 'url(#meadowDark)' }, meadowBack);
  pines(meadowBack, slopeBack, { seed: 41, from: 6, to: 250, every: 30, size: 150, fill: '#234c3a' });

  const meadow = layer(0.72);
  const slope = (x) => 780 + Math.pow(Math.max(0, x) / 900, 1.7) * 250 + Math.sin(x * 0.017 + 1) * 9;
  el('path', { d: areaPath((x) => (x < 1040 ? slope(x) : H + 40)), fill: 'url(#meadow)' }, meadow);
  const rightBank = (x) => 968 - Math.pow(Math.max(0, x - 1010) / 590, 0.8) * 105 + Math.sin(x * 0.03) * 5;
  el('path', { d: areaPath((x) => (x > 1010 ? rightBank(x) : H + 40)), fill: 'url(#meadowDark)' }, meadow);
  const mr = rng(88);
  for (const [x, y, s] of [[300, 905, 0.62], [470, 948, 0.42], [1420, 950, 0.55]]) {
    el('path', { d: `M${x - 70 * s} ${y + 30 * s} Q${x - 62 * s} ${y - 26 * s} ${x - 8 * s} ${y - 34 * s} Q${x + 58 * s} ${y - 30 * s} ${x + 76 * s} ${y + 30 * s} Z`, fill: '#8d8fb0' }, meadow);
    el('path', { d: `M${x - 62 * s} ${y + 10 * s} Q${x - 50 * s} ${y - 22 * s} ${x - 8 * s} ${y - 30 * s} Q${x + 30 * s} ${y - 28 * s} ${x + 50 * s} ${y - 8 * s} Q${x} ${y - 16 * s} ${x - 62 * s} ${y + 10 * s} Z`, fill: '#b7b6d2', opacity: 0.8 }, meadow);
  }
  let blades = '';
  for (let i = 0; i < 240; i++) {
    const x = mr() * 1040;
    const y = slope(x) + mr() * 150 + 4;
    blades += `M${x.toFixed(0)} ${y.toFixed(0)} q${(mr() * 6 - 3).toFixed(1)} ${(-10 - mr() * 16).toFixed(1)} ${(mr() * 10 - 5).toFixed(1)} ${(-18 - mr() * 20).toFixed(1)} `;
  }
  el('path', { d: blades, stroke: '#c3de78', 'stroke-width': 1.4, 'stroke-linecap': 'round', fill: 'none', opacity: 0.7 }, meadow);
  for (let i = 0; i < 130; i++) {
    const right = mr() < 0.22;
    const x = right ? 1080 + mr() * 500 : mr() * 980;
    const y = (right ? rightBank(x) : slope(x)) + 8 + mr() * 130;
    el('circle', { cx: x.toFixed(0), cy: y.toFixed(0), r: (1.6 + mr() * 2.6).toFixed(1), fill: mr() < 0.25 ? '#ffe9a8' : '#ffffff', opacity: (0.75 + mr() * 0.25).toFixed(2) }, meadow);
  }

  const flock = layer(0.26);
  const br = rng(64);
  for (let i = 0; i < 16; i++) {
    const s = 0.6 + br() * 0.9;
    const bird = el('g', { class: 'bird', style: `--x:${(140 + br() * 1250).toFixed(0)}px;--y:${(560 + br() * 150).toFixed(0)}px;--s:${s.toFixed(2)};animation-duration:${(46 + br() * 50).toFixed(0)}s;animation-delay:${(br() * -90).toFixed(0)}s` }, flock);
    el('path', { d: 'M-7 0 Q-3.5 -5 0 0 Q3.5 -5 7 0', fill: 'none', stroke: '#3a3148', 'stroke-width': 1.5, 'stroke-linecap': 'round', class: 'wing', style: `animation-delay:${(br() * -1).toFixed(2)}s` }, bird);
  }

  host.appendChild(svg);
  const layers = [...svg.querySelectorAll('[data-depth]')];
  let mx = 0, my = 0, px = 0, py = 0, scrollY = 0, running = true;
  const onMove = (e) => { mx = e.clientX / window.innerWidth - 0.5; my = e.clientY / window.innerHeight - 0.5; };
  const onScroll = () => { scrollY = window.scrollY; };
  function frame(now) {
    if (!running) return;
    px += (mx - px) * 0.05; py += (my - py) * 0.05;
    const drift = now / 1000;
    for (const g of layers) {
      const d = Number(g.dataset.depth);
      g.setAttribute('transform', `translate(${(-px * 46 * d).toFixed(2)} ${(-py * 22 * d + scrollY * 0.22 * d).toFixed(2)})`);
    }
    c1.setAttribute('transform', `translate(${(Math.sin(drift * 0.05) * 46).toFixed(2)} 0)`);
    c2.setAttribute('transform', `translate(${(Math.sin(drift * 0.04 + 2) * -58).toFixed(2)} 0)`);
    c3.setAttribute('transform', `translate(${((drift * 6) % 900 - 300).toFixed(2)} 0)`);
    requestAnimationFrame(frame);
  }
  if (!reduce) {
    window.addEventListener('pointermove', onMove, { passive: true });
    window.addEventListener('scroll', onScroll, { passive: true });
    requestAnimationFrame(frame);
  }
  return () => { running = false; window.removeEventListener('pointermove', onMove); window.removeEventListener('scroll', onScroll); };
}
