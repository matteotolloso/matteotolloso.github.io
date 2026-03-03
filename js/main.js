// --- UI
document.getElementById('year').textContent = new Date().getFullYear();

// --- Atomistic-ish background simulation (2D toy MD on canvas)
const canvas = document.getElementById('sim');
const ctx = canvas.getContext('2d', { alpha: true });

const state = {
  W: 0, H: 0, dpr: Math.max(1, Math.min(2, window.devicePixelRatio || 1)),
  atoms: [],
  running: true,
  mouse: { x: 0, y: 0, down: false, active: false },
  t: 0,
  aggregation: { active: false, nextAt: 0, endAt: 0, groups: [], bondedIds: new Set() }
};

function resize() {
  state.W = Math.floor(window.innerWidth);
  state.H = Math.floor(window.innerHeight);
  canvas.width = Math.floor(state.W * state.dpr);
  canvas.height = Math.floor(state.H * state.dpr);
  canvas.style.width = state.W + 'px';
  canvas.style.height = state.H + 'px';
  ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
}
window.addEventListener('resize', resize);

// Parameters: tuned to look "molecular"
const P = {
  N: 30, // Numero iniziale di atomi nella simulazione
  dt: 0.012, // Passo temporale dell'integrazione
  temp: 1.0, // Scala della velocità iniziale (temperatura)
  sigma: 14, // Distanza caratteristica del potenziale Lennard-Jones
  epsilon: 0.85, // Intensità del potenziale Lennard-Jones
  rCut: 72, // Raggio massimo delle interazioni LJ (cutoff)
  rCut2: 72 * 72, // Cutoff al quadrato per evitare sqrt ripetute
  bondR: 48, // Distanza massima per disegnare legami visuali
  bondR2: 48 * 48, // Distanza legame al quadrato per ottimizzazione
  soft: 0.35, // Softening numerico per stabilità a distanza molto piccola
  drag: 0.9992, // Smorzamento velocità ad ogni step
  maxV: 230, // Velocità massima consentita per atomo
  mouseR: 140, // Raggio d'influenza del mouse
  mouseR2: 140 * 140, // Raggio mouse al quadrato per ottimizzazione
  mouseStrength: 1200, // Intensità della forza esercitata dal mouse
  addOnClick: 5, // Atomi aggiunti quando clicchi
  collisionRestitution: 0.92, // Elasticità degli urti tra atomi (1 = perfettamente elastico)
  thermalKick: 2.0, // Rumore termico casuale applicato alle velocità
  minSpeed: 34, // Velocità minima target per mantenere il moto attivo
  aggregateIntervalMin: 250, // Intervallo minimo (ms) tra due eventi cluster
  aggregateIntervalMax: 650, // Intervallo massimo (ms) tra due eventi cluster
  aggregateDurationMin: 14000, // Durata minima (ms) di un evento cluster
  aggregateDurationMax: 24000, // Durata massima (ms) di un evento cluster
  aggregateGroupMin: 2, // Numero minimo di atomi per singolo cluster
  aggregateGroupMax: 8, // Numero massimo di atomi per singolo cluster
  aggregateGroupsMin: 1, // Numero minimo di cluster simultanei
  aggregateGroupsMax: 6, // Numero massimo di cluster simultanei
  aggregateRadius: 250, // Raggio usato per cercare atomi da aggregare
  aggregateStrength: 220, // Forza di attrazione verso il centro cluster
  aggregateBondK: 220, // Rigidezza delle molle dei legami intra-cluster
  aggregateBondDamping: 2.4, // Smorzamento sui legami intra-cluster
  aggregateRestMin: 8, // Lunghezza minima di riposo dei legami cluster
  aggregateRestMax: 14, // Lunghezza massima di riposo dei legami cluster
  electronCountMin: 1, // Numero minimo di elettroni visuali per atomo
  electronCountMax: 5, // Numero massimo di elettroni visuali per atomo
  electronOrbitMin: 10, // Raggio minimo dell'orbita elettronica visuale
  electronOrbitMax: 68, // Raggio massimo dell'orbita elettronica visuale
  electronSizeMin: 1.4, // Dimensione minima degli elettroni visuali
  electronSizeMax: 2.4, // Dimensione massima degli elettroni visuali
  electronSpeedMin: 0.9, // Velocità angolare minima degli elettroni visuali
  electronSpeedMax: 2.8 // Velocità angolare massima degli elettroni visuali
};

// Utilities
const rand = (a, b) => a + Math.random() * (b - a);
function wrap(x, L) { return (x % L + L) % L; }

