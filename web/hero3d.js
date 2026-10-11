// The hero scene: a rotating dependency graph in 3D, drawn on a 2D canvas with its own projection.
// Nodes are packages. Some start flagged; a scan travels along the edges and turns them verified.
const TAU = Math.PI * 2;
const GREEN = [52, 211, 153];
const RED = [248, 113, 113];
const GREY = [120, 134, 156];

export function startHero(canvas) {
  const ctx = canvas.getContext('2d');
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const COUNT = 150;
  const nodes = [];
  for (let i = 0; i < COUNT; i++) {
    // Fibonacci sphere, with a little noise so it reads as a network and not a ball.
    const y = 1 - (i / (COUNT - 1)) * 2;
    const r = Math.sqrt(1 - y * y);
    const a = i * 2.399963;
    const jitter = 0.86 + Math.random() * 0.28;
    nodes.push({ x: Math.cos(a) * r * jitter, y: y * jitter, z: Math.sin(a) * r * jitter, state: Math.random() < 0.16 ? 1 : 0, mix: 0, pulse: 0, size: 0.6 + Math.random() * 1.1, links: [] });
  }
  for (const [i, n] of nodes.entries()) {
    const near = nodes.map((m, j) => [j, (m.x - n.x) ** 2 + (m.y - n.y) ** 2 + (m.z - n.z) ** 2]).filter(([j]) => j !== i).sort((p, q) => p[1] - q[1]).slice(0, 3);
    for (const [j] of near) if (!n.links.includes(j) && !nodes[j].links.includes(i)) n.links.push(j);
  }
  const edges = nodes.flatMap((n, i) => n.links.map((j) => [i, j]));
  const scans = [];
  let width = 0, height = 0, dpr = 1, mouseX = 0, mouseY = 0, tiltX = 0, tiltY = 0, last = 0, nextScan = 600, running = true;

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    width = canvas.clientWidth; height = canvas.clientHeight;
    canvas.width = width * dpr; canvas.height = height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  const onMove = (e) => { mouseX = (e.clientX / window.innerWidth - 0.5) * 2; mouseY = (e.clientY / window.innerHeight - 0.5) * 2; };
  window.addEventListener('resize', resize);
  window.addEventListener('pointermove', onMove, { passive: true });
  resize();

  function launchScan() {
    const flagged = nodes.map((n, i) => (n.state === 1 ? i : -1)).filter((i) => i >= 0);
    if (flagged.length === 0) { for (const n of nodes) if (Math.random() < 0.16) { n.state = 1; n.mix = 0; } return; }
    const target = flagged[Math.floor(Math.random() * flagged.length)];
    // Walk a few hops towards the target so the scan visibly travels through the graph.
    const path = [target];
    let at = target;
    for (let hop = 0; hop < 4; hop++) {
      const options = edges.filter(([a, b]) => a === at || b === at).map(([a, b]) => (a === at ? b : a)).filter((j) => !path.includes(j));
      if (!options.length) break;
      at = options[Math.floor(Math.random() * options.length)];
      path.unshift(at);
    }
    scans.push({ path, t: 0 });
  }

  function frame(now) {
    if (!running) return;
    const dt = Math.min(48, now - (last || now)); last = now;
    const time = now / 1000;
    tiltX += (mouseY * 0.35 - tiltX) * 0.04; tiltY += (mouseX * 0.5 - tiltY) * 0.04;
    const spin = reduce ? 0.6 : time * 0.12;
    const cy = Math.cos(spin + tiltY), sy = Math.sin(spin + tiltY), cx = Math.cos(tiltX * 0.6), sx = Math.sin(tiltX * 0.6);
    const scale = Math.min(width, height) * 0.43;
    const ox = width / 2, oy = height / 2;

    ctx.clearRect(0, 0, width, height);
    const core = ctx.createRadialGradient(ox, oy, 0, ox, oy, scale * 1.25);
    core.addColorStop(0, 'rgba(52, 211, 153, 0.20)'); core.addColorStop(0.45, 'rgba(52, 211, 153, 0.05)'); core.addColorStop(1, 'rgba(52, 211, 153, 0)');
    ctx.fillStyle = core; ctx.fillRect(0, 0, width, height);

    const p = nodes.map((n) => {
      const x1 = n.x * cy - n.z * sy, z1 = n.x * sy + n.z * cy;
      const y1 = n.y * cx - z1 * sx, z2 = n.y * sx + z1 * cx;
      const depth = 2.6 / (2.6 + z2);
      return { x: ox + x1 * scale * depth, y: oy + y1 * scale * depth, depth, z: z2 };
    });

    ctx.lineWidth = 1;
    for (const [a, b] of edges) {
      const alpha = Math.max(0, 0.05 + (1 - (p[a].z + p[b].z) / 2) * 0.09);
      ctx.strokeStyle = `rgba(140, 160, 190, ${alpha})`;
      ctx.beginPath(); ctx.moveTo(p[a].x, p[a].y); ctx.lineTo(p[b].x, p[b].y); ctx.stroke();
    }

    nextScan -= dt;
    if (nextScan <= 0 && !reduce) { launchScan(); nextScan = 700 + Math.random() * 900; }
    for (let s = scans.length - 1; s >= 0; s--) {
      const scan = scans[s];
      scan.t += dt / 320;
      const seg = Math.floor(scan.t), f = scan.t - seg;
      if (seg >= scan.path.length - 1) {
        const hit = nodes[scan.path.at(-1)];
        if (hit.state === 1) { hit.state = 2; hit.pulse = 1; }
        scans.splice(s, 1);
        continue;
      }
      const a = p[scan.path[seg]], b = p[scan.path[seg + 1]];
      const x = a.x + (b.x - a.x) * f, y = a.y + (b.y - a.y) * f;
      ctx.strokeStyle = 'rgba(52, 211, 153, 0.75)'; ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(x, y); ctx.stroke();
      const glow = ctx.createRadialGradient(x, y, 0, x, y, 14);
      glow.addColorStop(0, 'rgba(110, 231, 183, 0.95)'); glow.addColorStop(1, 'rgba(52, 211, 153, 0)');
      ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(x, y, 14, 0, TAU); ctx.fill();
    }

    const order = nodes.map((_, i) => i).sort((a, b) => p[b].z - p[a].z);
    for (const i of order) {
      const n = nodes[i], q = p[i];
      if (n.state === 2 && n.mix < 1) n.mix = Math.min(1, n.mix + dt / 500);
      const from = n.state === 0 ? GREY : RED, to = n.state === 2 ? GREEN : from;
      const c = from.map((v, k) => Math.round(v + (to[k] - v) * n.mix));
      const front = Math.max(0.18, 1 - (q.z + 1) / 2.2);
      const radius = n.size * q.depth * (n.state === 0 ? 1.7 : 2.9);
      const flicker = n.state === 1 ? 0.75 + Math.sin(time * 5 + i) * 0.25 : 1;
      if (n.state !== 0) {
        const halo = ctx.createRadialGradient(q.x, q.y, 0, q.x, q.y, radius * 5);
        halo.addColorStop(0, `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${0.38 * front * flicker})`); halo.addColorStop(1, `rgba(${c[0]}, ${c[1]}, ${c[2]}, 0)`);
        ctx.fillStyle = halo; ctx.beginPath(); ctx.arc(q.x, q.y, radius * 5, 0, TAU); ctx.fill();
      }
      ctx.fillStyle = `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${(n.state === 0 ? 0.55 : 1) * front * flicker})`;
      ctx.beginPath(); ctx.arc(q.x, q.y, radius, 0, TAU); ctx.fill();
      if (n.pulse > 0) {
        ctx.strokeStyle = `rgba(52, 211, 153, ${n.pulse * 0.8})`; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(q.x, q.y, radius + (1 - n.pulse) * 34, 0, TAU); ctx.stroke();
        n.pulse = Math.max(0, n.pulse - dt / 900);
      }
    }
    if (!reduce) requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
  return () => { running = false; window.removeEventListener('resize', resize); window.removeEventListener('pointermove', onMove); };
}

// The agent console: types an investigation out, line by line, and loops.
const SCRIPT = [
  ['cmd', 'veritas investigate github.com/acme/items-api'],
  ['step', 'INTAKE', 'private copy made · nothing in your repository is touched'],
  ['step', 'INTEL', 'express 4.22.3 → 5.3.0 · release notes and migration guide read'],
  ['step', 'IMPACT', '4 call sites use removed APIs · src/app.js:16, src/routes/items.js:7'],
  ['fail', 'BASELINE', 'tests pass on 4.22.3 · fail on 5.3.0 · TypeError: app.del is not a function'],
  ['step', 'PATCH', 'fix written on branch veritas/express · 2 files, 4 lines'],
  ['step', 'VERIFY', '3 passed, 0 failed · nothing regressed'],
  ['wait', 'APPROVAL', 'waiting for you · approve to open the pull request'],
];

export function startConsole(el) {
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let stopped = false;
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const line = (kind, tag) => {
    const row = document.createElement('div');
    row.className = `cl k-${kind}`;
    row.innerHTML = kind === 'cmd' ? '<span class="prompt">$</span><span class="text"></span><span class="caret"></span>' : `<span class="tag">${tag}</span><span class="text"></span>`;
    el.appendChild(row);
    return row;
  };
  async function play() {
    while (!stopped) {
      el.innerHTML = '';
      for (const [kind, a, b] of SCRIPT) {
        if (stopped) return;
        const row = line(kind, a);
        const text = row.querySelector('.text');
        const full = kind === 'cmd' ? a : b;
        if (reduce) text.textContent = full;
        else for (let i = 1; i <= full.length; i++) { text.textContent = full.slice(0, i); await wait(kind === 'cmd' ? 26 : 7); if (stopped) return; }
        row.classList.add('done');
        await wait(kind === 'cmd' ? 500 : 380);
      }
      if (reduce) return;
      await wait(4200);
    }
  }
  play();
  return () => { stopped = true; };
}

/** Fades sections in as they scroll into view, and counts numbers up when they appear. */
export function startReveal(root) {
  const io = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.add('in');
      for (const el of entry.target.querySelectorAll('[data-count]')) {
        const target = Number(el.dataset.count), prefix = el.dataset.prefix ?? '', suffix = el.dataset.suffix ?? '', decimals = Number(el.dataset.decimals ?? 0);
        const start = performance.now();
        const tick = (now) => {
          const k = Math.max(0, Math.min(1, (now - start) / 1100)), eased = 1 - (1 - k) ** 3;
          el.textContent = `${prefix}${(target * eased).toFixed(decimals)}${suffix}`;
          if (k < 1) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }
      io.unobserve(entry.target);
    }
  }, { threshold: 0.18 });
  for (const el of root.querySelectorAll('.reveal')) io.observe(el);
  return () => io.disconnect();
}
