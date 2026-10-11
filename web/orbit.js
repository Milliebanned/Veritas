// The hero motion: a wide arc with the agent's stages travelling along it as tokens.
// Each token slides to the next station with a motion-blur trail, rests, then moves on.
const NAVY = '#262c45';
const TAU = Math.PI * 2;

// Simple line icons, drawn in a 24-unit box centred on the token.
const ICONS = [
  (c) => { c.arc(-1.5, -1.5, 5.5, 0, TAU); c.moveTo(2.6, 2.6); c.lineTo(7.5, 7.5); },                                  // read: magnifier
  (c) => { c.arc(-5.5, 4, 2.2, 0, TAU); c.moveTo(7.7, 4); c.arc(5.5, 4, 2.2, 0, TAU); c.moveTo(2.2, -5); c.arc(0, -5, 2.2, 0, TAU); c.moveTo(-4.4, 2.2); c.lineTo(-1.1, -3.2); c.moveTo(4.4, 2.2); c.lineTo(1.1, -3.2); }, // graph
  (c) => { c.moveTo(-6, -6); c.lineTo(-6, 6); c.moveTo(-2, -2); c.lineTo(-2, 6); c.moveTo(2, -6); c.lineTo(2, 6); c.moveTo(6, 1); c.lineTo(6, 6); }, // tests: bars
  (c) => { c.moveTo(-3, -5); c.lineTo(-8, 0); c.lineTo(-3, 5); c.moveTo(3, -5); c.lineTo(8, 0); c.lineTo(3, 5); },       // patch: code
  (c) => { c.moveTo(-6.5, 0.5); c.lineTo(-2, 5); c.lineTo(7, -5); },                                                   // verify: check
  (c) => { c.arc(-5, -5, 2.2, 0, TAU); c.moveTo(-5, -2.8); c.lineTo(-5, 7); c.moveTo(7.2, 5); c.arc(5, 5, 2.2, 0, TAU); c.moveTo(5, 2.8); c.lineTo(5, -2); c.quadraticCurveTo(5, -5, 2, -5); c.lineTo(-1, -5); }, // pull request
];

export function startOrbit(canvas) {
  const ctx = canvas.getContext('2d');
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  // Stations along the arc, as angles from the circle's centre (pi = left, 1.5 pi = straight up).
  const STATIONS = [0.93, 1.09, 1.27, 1.47, 1.66].map((k) => k * Math.PI);
  const MOVE = 1000, REST = 1900;
  let width = 0, height = 0, dpr = 1, cx = 0, cy = 0, radius = 0, band = 0, token = 0, running = true, start = 0;

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    width = canvas.clientWidth; height = canvas.clientHeight;
    canvas.width = width * dpr; canvas.height = height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    radius = Math.min(width * 0.86, height * 0.95);
    cx = width * 1.02; cy = height * 1.08;
    band = radius * 0.3; token = band * 0.29;
  }
  window.addEventListener('resize', resize);
  resize();

  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const at = (angle) => [cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius];

  function drawToken(angle, icon, alpha) {
    const [x, y] = at(angle);
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.shadowColor = 'rgba(38, 44, 69, .35)'; ctx.shadowBlur = 24; ctx.shadowOffsetY = 10;
    const fill = ctx.createLinearGradient(x, y - token, x, y + token);
    fill.addColorStop(0, '#343b5c'); fill.addColorStop(1, '#20253b');
    ctx.fillStyle = fill; ctx.beginPath(); ctx.arc(x, y, token, 0, TAU); ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.translate(x, y); ctx.scale(token / 15, token / 15);
    ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.beginPath(); ICONS[icon % ICONS.length](ctx); ctx.stroke();
    ctx.restore();
  }

  function drawTrail(from, to, strength) {
    if (strength <= 0.01) return;
    ctx.save();
    ctx.filter = `blur(${Math.max(6, token * 0.42)}px)`;
    const steps = 22;
    for (let i = 0; i < steps; i++) {
      const k = i / (steps - 1);
      const [x, y] = at(from + (to - from) * k);
      ctx.globalAlpha = strength * (0.03 + k * k * 0.3);
      ctx.fillStyle = NAVY;
      ctx.beginPath(); ctx.arc(x, y, token * (0.82 + k * 0.16), 0, TAU); ctx.fill();
    }
    ctx.restore();
  }

  function frame(now) {
    if (!running) return;
    if (!start) start = reduce ? now - MOVE : now;
    const elapsed = now - start;
    const cycle = Math.floor(elapsed / (MOVE + REST));
    const into = elapsed - cycle * (MOVE + REST);
    const moving = into < MOVE;
    const t = moving ? ease(into / MOVE) : 1;
    // How blurred the trail is: strongest mid-move, lingering briefly once the token has stopped.
    const blur = moving ? Math.sin((into / MOVE) * Math.PI) * 0.9 + 0.25 : Math.max(0, 0.25 - (into - MOVE) / 1400);

    ctx.clearRect(0, 0, width, height);
    const track = ctx.createLinearGradient(0, 0, 0, height);
    track.addColorStop(0, '#d2cbc3'); track.addColorStop(0.55, '#d9d3cc'); track.addColorStop(1, 'rgba(226, 222, 217, 0)');
    ctx.strokeStyle = track; ctx.lineWidth = band; ctx.lineCap = 'butt';
    ctx.beginPath(); ctx.arc(cx, cy, radius, Math.PI * 0.9, Math.PI * 1.75); ctx.stroke();

    for (let slot = 0; slot < STATIONS.length - 1; slot++) {
      const from = STATIONS[slot], to = STATIONS[slot + 1];
      const angle = from + (to - from) * t;
      const icon = ((cycle - slot) % ICONS.length + ICONS.length) % ICONS.length;
      const alpha = slot === 0 ? t : slot === STATIONS.length - 2 ? 1 - t : 1;
      drawTrail(from + (angle - from) * 0.15, angle, blur * alpha);
      drawToken(angle, icon, alpha);
    }
    if (!reduce) requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
  return () => { running = false; window.removeEventListener('resize', resize); };
}

/** Cycles a stack of cards: the front one slides away behind, the next comes forward. */
export function startStack(stack) {
  const cards = [...stack.children];
  if (cards.length < 2 || window.matchMedia('(prefers-reduced-motion: reduce)').matches) { cards.forEach((c, i) => (c.dataset.pos = String(i))); return () => {}; }
  let first = 0;
  const place = () => cards.forEach((card, i) => { card.dataset.pos = String((i - first + cards.length) % cards.length); });
  place();
  const timer = setInterval(() => { first = (first + 1) % cards.length; place(); }, 3400);
  return () => clearInterval(timer);
}