function randInt(a, b) {
  return Math.floor(rand(a, b + 1));
}

function createElectrons() {
  const count = randInt(P.electronCountMin, P.electronCountMax);
  const electrons = [];
  for (let i = 0; i < count; i++) {
    electrons.push({
      orbitR: rand(P.electronOrbitMin, P.electronOrbitMax),
      angle: rand(0, Math.PI * 2),
      speed: rand(P.electronSpeedMin, P.electronSpeedMax) * (Math.random() < 0.5 ? -1 : 1),
      size: rand(P.electronSizeMin, P.electronSizeMax)
    });
  }
  return electrons;
}

function initAtoms() {
  state.atoms.length = 0;
  const margin = 40;
  for (let i = 0; i < P.N; i++) {
    state.atoms.push({
      x: rand(margin, state.W - margin),
      y: rand(margin, state.H - margin),
      vx: rand(-1, 1) * P.temp * 120,
      vy: rand(-1, 1) * P.temp * 120,
      r: rand(2.2, 3.2),
      type: Math.random() < 0.18 ? 1 : 0,
      electrons: createElectrons()
    });
  }
}

function addAtomsAt(x, y, n = 6) {
  for (let i = 0; i < n; i++) {
    state.atoms.push({
      x: x + rand(-18, 18),
      y: y + rand(-18, 18),
      vx: rand(-1, 1) * 110,
      vy: rand(-1, 1) * 110,
      r: rand(2.2, 3.2),
      type: Math.random() < 0.25 ? 1 : 0,
      electrons: createElectrons()
    });
  }
}

// Lennard-Jones force (smoothed + cutoff) on pair i-j
function applyPairForces() {
  const atoms = state.atoms;
  for (let i = 0; i < atoms.length; i++) {
    const ai = atoms[i];
    for (let j = i + 1; j < atoms.length; j++) {
      const aj = atoms[j];

      // Minimum-image convention for periodic boundaries
      let dx = ai.x - aj.x;
      let dy = ai.y - aj.y;

      if (dx > state.W / 2) dx -= state.W;
      if (dx < -state.W / 2) dx += state.W;
      if (dy > state.H / 2) dy -= state.H;
      if (dy < -state.H / 2) dy += state.H;

      const r2 = dx * dx + dy * dy;
      if (r2 > P.rCut2) continue;

      const r = Math.sqrt(r2) + P.soft;
      const invR = 1.0 / r;

      // LJ: 24*e*(2*(s/r)^12 - (s/r)^6)/r  (here smoothed & scaled)
      const sr = P.sigma * invR;
      const sr2 = sr * sr;
      const sr6 = sr2 * sr2 * sr2;
      const sr12 = sr6 * sr6;

      // Basic LJ force magnitude
      let f = 24 * P.epsilon * (2 * sr12 - sr6) * invR;

      // Smooth cutoff (taper to 0 near rCut)
      const taper = 1.0 - (r2 / P.rCut2);
      f *= taper * taper;

      // Apply to velocities (symplectic-ish)
      const fx = f * (dx * invR);
      const fy = f * (dy * invR);

      ai.vx += fx * P.dt;
      ai.vy += fy * P.dt;
      aj.vx -= fx * P.dt;
      aj.vy -= fy * P.dt;
    }
  }
}

function applyMouseForce() {
  if (!state.mouse.active) return;
  const mx = state.mouse.x;
  const my = state.mouse.y;
  const atoms = state.atoms;

  for (const a of atoms) {
    const dx = a.x - mx;
    const dy = a.y - my;
    const r2 = dx * dx + dy * dy;
    if (r2 > P.mouseR2) continue;

    const r = Math.sqrt(r2) + 1e-6;
    const invR = 1 / r;

    // Repulsion when moving mouse; mild attraction when mouse is down
    const sign = state.mouse.down ? -0.55 : 1.0;
    const strength = (1.0 - r2 / P.mouseR2);
    const f = sign * P.mouseStrength * strength * strength;

    a.vx += (dx * invR) * f * P.dt * 0.010;
    a.vy += (dy * invR) * f * P.dt * 0.010;
  }
}

