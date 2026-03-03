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
  aggregation: {
    active: false,
    nextAt: 0,
    endAt: 0,
    groups: [],
    bondedIds: new Set(),
    clusterBirthMs: new Map(),
    clusterLifeMs: new Map(),
    atomCooldownUntil: new Map()
  }
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
  N: 60, // Numero iniziale di atomi nella simulazione
  dt: 0.012, // Passo temporale dell'integrazione
  temp: 0.01, // Scala della velocità iniziale (temperatura)
  sigma: 14, // Distanza caratteristica del potenziale Lennard-Jones
  epsilon: 1.0, // Intensità del potenziale Lennard-Jones
  rCut: 72, // Raggio massimo delle interazioni LJ (cutoff)
  rCut2: 72 * 72, // Cutoff al quadrato per evitare sqrt ripetute
  bondR: 48, // Distanza massima per disegnare legami visuali
  bondR2: 48 * 48, // Distanza legame al quadrato per ottimizzazione
  soft: 0.35, // Softening numerico per stabilità a distanza molto piccola
  drag: 0.99992, // Smorzamento velocità ad ogni step
  maxV: 230, // Velocità massima consentita per atomo
  mouseR: 140, // Raggio d'influenza del mouse
  mouseR2: 140 * 140, // Raggio mouse al quadrato per ottimizzazione
  mouseStrength: 1200, // Intensità della forza esercitata dal mouse
  addOnClick: 5, // Atomi aggiunti quando clicchi
  collisionRestitution: 0.92, // Elasticità degli urti tra atomi (1 = perfettamente elastico)
  thermalKick: 3.0, // Rumore termico casuale applicato alle velocità
  minSpeed: 34, // Velocità minima target per mantenere il moto attivo
  aggregateIntervalMin: 0, // Intervallo minimo (ms) tra due eventi cluster
  aggregateIntervalMax: 20, // Intervallo massimo (ms) tra due eventi cluster
  aggregateDurationMin: 20000, // Durata minima (ms) di un evento cluster
  aggregateDurationMax: 100000, // Durata massima (ms) di un evento cluster
  aggregateGroupMin: 2, // Numero minimo di atomi per singolo cluster
  aggregateGroupMax: 5, // Numero massimo di atomi per singolo cluster
  aggregateGroupsMin: 8, // Numero minimo di cluster simultanei
  aggregateGroupsMax: 24, // Numero massimo di cluster simultanei
  aggregateTargetCoverage: 0.98, // Quota target di atomi da includere nei cluster (0..1)
  aggregateRadius: 280, // Raggio usato per cercare atomi da aggregare
  aggregateLinkMax: 120, // Distanza massima consentita per creare un legame intra-cluster
  aggregateStrength: 150, // Forza di attrazione verso il centro cluster
  aggregateBondK: 280, // Rigidezza delle molle dei legami intra-cluster
  aggregateBondDamping: 2.4, // Smorzamento sui legami intra-cluster
  aggregateRestMin: 8, // Lunghezza minima di riposo dei legami cluster
  aggregateRestMax: 14, // Lunghezza massima di riposo dei legami cluster
  aggregateExplodeAfterMin: 3000, // Tempo minimo (ms) prima che un cluster esploda
  aggregateExplodeAfterMax: 7000, // Tempo massimo (ms) prima che un cluster esploda
  aggregateExplodeImpulse: 190, // Intensità dell'impulso di esplosione
  aggregateExplodeJitter: 30, // Rumore casuale aggiuntivo durante l'esplosione
  aggregateExplodeCooldown: 900, // Cooldown (ms) dopo esplosione prima di riformare cluster
  electronCountMin: 1, // Numero minimo di elettroni visuali per atomo
  electronCountMax: 10, // Numero massimo di elettroni visuali per atomo
  electronOrbitMin: 10, // Raggio minimo dell'orbita elettronica visuale
  electronOrbitMax: 68, // Raggio massimo dell'orbita elettronica visuale
  electronSizeMin: 1.4, // Dimensione minima degli elettroni visuali
  electronSizeMax: 2.4, // Dimensione massima degli elettroni visuali
  electronSpeedMin: 0.9, // Velocità angolare minima degli elettroni visuali
  electronSpeedMax: 2.8 // Velocità angolare massima degli elettroni visuali
};