function resolveCollisions() {
  const atoms = state.atoms;
  for (let i = 0; i < atoms.length; i++) {
    const ai = atoms[i];
    for (let j = i + 1; j < atoms.length; j++) {
      const aj = atoms[j];

      let dx = aj.x - ai.x;
      let dy = aj.y - ai.y;

      if (dx > state.W / 2) dx -= state.W;
      if (dx < -state.W / 2) dx += state.W;
      if (dy > state.H / 2) dy -= state.H;
      if (dy < -state.H / 2) dy += state.H;

      const r2 = dx * dx + dy * dy;
      const minDist = ai.r + aj.r + 0.9;
      const minDist2 = minDist * minDist;
      if (r2 >= minDist2) continue;

      const r = Math.sqrt(Math.max(r2, 1e-8));
      const nx = dx / r;
      const ny = dy / r;

      const overlap = minDist - r;
      const corr = overlap * 0.52;
      ai.x -= nx * corr;
      ai.y -= ny * corr;
      aj.x += nx * corr;
      aj.y += ny * corr;

      const rvx = aj.vx - ai.vx;
      const rvy = aj.vy - ai.vy;
      const velAlongNormal = rvx * nx + rvy * ny;
      if (velAlongNormal > 0) continue;

      const impulse = -(1 + P.collisionRestitution) * velAlongNormal * 0.5;
      const ix = impulse * nx;
      const iy = impulse * ny;

      ai.vx -= ix;
      ai.vy -= iy;
      aj.vx += ix;
      aj.vy += iy;
    }
  }
}

function applyThermostat() {
  for (let i = 0; i < state.atoms.length; i++) {
    const a = state.atoms[i];
    const bonded = state.aggregation.active && state.aggregation.bondedIds.has(i);
    const kickScale = bonded ? 0.04 : 1.0;
    const minSpeed = bonded ? P.minSpeed * 0.20 : P.minSpeed;

    a.vx += rand(-1, 1) * P.thermalKick * kickScale;
    a.vy += rand(-1, 1) * P.thermalKick * kickScale;

    const v2 = a.vx * a.vx + a.vy * a.vy;
    if (v2 < minSpeed * minSpeed) {
      const angle = rand(0, Math.PI * 2);
      const boost = bonded ? 0.8 : 4.5;
      a.vx += Math.cos(angle) * boost;
      a.vy += Math.sin(angle) * boost;
    }
  }
}

function scheduleAggregation(now) {
  const early = state.aggregation.nextAt === 0 ? 120 : 0;
  state.aggregation.nextAt = now + early + rand(P.aggregateIntervalMin, P.aggregateIntervalMax);
}

function startAggregation(now) {
  const atoms = state.atoms;
  if (atoms.length < 6) {
    scheduleAggregation(now);
    return;
  }

  const used = new Set();
  const bondedIds = new Set();
  const groups = [];
  const targetGroups = randInt(P.aggregateGroupsMin, P.aggregateGroupsMax);

  for (let g = 0; g < targetGroups; g++) {
    const seedIndex = randInt(0, atoms.length - 1);
    if (used.has(seedIndex)) continue;

    const seed = atoms[seedIndex];
    const nearby = [];
    for (let i = 0; i < atoms.length; i++) {
      if (used.has(i)) continue;
      if (i === seedIndex) continue;

      let dx = atoms[i].x - seed.x;
      let dy = atoms[i].y - seed.y;
      if (dx > state.W / 2) dx -= state.W;
      if (dx < -state.W / 2) dx += state.W;
      if (dy > state.H / 2) dy -= state.H;
      if (dy < -state.H / 2) dy += state.H;

      const d2 = dx * dx + dy * dy;
      if (d2 < P.aggregateRadius * P.aggregateRadius) {
        nearby.push({ i, d2 });
      }
    }

    nearby.sort((a, b) => a.d2 - b.d2);
    if (nearby.length < P.aggregateGroupMin - 1) {
      for (let i = 0; i < atoms.length; i++) {
        if (i === seedIndex || used.has(i)) continue;
        if (!nearby.some((n) => n.i === i)) {
          nearby.push({ i, d2: 1e12 + i });
        }
      }
    }

    const size = Math.min(randInt(P.aggregateGroupMin, P.aggregateGroupMax), nearby.length + 1);
    if (size < 2) continue;

    const members = [seedIndex];
    for (let k = 0; k < size - 1; k++) {
      members.push(nearby[k].i);
    }

    for (const id of members) {
      used.add(id);
      bondedIds.add(id);
    }

    const bonds = [];
    for (let b = 1; b < members.length; b++) {
      bonds.push({
        i: members[b - 1],
        j: members[b],
        rest: rand(P.aggregateRestMin, P.aggregateRestMax)
      });
    }
    if (members.length >= 4) {
      for (let b = 2; b < members.length; b += 2) {
        bonds.push({
          i: members[0],
          j: members[b],
          rest: rand(P.aggregateRestMin + 2, P.aggregateRestMax + 4)
        });
      }
    }

    groups.push({ members, bonds });
  }

  if (groups.length === 0) {
    scheduleAggregation(now);
    return;
  }

  state.aggregation.active = true;
  state.aggregation.groups = groups;
  state.aggregation.bondedIds = bondedIds;
  state.aggregation.endAt = now + rand(P.aggregateDurationMin, P.aggregateDurationMax);
}

function updateAggregation(now) {
  if (!state.aggregation.nextAt) {
    scheduleAggregation(now);
  }

  if (!state.aggregation.active && now >= state.aggregation.nextAt) {
    startAggregation(now);
  }

  if (state.aggregation.active && now >= state.aggregation.endAt) {
    state.aggregation.active = false;
    state.aggregation.groups = [];
    state.aggregation.bondedIds = new Set();
    scheduleAggregation(now);
  }
}

function applyAggregationForce() {
  if (!state.aggregation.active) return;

  for (const group of state.aggregation.groups) {
    if (!group.members || group.members.length < 2) continue;

    let cx = 0;
    let cy = 0;
    for (const idx of group.members) {
      cx += state.atoms[idx].x;
      cy += state.atoms[idx].y;
    }
    cx /= group.members.length;
    cy /= group.members.length;

    for (const idx of group.members) {
      const a = state.atoms[idx];
      let dx = cx - a.x;
      let dy = cy - a.y;

      if (dx > state.W / 2) dx -= state.W;
      if (dx < -state.W / 2) dx += state.W;
      if (dy > state.H / 2) dy -= state.H;
      if (dy < -state.H / 2) dy += state.H;

      const d2 = dx * dx + dy * dy;
      if (d2 < 1e-8) continue;

      const d = Math.sqrt(d2);
      const strength = Math.min(1.8, d / 16);
      a.vx += (dx / d) * P.aggregateStrength * strength * P.dt * 0.018;
      a.vy += (dy / d) * P.aggregateStrength * strength * P.dt * 0.018;
    }

    for (const bond of group.bonds) {
      const ai = state.atoms[bond.i];
      const aj = state.atoms[bond.j];

      let dx = aj.x - ai.x;
      let dy = aj.y - ai.y;
      if (dx > state.W / 2) dx -= state.W;
      if (dx < -state.W / 2) dx += state.W;
      if (dy > state.H / 2) dy -= state.H;
      if (dy < -state.H / 2) dy += state.H;

      const d2 = dx * dx + dy * dy;
      if (d2 < 1e-8) continue;

      const d = Math.sqrt(d2);
      const nx = dx / d;
      const ny = dy / d;

      const rvx = aj.vx - ai.vx;
      const rvy = aj.vy - ai.vy;
      const velAlong = rvx * nx + rvy * ny;

      const spring = P.aggregateBondK * (d - bond.rest);
      const damp = -P.aggregateBondDamping * velAlong;
      const f = spring + damp;

      const fx = nx * f * P.dt * 0.018;
      const fy = ny * f * P.dt * 0.018;
      ai.vx += fx;
      ai.vy += fy;
      aj.vx -= fx;
      aj.vy -= fy;
    }
  }
}

function integrate() {
  const atoms = state.atoms;
  const maxV = P.maxV;

  for (const a of atoms) {
    // Damping
    a.vx *= P.drag;
    a.vy *= P.drag;

    // Clamp velocity for stability
    const v2 = a.vx * a.vx + a.vy * a.vy;
    if (v2 > maxV * maxV) {
      const s = maxV / Math.sqrt(v2);
      a.vx *= s;
      a.vy *= s;
    }

    a.x += a.vx * P.dt;
    a.y += a.vy * P.dt;

    // Periodic boundaries
    a.x = wrap(a.x, state.W);
    a.y = wrap(a.y, state.H);
  }
}