const ATOM_COLORS = [
  { r: 124, g: 243, b: 211, glow: 0.62 },
  { r: 154, g: 167, b: 255, glow: 0.80 },
  { r: 255, g: 146, b: 193, glow: 0.78 },
  { r: 255, g: 201, b: 125, glow: 0.74 },
  { r: 145, g: 255, b: 157, glow: 0.70 },
  { r: 127, g: 214, b: 255, glow: 0.72 }
];

// Utilities
const rand = (a, b) => a + Math.random() * (b - a);
function wrap(x, L) { return (x % L + L) % L; }

function randInt(a, b) {
  return Math.floor(rand(a, b + 1));
}

function pickAtomColor() {
  return ATOM_COLORS[randInt(0, ATOM_COLORS.length - 1)];
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
      color: pickAtomColor(),
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
      color: pickAtomColor(),
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
  const early = state.aggregation.nextAt === 0 ? 0 : 0;
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
  const avgGroupSize = (P.aggregateGroupMin + P.aggregateGroupMax) * 0.5;
  const coverageGroups = Math.ceil((atoms.length * P.aggregateTargetCoverage) / avgGroupSize);
  const targetGroups = Math.max(randInt(P.aggregateGroupsMin, P.aggregateGroupsMax), coverageGroups);

  for (let g = 0; g < targetGroups; g++) {
    const available = [];
    for (let i = 0; i < atoms.length; i++) {
      if (!used.has(i)) available.push(i);
    }
    if (available.length < 2) break;

    const seedIndex = available[randInt(0, available.length - 1)];

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

    const size = Math.min(randInt(P.aggregateGroupMin, P.aggregateGroupMax), nearby.length + 1);
    if (size < P.aggregateGroupMin) continue;

    const members = [seedIndex];
    for (let k = 0; k < size - 1; k++) {
      members.push(nearby[k].i);
    }

    for (const id of members) {
      used.add(id);
      bondedIds.add(id);
    }

    const linkMax2 = P.aggregateLinkMax * P.aggregateLinkMax;
    const bonds = [];
    for (let b = 1; b < members.length; b++) {
      const a0 = atoms[members[b - 1]];
      const a1 = atoms[members[b]];
      let dx = a0.x - a1.x;
      let dy = a0.y - a1.y;
      if (dx > state.W / 2) dx -= state.W;
      if (dx < -state.W / 2) dx += state.W;
      if (dy > state.H / 2) dy -= state.H;
      if (dy < -state.H / 2) dy += state.H;
      if (dx * dx + dy * dy > linkMax2) continue;

      bonds.push({
        i: members[b - 1],
        j: members[b],
        rest: rand(P.aggregateRestMin, P.aggregateRestMax)
      });
    }
    if (members.length >= 4) {
      for (let b = 2; b < members.length; b += 2) {
        const a0 = atoms[members[0]];
        const a1 = atoms[members[b]];
        let dx = a0.x - a1.x;
        let dy = a0.y - a1.y;
        if (dx > state.W / 2) dx -= state.W;
        if (dx < -state.W / 2) dx += state.W;
        if (dy > state.H / 2) dy -= state.H;
        if (dy < -state.H / 2) dy += state.H;
        if (dx * dx + dy * dy > linkMax2) continue;

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
  const atoms = state.atoms;
  const linkMax = P.aggregateLinkMax;
  const linkMax2 = linkMax * linkMax;
  const atomCooldownUntil = state.aggregation.atomCooldownUntil;

  for (const [atomIdx, until] of atomCooldownUntil.entries()) {
    if (until <= now) atomCooldownUntil.delete(atomIdx);
  }

  const adjacency = Array.from({ length: atoms.length }, () => []);
  const closeEdges = [];

  for (let i = 0; i < atoms.length; i++) {
    const ai = atoms[i];
    for (let j = i + 1; j < atoms.length; j++) {
      const aj = atoms[j];

      if ((atomCooldownUntil.get(i) || 0) > now) continue;
      if ((atomCooldownUntil.get(j) || 0) > now) continue;

      let dx = ai.x - aj.x;
      let dy = ai.y - aj.y;
      if (dx > state.W / 2) dx -= state.W;
      if (dx < -state.W / 2) dx += state.W;
      if (dy > state.H / 2) dy -= state.H;
      if (dy < -state.H / 2) dy += state.H;

      const d2 = dx * dx + dy * dy;
      if (d2 > linkMax2) continue;

      const d = Math.sqrt(Math.max(d2, 1e-8));
      const rest = Math.max(P.aggregateRestMin, Math.min(P.aggregateRestMax, d));

      adjacency[i].push(j);
      adjacency[j].push(i);
      closeEdges.push({ i, j, rest });
    }
  }

  const visited = new Array(atoms.length).fill(false);
  const groups = [];
  const bondedIds = new Set();
  const prevBirth = state.aggregation.clusterBirthMs;
  const prevLife = state.aggregation.clusterLifeMs;
  const nextBirth = new Map();
  const nextLife = new Map();

  for (let i = 0; i < atoms.length; i++) {
    if (visited[i] || adjacency[i].length === 0) continue;

    const stack = [i];
    visited[i] = true;
    const members = [];

    while (stack.length) {
      const node = stack.pop();
      members.push(node);
      for (const nb of adjacency[node]) {
        if (visited[nb]) continue;
        visited[nb] = true;
        stack.push(nb);
      }
    }

    if (members.length < 2) continue;
    members.sort((a, b) => a - b);
    const groupKey = members.join('-');

    const memberSet = new Set(members);
    const bonds = closeEdges.filter((e) => memberSet.has(e.i) && memberSet.has(e.j));
    if (bonds.length === 0) continue;

    const bornAt = prevBirth.has(groupKey) ? prevBirth.get(groupKey) : now;
    const lifeMs = prevLife.has(groupKey)
      ? prevLife.get(groupKey)
      : rand(P.aggregateExplodeAfterMin, P.aggregateExplodeAfterMax);

    if (now - bornAt >= lifeMs) {
      const seed = atoms[members[0]];
      let cx = seed.x;
      let cy = seed.y;
      for (let m = 1; m < members.length; m++) {
        const a = atoms[members[m]];
        let dx = a.x - seed.x;
        let dy = a.y - seed.y;
        if (dx > state.W / 2) dx -= state.W;
        if (dx < -state.W / 2) dx += state.W;
        if (dy > state.H / 2) dy -= state.H;
        if (dy < -state.H / 2) dy += state.H;
        cx += seed.x + dx;
        cy += seed.y + dy;
      }
      cx /= members.length;
      cy /= members.length;

      for (const idx of members) {
        const a = atoms[idx];
        let dx = a.x - cx;
        let dy = a.y - cy;
        if (dx > state.W / 2) dx -= state.W;
        if (dx < -state.W / 2) dx += state.W;
        if (dy > state.H / 2) dy -= state.H;
        if (dy < -state.H / 2) dy += state.H;

        let d2 = dx * dx + dy * dy;
        if (d2 < 1e-8) {
          const ang = rand(0, Math.PI * 2);
          dx = Math.cos(ang);
          dy = Math.sin(ang);
          d2 = 1;
        }

        const invD = 1 / Math.sqrt(d2);
        const impulse = P.aggregateExplodeImpulse + rand(-P.aggregateExplodeJitter, P.aggregateExplodeJitter);
        a.vx += dx * invD * impulse * P.dt * 0.02;
        a.vy += dy * invD * impulse * P.dt * 0.02;
        atomCooldownUntil.set(idx, now + P.aggregateExplodeCooldown);
      }

      continue;
    }

    nextBirth.set(groupKey, bornAt);
    nextLife.set(groupKey, lifeMs);

    for (const id of members) bondedIds.add(id);
    groups.push({ members, bonds });
  }

  state.aggregation.clusterBirthMs = nextBirth;
  state.aggregation.clusterLifeMs = nextLife;
  state.aggregation.groups = groups;
  state.aggregation.bondedIds = bondedIds;
  state.aggregation.active = groups.length > 0;
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
      const ci = ai.color || ATOM_COLORS[0];
      const cj = aj.color || ATOM_COLORS[1];
      const br = ((ci.r + cj.r) * 0.5) | 0;
      const bg = ((ci.g + cj.g) * 0.5) | 0;
      const bb = ((ci.b + cj.b) * 0.5) | 0;

      // subtle dual-tone lines
      ctx.strokeStyle = `rgba(${br},${bg},${bb},${alpha})`;
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
        const ci = ai.color || ATOM_COLORS[0];
        const cj = aj.color || ATOM_COLORS[1];
        const br = ((ci.r + cj.r) * 0.5) | 0;
        const bg = ((ci.g + cj.g) * 0.5) | 0;
        const bb = ((ci.b + cj.b) * 0.5) | 0;
        ctx.strokeStyle = `rgba(${br},${bg},${bb},${alpha})`;
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
    const c = a.color || ATOM_COLORS[0];
    const glow = c.glow;
    const col = `${c.r},${c.g},${c.b}`;

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