function draw() {
  const { W, H } = state;
  ctx.clearRect(0, 0, W, H);

  // bonds / connections
  const atoms = state.atoms;
  ctx.lineWidth = 1.4;

  for (let i = 0; i < atoms.length; i++) {
    const ai = atoms[i];
    for (let j = i + 1; j < atoms.length; j++) {
      const aj = atoms[j];

      // Minimum-image for drawing (so bonds don't jump across edges too badly)
      let dx = ai.x - aj.x;
      let dy = ai.y - aj.y;
      if (dx > W / 2) dx -= W;
      if (dx < -W / 2) dx += W;
      if (dy > H / 2) dy -= H;
      if (dy < -H / 2) dy += H;

      const r2 = dx * dx + dy * dy;
      if (r2 > P.bondR2) continue;

      const r = Math.sqrt(r2);
      const a = 1.0 - r / Math.sqrt(P.bondR2);
      const alpha = 0.16 + 0.54 * (a * a);

      // subtle dual-tone lines
      ctx.strokeStyle = `rgba(124,243,211,${alpha})`;
      ctx.beginPath();
      ctx.moveTo(ai.x, ai.y);
      ctx.lineTo(ai.x - dx, ai.y - dy);
      ctx.stroke();
    }
  }

  if (state.aggregation.active) {
    ctx.lineWidth = 1.8;
    for (const group of state.aggregation.groups) {
      for (const bond of group.bonds || []) {
        const ai = state.atoms[bond.i];
        const aj = state.atoms[bond.j];

        let dx = ai.x - aj.x;
        let dy = ai.y - aj.y;
        if (dx > W / 2) dx -= W;
        if (dx < -W / 2) dx += W;
        if (dy > H / 2) dy -= H;
        if (dy < -H / 2) dy += H;

        const dist = Math.sqrt(dx * dx + dy * dy);
        const alpha = Math.max(0.18, 0.52 - 0.02 * Math.abs(dist - bond.rest));
        ctx.strokeStyle = `rgba(154,167,255,${alpha})`;
        ctx.beginPath();
        ctx.moveTo(ai.x, ai.y);
        ctx.lineTo(ai.x - dx, ai.y - dy);
        ctx.stroke();
      }
    }
    ctx.lineWidth = 1;
  }

  // atoms
  for (const a of atoms) {
    const glow = a.type ? 0.80 : 0.62;
    const col = a.type ? '154,167,255' : '124,243,211';

    // glow
    ctx.beginPath();
    ctx.fillStyle = `rgba(${col},${glow * 0.30})`;
    ctx.arc(a.x, a.y, a.r * 5.2, 0, Math.PI * 2);
    ctx.fill();

    // core
    ctx.beginPath();
    ctx.fillStyle = `rgba(${col},${0.92})`;
    ctx.arc(a.x, a.y, a.r * 1.12, 0, Math.PI * 2);
    ctx.fill();

    // core highlight
    ctx.beginPath();
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.arc(a.x - a.r * 0.28, a.y - a.r * 0.28, a.r * 0.38, 0, Math.PI * 2);
    ctx.fill();

    // electrons (visual only, no dynamics)
    const electrons = a.electrons || [];
    for (const e of electrons) {
      const ang = e.angle + state.t * e.speed;
      const ex = a.x + Math.cos(ang) * e.orbitR;
      const ey = a.y + Math.sin(ang) * e.orbitR;

      ctx.beginPath();
      ctx.fillStyle = `rgba(${col},0.30)`;
      ctx.arc(ex, ey, e.size * 2.4, 0, Math.PI * 2);
      ctx.fill();

      ctx.beginPath();
      ctx.fillStyle = `rgba(${col},0.98)`;
      ctx.arc(ex, ey, e.size, 0, Math.PI * 2);
      ctx.fill();

      ctx.beginPath();
      ctx.fillStyle = 'rgba(255,255,255,0.92)';
      ctx.arc(ex, ey, e.size * 0.55, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // mouse influence ring (very subtle)
  if (state.mouse.active) {
    ctx.beginPath();
    ctx.strokeStyle = `rgba(255,255,255,${state.mouse.down ? 0.10 : 0.06})`;
    ctx.arc(state.mouse.x, state.mouse.y, 34, 0, Math.PI * 2);
    ctx.stroke();
  }
}

function tick() {
  const now = performance.now();
  updateAggregation(now);

  if (state.running) {
    // multi-substeps for stability (cheap)
    const sub = 4;
    for (let k = 0; k < sub; k++) {
      state.t += P.dt;
      applyPairForces();
      applyMouseForce();
      applyAggregationForce();
      resolveCollisions();
      applyThermostat();
      integrate();
    }
  }
  draw();
  requestAnimationFrame(tick);
}

// Events
window.addEventListener('mousemove', (e) => {
  state.mouse.x = e.clientX;
  state.mouse.y = e.clientY;
  state.mouse.active = true;
}, { passive: true });

window.addEventListener('mouseleave', () => {
  state.mouse.active = false;
  state.mouse.down = false;
});

window.addEventListener('mousedown', (e) => {
  state.mouse.down = true;
  addAtomsAt(e.clientX, e.clientY, P.addOnClick);
});

window.addEventListener('mouseup', () => { state.mouse.down = false; });

window.addEventListener('keydown', (e) => {
  if (e.code === 'Space') {
    state.running = !state.running;
    e.preventDefault();
  }
});

// Start
resize();
initAtoms();
tick();
