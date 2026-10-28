"use strict";

// ---------- utilidades ----------
const $ = (id) => document.getElementById(id);
const view = $("view"), ctx = view.getContext("2d");
const mini = $("mini"), mctx = mini.getContext("2d");
const bufCanvas = document.createElement("canvas");   // buffer estatico unico (mapa + recorrido) con margen M
const bufCtx = bufCanvas.getContext("2d");
const miniStatic = document.createElement("canvas");
const tl = $("tl"), tctx = (tl && tl.getContext) ? tl.getContext("2d") : null;
let tlStatic = null, tlPx = -1;
let miniNeedStatic = true;
let lastStats = 0;
let staticTarget = null, staticZoom = 0;
let mapDirty = true, telDirty = true;   // compatibilidad: fuerzan un render completo del buffer

const DIMS = {
  6959: [41.3447, 40.0, 0.6],
  8558: [40.40, 5.13, 3.05],
  3458: [40.40, 5.13, 3.05],
  2898: [4.09, 5.42, 0.05],
};
const COLORS = {
  6959: "#8a8a8a",
  8558: "#4a86e8",
  3458: "#3fb950",
  2898: "#a0b840",
};
const VEH_NAMES = {
  411: "Infernus", 495: "Sandking", 480: "Comet", 541: "Bullet", 402: "Buffalo", 451: "Turismo",
  429: "Banshee", 506: "Super GT", 415: "Cheetah", 560: "Sultan", 562: "Elegy", 559: "Jester",
  565: "Flash", 494: "Hotring Racer", 502: "Hotring Racer A", 503: "Hotring Racer B", 587: "Euros",
  477: "ZR-350", 475: "Sabre", 603: "Phoenix", 579: "Huntley", 424: "BF Injection", 500: "Mesa",
  568: "Bandito", 471: "Quad", 522: "NRG-500", 521: "FCR-900", 463: "Freeway", 468: "Sanchez",
  461: "PCJ-600", 581: "BF-400", 535: "Slamvan", 534: "Remington", 567: "Savanna", 576: "Tornado",
};
function vehName(m) { return VEH_NAMES[m] || ("Modelo " + m); }
const DEFAULT_DIM = [10, 10, 2];
const DEFAULT_COLOR = "#b07070";
const EDGES = [[0,1],[0,2],[0,4],[1,3],[1,5],[2,3],[2,6],[3,7],[4,5],[4,6],[5,7],[6,7]];

function num(v, d) { const n = parseFloat(v); return isNaN(n) ? (d || 0) : n; }

// datos planos por pieza para dibujar rapido: 8 esquinas en Float64Array, centro y radio para descarte
function finishObj(o) {
  const cs = o.corners, f = new Float64Array(24);
  let cx = 0, cy = 0, cz = 0;
  for (let k = 0; k < 8; k++) {
    const q = cs[k];
    f[k * 3] = q[0]; f[k * 3 + 1] = q[1]; f[k * 3 + 2] = q[2];
    cx += q[0]; cy += q[1]; cz += q[2];
  }
  cx /= 8; cy /= 8; cz /= 8;
  let r = 0;
  for (let k = 0; k < 8; k++) r = Math.max(r, Math.hypot(f[k * 3] - cx, f[k * 3 + 1] - cy, f[k * 3 + 2] - cz));
  o.f = f; o.cx = cx; o.cy = cy; o.cz = cz; o.r = r; o.zavg = cz;
  return o;
}
function buildGroups(objs) {
  const m = new Map();
  for (let i = 0; i < objs.length; i++) {
    let a = m.get(objs[i].color);
    if (!a) m.set(objs[i].color, a = []);
    a.push(i);
  }
  return m;
}

function rotMatrix(rx, ry, rz) {
  const cx = Math.cos(rx*Math.PI/180), sx = Math.sin(rx*Math.PI/180);
  const cy = Math.cos(ry*Math.PI/180), sy = Math.sin(ry*Math.PI/180);
  const cz = Math.cos(rz*Math.PI/180), sz = Math.sin(rz*Math.PI/180);
  return [
    [cz*cy, cz*sy*sx - sz*cx, cz*sy*cx + sz*sx],
    [sz*cy, sz*sy*sx + cz*cx, sz*sy*cx - cz*sx],
    [-sy, cy*sx, cy*cx],
  ];
}

// ---------- estado ----------
let mapObjs = [];
let mapPickups = [];
let carStyle = "solid";     // solid | wire | silhouette
let mapMarkers = [];
let showMarkers = false;   // markers del .map = decoracion (toggle)
let markerMode = "arrow";
let speedMode = "numtacho";   // num | numtacho | tachonum
let showPickups = true;
let telObjs = [];
let samples = [];
let meta = null;
let idx = 0;
let playing = false;
let lastFrame = 0;
let needStatic = true;
let dragging = false;
let follow = false;
let quality = "auto";
let showMap = true;
let showTel = true;
let showGrid = false;
let highlightZ = null;
let airSamples = 0, invSamples = 0;
let playSpeed = 1; // [min,max] para pintar un rango de altura
let playbackHz = 20; // Se calculará dinámicamente
let playT = 0, lastLoopIdx = -1;     // reloj de reproduccion: ms de TELEMETRIA (no indice de muestra)
let mapGroups = new Map(), telGroups = new Map();   // piezas agrupadas por color (1 trazo por color)

let W = 800, H = 600, M = 256;
const STEP = 64;   // px de pan antes de desplazar el buffer y pintar solo las franjas nuevas
const cam = { yaw: 0.75, pitch: 0.55, zoom: 2.2, target: [0,0,0] };
let fps = 0, fpsAcc = 0, fpsN = 0;

// ---------- parseo ----------
function parseMap(text) {
  const clean = text.replace(/edf:/g, "edf_");
  const doc = new DOMParser().parseFromString(clean, "application/xml");
  if (doc.querySelector && doc.querySelector("parsererror")) throw new Error("XML inválido");
  const out = [];
  for (const e of doc.getElementsByTagName("object")) {
    const model = parseInt(e.getAttribute("model"), 10) || 0;
    const d = DIMS[model] || DEFAULT_DIM;
    const p = [num(e.getAttribute("posX")), num(e.getAttribute("posY")), num(e.getAttribute("posZ"))];
    const R = rotMatrix(num(e.getAttribute("rotX")), num(e.getAttribute("rotY")), num(e.getAttribute("rotZ")));
    const corners = [];
    for (const sx of [-1,1]) for (const sy of [-1,1]) for (const sz of [-1,1]) {
      const lx = sx*d[0]/2, ly = sy*d[1]/2, lz = sz*d[2]/2;
      corners.push([
        R[0][0]*lx + R[0][1]*ly + R[0][2]*lz + p[0],
        R[1][0]*lx + R[1][1]*ly + R[1][2]*lz + p[1],
        R[2][0]*lx + R[2][1]*ly + R[2][2]*lz + p[2],
      ]);
    }
    out.push(finishObj({ corners, color: COLORS[model] || DEFAULT_COLOR, id: e.getAttribute("id") || "" }));
  }
  mapMarkers = [];
  for (const e of doc.getElementsByTagName("marker")) {
    mapMarkers.push({
      type: e.getAttribute("type") || "",
      size: num(e.getAttribute("size"), 1),
      x: num(e.getAttribute("posX")),
      y: num(e.getAttribute("posY")),
      z: num(e.getAttribute("posZ")),
    });
  }
  mapPickups = [];
  for (const e of doc.getElementsByTagName("racepickup")) {
    mapPickups.push({
      type: e.getAttribute("type") || "",
      x: num(e.getAttribute("posX")),
      y: num(e.getAttribute("posY")),
      z: num(e.getAttribute("posZ")),
    });
  }
  return out;
}

function parseTel(text) {
  const out = [], lines = text.split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line);
      if (!o || typeof o !== "object") continue;
      if (o.type === "meta") meta = o;
      else if (!o.type && typeof o.x === "number") out.push(o);
    } catch (_) { /* linea rota */ }
  }
  return out;
}

function buildTelObjs() {
  telObjs = [];
  const seen = new Set();
  for (const s of samples) {
    if (!s.oc || seen.has(s.oc)) continue;
    if (typeof s.ox !== "number" || typeof s.orx !== "number") continue;
    seen.add(s.oc);
    const dd = DIMS[s.om] || DEFAULT_DIM;
    const vx = (s.bx1 != null && s.bx2 != null) ? [s.bx1, s.bx2] : [-dd[0]/2, dd[0]/2];
    const vy = (s.by1 != null && s.by2 != null) ? [s.by1, s.by2] : [-dd[1]/2, dd[1]/2];
    const vz = (s.bz1 != null && s.bz2 != null) ? [s.bz1, s.bz2] : [-dd[2]/2, dd[2]/2];
    const R = rotMatrix(s.orx, s.ory, s.orz);
    const p = [s.ox, s.oy, s.oz];
    const corners = [];
    for (const lx of vx) for (const ly of vy) for (const lz of vz) {
      corners.push([
        R[0][0]*lx + R[0][1]*ly + R[0][2]*lz + p[0],
        R[1][0]*lx + R[1][1]*ly + R[1][2]*lz + p[1],
        R[2][0]*lx + R[2][1]*ly + R[2][2]*lz + p[2],
      ]);
    }
    telObjs.push(finishObj({ corners, color: COLORS[s.om] || DEFAULT_COLOR }));
  }
  telGroups = buildGroups(telObjs);
}

function curIndex() {
  if (!samples.length) return -1;
  const i = Math.floor(idx);
  return Math.min(samples.length - 1, Math.max(0, i));
}

// ---------- pista precomputada: tiempos reales, spline monotona, angulos continuos ----------
// La telemetria se graba con setTimer(50ms): los timers de MTA caen en limites de frame, asi que los
// intervalos reales son 33/50/67 ms. Reproducir a ritmo fijo por INDICE mete tirones proporcionales
// a la velocidad. Aqui se reproduce por el tiempo real `t` y se interpola con una cubica de Hermite
// (tangentes PCHIP: C1, pasa por todas las muestras y NO se sale de ellas -> sin rebotes en choques).
let trk = null;
const smoothOut = { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0 };
let smoothKey = NaN;
const BUCKETS = 12;
const BCOL = Array.from({ length: BUCKETS }, (_, b) => `hsl(${210 - 210 * (b / (BUCKETS - 1))}, 85%, 55%)`);

function pchipTangents(V, Tm, out) {
  const n = V.length;
  if (n < 2) { out.fill(0); return; }
  const h = new Float64Array(n - 1), d = new Float64Array(n - 1);
  for (let i = 0; i < n - 1; i++) { h[i] = Tm[i + 1] - Tm[i]; d[i] = (V[i + 1] - V[i]) / h[i]; }
  out[0] = d[0]; out[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) {
    const d0 = d[i - 1], d1 = d[i];
    if (d0 * d1 <= 0) { out[i] = 0; continue; }
    const w1 = 2 * h[i] + h[i - 1], w2 = h[i] + 2 * h[i - 1];
    out[i] = (w1 + w2) / (w1 / d0 + w2 / d1);
  }
}

function prepTrack() {
  smoothKey = NaN;
  const n = samples.length;
  if (!n) { trk = null; return; }
  const T = new Float64Array(n), X = new Float64Array(n), Y = new Float64Array(n), Z = new Float64Array(n);
  const RX = new Float64Array(n), RY = new Float64Array(n), RZ = new Float64Array(n);
  const BK = new Uint8Array(n), FL = new Uint8Array(n), NIT = new Uint8Array(n);
  let prev = -Infinity;
  for (let i = 0; i < n; i++) {
    const s = samples[i];
    let tm = typeof s.t === "number" ? s.t : i * 50;
    if (!(tm > prev)) tm = prev + 1;                 // estrictamente creciente
    T[i] = prev = tm;
    X[i] = s.x; Y[i] = s.y; Z[i] = s.z;
    const rx = num(s.rx), ry = num(s.ry), rz = num(s.rz);
    // angulos "desenrollados": continuos aunque den la vuelta (loops, derrapes)
    RX[i] = i ? rx + Math.round((RX[i - 1] - rx) / 360) * 360 : rx;
    RY[i] = i ? ry + Math.round((RY[i - 1] - ry) / 360) * 360 : ry;
    RZ[i] = i ? rz + Math.round((RZ[i - 1] - rz) / 360) * 360 : rz;
    BK[i] = Math.max(0, Math.min(BUCKETS - 1, Math.floor(num(s.s) / 220 * BUCKETS)));
    const air = !s.oc, inv = Math.cos(rx * Math.PI / 180) * Math.cos(ry * Math.PI / 180) < -0.3;
    FL[i] = (inv ? 2 : 0) | (air ? 1 : 0);
    NIT[i] = num(s.nit) === 1 ? 1 : 0;
  }
  const MX = new Float64Array(n), MY = new Float64Array(n), MZ = new Float64Array(n);
  pchipTangents(X, T, MX); pchipTangents(Y, T, MY); pchipTangents(Z, T, MZ);
  const VCH = [];                                   // indices donde cambia el vehiculo
  for (let i = 1; i < n; i++) {
    const a = samples[i - 1].veh, b = samples[i].veh;
    if (a != null && b != null && a !== b) VCH.push(i);
  }
  trk = { n, T, X, Y, Z, RX, RY, RZ, MX, MY, MZ, BK, FL, NIT, VCH };
}

// tiempo (ms de telemetria) -> indice fraccional; la parte fraccional es la fraccion de TIEMPO del tramo
function timeToIdx(tm) {
  const T = trk.T, n = trk.n;
  if (n < 2 || tm <= T[0]) return 0;
  if (tm >= T[n - 1]) return n - 1;
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (T[mid] <= tm) lo = mid; else hi = mid; }
  return lo + (tm - T[lo]) / (T[hi] - T[lo]);
}
function idxToTime(f) {
  const T = trk.T, n = trk.n;
  if (n < 2) return 0;
  let i = Math.floor(f);
  i = i < 0 ? 0 : i > n - 2 ? n - 2 : i;
  const u = Math.max(0, Math.min(1, f - i));
  return T[i] + (T[i + 1] - T[i]) * u;
}

// posicion/rotacion suave en el indice fraccional f (Hermite en posicion, lineal en angulos continuos)
function sampleSmooth(f) {
  const k = trk;
  if (!k) return null;
  if (f === smoothKey) return smoothOut;           // draw() y drawMarker() piden el mismo f en un frame
  smoothKey = f;
  const o = smoothOut, n = k.n;
  if (n < 2) { o.x = k.X[0]; o.y = k.Y[0]; o.z = k.Z[0]; o.rx = k.RX[0]; o.ry = k.RY[0]; o.rz = k.RZ[0]; return o; }
  let i = Math.floor(f);
  i = i < 0 ? 0 : i > n - 2 ? n - 2 : i;
  let u = f - i; u = u < 0 ? 0 : u > 1 ? 1 : u;
  const h = k.T[i + 1] - k.T[i];
  const u2 = u * u, u3 = u2 * u;
  const h00 = 2 * u3 - 3 * u2 + 1, h10 = (u3 - 2 * u2 + u) * h, h01 = -2 * u3 + 3 * u2, h11 = (u3 - u2) * h;
  o.x = h00 * k.X[i] + h10 * k.MX[i] + h01 * k.X[i + 1] + h11 * k.MX[i + 1];
  o.y = h00 * k.Y[i] + h10 * k.MY[i] + h01 * k.Y[i + 1] + h11 * k.MY[i + 1];
  o.z = h00 * k.Z[i] + h10 * k.MZ[i] + h01 * k.Z[i + 1] + h11 * k.MZ[i + 1];
  o.rx = k.RX[i] + (k.RX[i + 1] - k.RX[i]) * u;
  o.ry = k.RY[i] + (k.RY[i + 1] - k.RY[i]) * u;
  o.rz = k.RZ[i] + (k.RZ[i + 1] - k.RZ[i]) * u;
  return o;
}

// ---------- camara ----------
function project(p) {
  const dx = p[0] - cam.target[0], dy = p[1] - cam.target[1], dz = p[2] - cam.target[2];
  const cy = Math.cos(cam.yaw), sy = Math.sin(cam.yaw);
  const x1 = dx*cy - dy*sy;
  const y1 = dx*sy + dy*cy;
  const cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
  const z2 = y1*sp + dz*cp;
  return [W/2 + x1*cam.zoom, H/2 - z2*cam.zoom];
}

function basis() {
  const cy = Math.cos(cam.yaw), sy = Math.sin(cam.yaw);
  const cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
  return {
    u: [cy, -sy, 0], 
    v: [sy*sp, cy*sp, cp], 
  };
}

function bounds() {
  const pts = [];
  if (showTel) {
      for (const s of samples) pts.push([s.x, s.y, s.z]);
      for (const o of telObjs) for (const c of o.corners) pts.push(c);
  }
  if (showMap && !pts.length) {
      for (const o of mapObjs) for (const c of o.corners) pts.push(c);
  }
  if (!pts.length) return null;
  const b = { min:[1e9,1e9,1e9], max:[-1e9,-1e9,-1e9] };
  for (const p of pts) for (let i=0;i<3;i++) {
    if (p[i] < b.min[i]) b.min[i] = p[i];
    if (p[i] > b.max[i]) b.max[i] = p[i];
  }
  b.center = [(b.min[0]+b.max[0])/2, (b.min[1]+b.max[1])/2, (b.min[2]+b.max[2])/2];
  b.span = [Math.max(1,b.max[0]-b.min[0]), Math.max(1,b.max[1]-b.min[1]), Math.max(1,b.max[2]-b.min[2])];
  return b;
}

function fitCam() {
  const b = bounds();
  if (!b) return;
  cam.target = b.center.slice();
  cam.zoom = Math.min(W / Math.max(b.span[0], 2), H / Math.max(b.span[1], 2)) * 0.85;
  cam.zoom = Math.max(0.05, Math.min(cam.zoom, 12));
  needStatic = true;
}

function frameOn(p) {
  cam.target = [p.x, p.y, p.z];
  needStatic = true;
}

// ---------- dibujo estatico: un buffer con margen M; el pan se resuelve desplazandolo ----------
// Antes: al agotar el margen se re-dibujaba TODO de golpe (pico de frame cada ~1 s a alta velocidad).
// Ahora: la proyeccion es ortografica, asi que un pan es una traslacion 2D pura en pantalla. Se copia el
// buffer desplazado (px enteros) y solo se pintan las franjas recien expuestas.
const RP = { tx: 0, ty: 0, tz: 0, cy: 1, sy: 0, cp: 1, sp: 0, z: 1 };
function setRP(tg, zoom) {
  RP.tx = tg[0]; RP.ty = tg[1]; RP.tz = tg[2];
  RP.cy = Math.cos(cam.yaw); RP.sy = Math.sin(cam.yaw);
  RP.cp = Math.cos(cam.pitch); RP.sp = Math.sin(cam.pitch);
  RP.z = zoom;
}
function rpx(x, y) { return W / 2 + ((x - RP.tx) * RP.cy - (y - RP.ty) * RP.sy) * RP.z; }
function rpy(x, y, z) { return H / 2 - (((x - RP.tx) * RP.sy + (y - RP.ty) * RP.cy) * RP.sp + (z - RP.tz) * RP.cp) * RP.z; }

const EDGE_IDX = new Uint8Array(EDGES.flat());
const _bp = new Float64Array(16);
function addBox(c, o) {
  const f = o.f;
  for (let k = 0; k < 8; k++) {
    const x = f[k * 3], y = f[k * 3 + 1], z = f[k * 3 + 2];
    _bp[k * 2] = rpx(x, y); _bp[k * 2 + 1] = rpy(x, y, z);
  }
  for (let e = 0; e < 24; e += 2) {
    const a = EDGE_IDX[e] * 2, b = EDGE_IDX[e + 1] * 2;
    c.moveTo(_bp[a], _bp[a + 1]); c.lineTo(_bp[b], _bp[b + 1]);
  }
}

function autoLod() {
  const n = (showMap ? mapObjs.length : 0) + (showTel ? telObjs.length : 0);
  const base = quality === "low" ? 4 : quality === "high" ? 1 : (n > 2500 ? 4 : n > 1200 ? 2 : 1);
  return (dragging && !(drag && drag.pan)) ? Math.max(2, base) : base;
}

function drawGrid(c) {
  const s = 50, steps = 40;
  const cx = Math.round(RP.tx / s) * s, cy = Math.round(RP.ty / s) * s;
  c.globalAlpha = 0.12;
  c.strokeStyle = "#8a94a6";
  c.lineWidth = 1;
  c.beginPath();
  for (let i = -steps; i <= steps; i++) {
    const px = cx + i * s, py1 = cy - steps * s, py2 = cy + steps * s;
    c.moveTo(rpx(px, py1), rpy(px, py1, 0)); c.lineTo(rpx(px, py2), rpy(px, py2, 0));
    const py = cy + i * s, px1 = cx - steps * s, px2 = cx + steps * s;
    c.moveTo(rpx(px1, py), rpy(px1, py, 0)); c.lineTo(rpx(px2, py), rpy(px2, py, 0));
  }
  c.stroke();
  c.globalAlpha = 1;
}

// un solo trazo por color (antes: beginPath+stroke por pieza) + descarte por esfera sin proyectar las 8 esquinas
function drawSet(c, objs, groups, alpha, lod, R) {
  if (!objs.length) return;
  const z = RP.z;
  c.globalAlpha = alpha;
  c.lineWidth = 1;
  const hl = highlightZ ? [] : null;
  for (const [color, list] of groups) {
    c.strokeStyle = color;
    c.beginPath();
    for (let k = 0; k < list.length; k += lod) {
      const o = objs[list[k]];
      const sx = rpx(o.cx, o.cy), sy = rpy(o.cx, o.cy, o.cz), r = o.r * z;
      if (r < 0.35 || sx + r < R.x0 || sx - r > R.x1 || sy + r < R.y0 || sy - r > R.y1) continue;
      if (hl && o.zavg >= highlightZ[0] && o.zavg <= highlightZ[1]) { hl.push(o); continue; }
      addBox(c, o);
    }
    c.stroke();
  }
  if (hl && hl.length) {
    c.strokeStyle = "#ff00ff";
    c.lineWidth = 2;
    c.beginPath();
    for (const o of hl) addBox(c, o);
    c.stroke();
  }
  c.globalAlpha = 1;
}

function drawMarkers(c) {
  for (const m of mapMarkers) {
    const x = rpx(m.x, m.y), y = rpy(m.x, m.y, m.z);
    if (!isFinite(x) || !isFinite(y)) continue;
    const col = m.type === "checkpoint" ? "#4a86e8"
      : m.type === "corona" ? "#38bdf8"
      : "#ffd24a";
    const r = Math.max(4, Math.min(18, m.size * cam.zoom * 0.25));
    c.globalAlpha = 0.9;
    c.strokeStyle = col;
    c.lineWidth = 2;
    c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.stroke();
    c.globalAlpha = 0.25;
    c.fillStyle = col;
    c.fill();
    c.globalAlpha = 1;
  }
}

function drawPickups(c) {
  for (const pk of mapPickups) {
    const col = pk.type === "nitro" ? "#ff4d2e"
      : pk.type === "repair" ? "#3fb950"
      : pk.type === "vehiclechange" ? "#d29922" : "#4a86e8";
    const bx = rpx(pk.x, pk.y), by = rpy(pk.x, pk.y, pk.z), ty = rpy(pk.x, pk.y, pk.z + 1.3);
    c.globalAlpha = 0.7;
    c.strokeStyle = col;
    c.lineWidth = 5;
    c.beginPath();
    c.moveTo(bx, by);
    c.lineTo(bx, ty);
    c.stroke();
    c.fillStyle = col;
    c.beginPath();
    c.arc(bx, by, 4, 0, Math.PI * 2);
    c.fill();
    c.globalAlpha = 1;
  }
}

// recorrido: cubetas de velocidad, aire/invertido y nitro; todo precalculado en prepTrack()
function drawTrack(c, R) {
  const k = trk;
  if (!k || k.n < 2) return;
  const { n, X, Y, Z, BK, FL, NIT } = k;
  const paths = [], used = new Uint8Array(BUCKETS);
  for (let b = 0; b < BUCKETS; b++) paths.push(new Path2D());
  const air = new Path2D(), inv = new Path2D(), nit = new Path2D();
  let hasAir = false, hasInv = false, hasNit = false, pen = false;
  let x0 = rpx(X[0], Y[0]), y0 = rpy(X[0], Y[0], Z[0]);
  for (let i = 1; i < n; i++) {
    const x1 = rpx(X[i], Y[i]), y1 = rpy(X[i], Y[i], Z[i]);
    const off = (x0 < R.x0 && x1 < R.x0) || (x0 > R.x1 && x1 > R.x1) || (y0 < R.y0 && y1 < R.y0) || (y0 > R.y1 && y1 > R.y1);
    if (!off) {
      const b = BK[i], p = paths[b];
      p.moveTo(x0, y0); p.lineTo(x1, y1); used[b] = 1;
      const fl = FL[i];
      if (fl & 2) { inv.moveTo(x0, y0); inv.lineTo(x1, y1); hasInv = true; }
      else if (fl & 1) { air.moveTo(x0, y0); air.lineTo(x1, y1); hasAir = true; }
    }
    // nitro sin descarte: asi el patron de guiones es identico en cada franja
    if (NIT[i]) {
      if (!pen) { nit.moveTo(x0, y0); pen = true; }
      nit.lineTo(x1, y1); hasNit = true;
    } else pen = false;
    x0 = x1; y0 = y1;
  }
  c.lineWidth = 2.2;
  for (let b = 0; b < BUCKETS; b++) if (used[b]) { c.strokeStyle = BCOL[b]; c.stroke(paths[b]); }
  c.lineWidth = 3;
  if (hasAir) { c.strokeStyle = "#ffe066"; c.stroke(air); }
  if (hasInv) { c.strokeStyle = "#ff44dd"; c.stroke(inv); }
  if (hasNit) {
    c.lineWidth = 2.5;
    c.setLineDash([7, 5]);
    c.strokeStyle = "#ff4d2e";
    c.stroke(nit);
    c.setLineDash([]);
  }
}

function drawVehChanges(c, R) {
  c.font = "11px Segoe UI, system-ui, sans-serif";
  c.textBaseline = "middle";
  for (const i of trk.VCH) {
    const x = rpx(trk.X[i], trk.Y[i]), y = rpy(trk.X[i], trk.Y[i], trk.Z[i]);
    if (x < R.x0 - 140 || x > R.x1 + 12 || y < R.y0 - 12 || y > R.y1 + 12) continue;
    c.beginPath();
    c.moveTo(x, y - 7); c.lineTo(x + 7, y); c.lineTo(x, y + 7); c.lineTo(x - 7, y); c.closePath();
    c.fillStyle = "#ffd33d"; c.fill();
    c.lineWidth = 1.5; c.strokeStyle = "#0b0e13"; c.stroke();
    const txt = vehName(samples[i - 1].veh) + " → " + vehName(samples[i].veh);
    c.lineWidth = 3; c.strokeStyle = "rgba(11,14,19,.85)"; c.strokeText(txt, x + 11, y);
    c.fillStyle = "#ffe9a0"; c.fillText(txt, x + 11, y);
  }
}

// pinta la region [x0,x1)x[y0,y1) del buffer (coordenadas de buffer) con la proyeccion RP actual
function paintRegion(x0, y0, x1, y1) {
  const c = bufCtx;
  c.save();
  c.beginPath();
  c.rect(x0, y0, x1 - x0, y1 - y0);
  c.clip();
  c.translate(M, M);
  const R = { x0: x0 - M, y0: y0 - M, x1: x1 - M, y1: y1 - M };   // la misma region en coordenadas de pantalla
  const lod = autoLod();
  if (showGrid) drawGrid(c);
  if (showMap) drawSet(c, mapObjs, mapGroups, 0.4, lod, R);
  if (showMap && showPickups) drawPickups(c);
  if (showMap && showMarkers) drawMarkers(c);
  if (showTel && !(showMap && mapObjs.length)) drawSet(c, telObjs, telGroups, 0.6, lod, R);
  if (showTel && samples.length > 1) drawTrack(c, R);
  if (showTel && trk && trk.VCH.length) drawVehChanges(c, R);
  c.restore();
}

function renderFull() {
  setRP(cam.target, cam.zoom);
  bufCtx.clearRect(0, 0, bufCanvas.width, bufCanvas.height);
  paintRegion(0, 0, bufCanvas.width, bufCanvas.height);
  staticTarget = cam.target.slice();
  staticZoom = cam.zoom;
  needStatic = false; mapDirty = false; telDirty = false;
}

function scrollStatic(po) {
  const ox = Math.round(-po[0]), oy = Math.round(-po[1]);   // px enteros: sin remuestreo ni borrosidad
  if (!ox && !oy) return;
  const Wb = bufCanvas.width, Hb = bufCanvas.height;
  bufCtx.globalCompositeOperation = "copy";                 // REEMPLAZA (source-over dejaria una copia fantasma sin desplazar)
  bufCtx.drawImage(bufCanvas, -ox, -oy);                    // desplaza el contenido ya pintado
  bufCtx.globalCompositeOperation = "source-over";
  // el ancla se mueve exactamente lo que se desplazo el contenido (u,v son ortonormales)
  const b = basis(), z = staticZoom;
  for (let q = 0; q < 3; q++) staticTarget[q] += b.u[q] * (ox / z) + b.v[q] * (-oy / z);
  setRP(staticTarget, z);
  const rects = [];
  if (ox > 0) rects.push([Wb - ox, 0, Wb, Hb]); else if (ox < 0) rects.push([0, 0, -ox, Hb]);
  const hx0 = ox < 0 ? -ox : 0, hx1 = ox > 0 ? Wb - ox : Wb;
  if (oy > 0) rects.push([hx0, Hb - oy, hx1, Hb]); else if (oy < 0) rects.push([hx0, 0, hx1, -oy]);
  for (const r of rects) {
    bufCtx.clearRect(r[0], r[1], r[2] - r[0], r[3] - r[1]);
    paintRegion(r[0], r[1], r[2], r[3]);
  }
}

function renderStatic() {
  if (needStatic || mapDirty || telDirty || !staticTarget || cam.zoom !== staticZoom) { renderFull(); return; }
  const po = panOffset();
  const ax = Math.abs(po[0]), ay = Math.abs(po[1]);
  if (ax < STEP && ay < STEP) return;
  if (ax > M * 0.8 || ay > M * 0.8) renderFull(); else scrollStatic(po);   // salto grande: re-render completo
}

// ---------- modelos wireframe de los coches mas usados en race DM ----------
// Cada coche es una serie de secciones transversales (y, semiancho, z_fondo, z_cintura, z_techo, semiancho_techo)
// unidas longitudinalmente + 4 ruedas. Ejes locales: +Y = frente, +Z = arriba, origen = posicion del vehiculo.
const CAR_MODELS = {};
function buildCar(spec) {
  const v = [], body = [], nose = [], tail = [], roof = [], wheels = [];
  const S = spec.st, ns = S.length;
  for (const [y, w, zb, zbelt, zroof, wr] of S) v.push(-w, y, zb,  w, y, zb,  w, y, zbelt,  wr, y, zroof,  -wr, y, zroof,  -w, y, zbelt);
  const ring = [[0,1],[1,2],[2,3],[3,4],[4,5],[5,0]];
  for (let s = 0; s < ns; s++) {
    const b = s * 6, tgt = s === ns - 1 ? nose : s === 0 ? tail : body;
    for (const [a, c] of ring) tgt.push([b + a, b + c]);
    if (s < ns - 1) {
      for (let k = 0; k < 6; k++) body.push([b + k, b + 6 + k]);
      roof.push([b + 3, b + 4, b + 10, b + 9]);
    }
  }
  const wh = spec.wheel, N = 10;
  const wheelCenters = [];
  for (const sx of [-1, 1]) for (const wy of wh.y) wheelCenters.push([sx * wh.x, wy, wh.z]);
  for (const sx of [-1, 1]) for (const wy of wh.y) {
    const base = v.length / 3;
    for (let a = 0; a < N; a++) { const ang = a / N * Math.PI * 2; v.push(sx * wh.x, wy + Math.cos(ang) * wh.r, wh.z + Math.sin(ang) * wh.r); }
    for (let a = 0; a < N; a++) wheels.push([base + a, base + (a + 1) % N]);
  }
  const faces = [], capNose = [], capTail = [];
  for (let s = 0; s < ns - 1; s++) {
    for (const [a, c] of ring) {
      faces.push({ poly: [s * 6 + a, s * 6 + c, (s + 1) * 6 + c, (s + 1) * 6 + a], kind: "body" });
    }
  }
  for (const q of roof) faces.push({ poly: q, kind: "roof" });
  for (let k = 0; k < 6; k++) { capNose.push((ns - 1) * 6 + k); capTail.push(k); }
  faces.push({ poly: capNose, kind: "nose" }, { poly: capTail, kind: "tail" });
  return { v: Float64Array.from(v), body, nose, tail, roof, wheels, faces, capNose, capTail, wheelCenters, wheelR: wh.r };
}
CAR_MODELS[411] = buildCar({   // Infernus: bajo, ancho, motor central, morro en cuna
  st: [[-2.2,.85,-.40,.00,.00,.85],[-1.7,.96,-.42,.10,.12,.96],[-.9,.98,-.42,.18,.45,.80],[0,.98,-.42,.20,.58,.78],
       [.8,.98,-.42,.18,.55,.78],[1.3,.96,-.42,.12,.20,.90],[2.0,.90,-.42,.00,.02,.86],[2.2,.80,-.40,-.08,-.06,.78]],
  wheel: { y: [1.35, -1.35], x: .90, r: .33, z: -.24 } });
CAR_MODELS[495] = buildCar({   // Sandking: alto, 4x4, caja de pickup abierta, ruedas grandes
  st: [[-2.45,1.00,-.55,.30,.30,1.00],[-1.0,1.08,-.55,.32,.32,1.08],[-.95,1.08,-.55,.40,.90,.95],[.3,1.08,-.55,.40,.92,.95],
       [.9,1.08,-.55,.40,.48,1.00],[2.0,1.05,-.55,.38,.40,1.00],[2.45,.98,-.55,.20,.22,.95]],
  wheel: { y: [1.45, -1.45], x: 1.0, r: .55, z: -.45 } });
CAR_MODELS[480] = buildCar({   // Comet: coupe deportivo corto y bajo
  st: [[-2.05,.80,-.42,-.02,.00,.80],[-1.5,.90,-.43,.10,.20,.86],[-.8,.91,-.43,.15,.52,.78],[.1,.91,-.43,.16,.58,.76],
       [.7,.91,-.43,.14,.50,.80],[1.2,.90,-.43,.08,.10,.88],[1.9,.84,-.43,-.02,.00,.82],[2.05,.76,-.42,-.07,-.05,.74]],
  wheel: { y: [1.25, -1.25], x: .85, r: .32, z: -.25 } });

function convexHull(pts) {
  const P = pts.map((q) => [q[0], q[1]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (P.length < 3) return P;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const p of P) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop(); lower.push(p); }
  const upper = [];
  for (let i = P.length - 1; i >= 0; i--) { const p = P[i]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop(); upper.push(p); }
  lower.pop(); upper.pop();
  return lower.concat(upper);
}

function drawCarIcon(p, ang, inv) {
  ctx.save();
  ctx.translate(p[0], p[1]);
  ctx.rotate(ang);
  ctx.scale(1, inv ? -1 : 1);
  const L = 26, W = 13;
  const path = () => {
    ctx.beginPath();
    ctx.moveTo(L * 0.5, 0);
    ctx.lineTo(L * 0.2, -W * 0.5);
    ctx.lineTo(-L * 0.35, -W * 0.5);
    ctx.lineTo(-L * 0.5, -W * 0.25);
    ctx.lineTo(-L * 0.5, W * 0.25);
    ctx.lineTo(-L * 0.35, W * 0.5);
    ctx.lineTo(L * 0.2, W * 0.5);
    ctx.closePath();
  };
  ctx.lineWidth = 6;
  ctx.strokeStyle = "rgba(3,5,8,.92)";
  path(); ctx.stroke();
  ctx.fillStyle = inv ? "#ff5555" : "#eaf0f8";
  path(); ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = inv ? "#ff5555" : "#ffffff";
  path(); ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(L * 0.5, 0);
  ctx.lineTo(L * 0.2, -W * 0.35);
  ctx.lineTo(L * 0.2, W * 0.35);
  ctx.closePath();
  ctx.fillStyle = "#ffc84a";
  ctx.fill();
  ctx.restore();
}

function drawCarModel(m, sm, inv) {
  const R3 = rotMatrix(num(sm.rx), num(sm.ry), num(sm.rz));
  const n = m.v.length / 3;
  const pp = new Array(n), wp = new Array(n);
  for (let k = 0; k < n; k++) {
    const lx = m.v[k * 3], ly = m.v[k * 3 + 1], lz = m.v[k * 3 + 2];
    const x = sm.x + R3[0][0] * lx + R3[0][1] * ly + R3[0][2] * lz;
    const y = sm.y + R3[1][0] * lx + R3[1][1] * ly + R3[1][2] * lz;
    const z = sm.z + R3[2][0] * lx + R3[2][1] * ly + R3[2][2] * lz;
    wp[k] = [x, y, z];
    pp[k] = project([x, y, z]);
  }
  let minx = 1e9, maxx = -1e9, miny = 1e9, maxy = -1e9;
  for (const q of pp) {
    if (!q) continue;
    if (q[0] < minx) minx = q[0]; if (q[0] > maxx) maxx = q[0];
    if (q[1] < miny) miny = q[1]; if (q[1] > maxy) maxy = q[1];
  }
  const size = Math.max(maxx - minx, maxy - miny);
  const c0 = project([sm.x, sm.y, sm.z]);
  const ah = project([sm.x + R3[0][1] * 6, sm.y + R3[1][1] * 6, sm.z + R3[2][1] * 6]);
  const ang = ah && c0 ? Math.atan2(ah[1] - c0[1], ah[0] - c0[0]) : 0;

  if (size < 30) { drawCarIcon(c0, ang, inv); return; }

  const strokeE = (edges, color, lw) => {
    ctx.strokeStyle = color; ctx.lineWidth = lw; ctx.beginPath();
    for (const [a, b] of edges) { ctx.moveTo(pp[a][0], pp[a][1]); ctx.lineTo(pp[b][0], pp[b][1]); }
    ctx.stroke();
  };
  const polyPts = (pts, fill) => {
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let k = 1; k < pts.length; k++) ctx.lineTo(pts[k][0], pts[k][1]);
    ctx.closePath();
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
  };
  const polyIdx = (idx, fill, stroke, lw) => {
    ctx.beginPath();
    ctx.moveTo(pp[idx[0]][0], pp[idx[0]][1]);
    for (let k = 1; k < idx.length; k++) ctx.lineTo(pp[idx[k]][0], pp[idx[k]][1]);
    ctx.closePath();
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lw || 1.5; ctx.stroke(); }
  };
  const allEdges = m.body.concat(m.wheels, m.nose, m.tail);

  if (carStyle === "wire") {
    strokeE(allEdges, "rgba(3,5,8,.9)", 4.5);
    strokeE(allEdges, inv ? "#ff5555" : "#ffffff", 1.4);
    strokeE(m.wheels, "rgba(170,180,195,.85)", 1.2);
    strokeE(m.tail, "rgba(230,70,70,.95)", 1.8);
    strokeE(m.nose, inv ? "#ff9a9a" : "rgba(255,200,70,.98)", 1.8);
    if (size > 80) {
      const tip = project([sm.x + R3[0][2] * 3.5, sm.y + R3[1][2] * 3.5, sm.z + R3[2][2] * 3.5]);
      if (tip) { ctx.strokeStyle = inv ? "#ff5555" : "#3fb950"; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(c0[0], c0[1]); ctx.lineTo(tip[0], tip[1]); ctx.stroke(); }
    }
    return;
  }

  if (carStyle === "silhouette" || size < 80) {
    const hull = convexHull(pp.filter(Boolean));
    polyPts(hull, "rgba(8,12,17,.95)");
    polyIdx(m.capNose, inv ? "rgba(255,120,120,.95)" : "rgba(255,200,70,.95)");
    polyPts(hull, null);
    ctx.strokeStyle = "rgba(3,5,8,.9)"; ctx.lineWidth = 5; ctx.stroke();
    ctx.strokeStyle = inv ? "#ff5555" : "#ffffff"; ctx.lineWidth = 2; ctx.stroke();
    if (carStyle !== "silhouette") {
      const wc = m.wheelCenters || [];
      for (const c of wc) {
        const q = project([
          sm.x + R3[0][0] * c[0] + R3[0][1] * c[1] + R3[0][2] * c[2],
          sm.y + R3[1][0] * c[0] + R3[1][1] * c[1] + R3[1][2] * c[2],
          sm.z + R3[2][0] * c[0] + R3[2][1] * c[1] + R3[2][2] * c[2],
        ]);
        if (!q) continue;
        const rr = Math.max(2.5, (m.wheelR || 0.33) * cam.zoom * 0.55);
        ctx.beginPath(); ctx.arc(q[0], q[1], rr, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(8,12,16,.95)"; ctx.fill();
        ctx.lineWidth = 1.5; ctx.strokeStyle = inv ? "#ff5555" : "#cfd6e2"; ctx.stroke();
      }
    }
    return;
  }

  // solido: casco como base + caras opacas ordenadas atras->adelante
  const hull = convexHull(pp.filter(Boolean));
  polyPts(hull, "rgba(10,15,20,.96)");
  const b2 = basis();
  const wx = b2.u[1] * b2.v[2] - b2.u[2] * b2.v[1];
  const wy = b2.u[2] * b2.v[0] - b2.u[0] * b2.v[2];
  const wz = b2.u[0] * b2.v[1] - b2.u[1] * b2.v[0];
  const order = m.faces.map((f) => {
    let cx = 0, cy = 0, cz = 0;
    for (const k of f.poly) { cx += wp[k][0]; cy += wp[k][1]; cz += wp[k][2]; }
    const iv = 1 / f.poly.length;
    const d = (cx * iv - cam.target[0]) * wx + (cy * iv - cam.target[1]) * wy + (cz * iv - cam.target[2]) * wz;
    return { f, d };
  }).sort((A, B) => A.d - B.d);   // w·d menor = mas lejos (w = u x v apunta al espectador)
  for (const o of order) {
    const f = o.f;
    const col = f.kind === "nose" ? (inv ? "rgba(255,120,120,.95)" : "rgba(255,200,70,.95)")
      : f.kind === "tail" ? "rgba(170,30,30,.9)"
      : f.kind === "roof" ? "rgba(70,120,175,.4)"
      : "rgba(10,15,20,.96)";
    polyIdx(f.poly, col);
  }
  strokeE(m.wheels, "rgba(3,5,8,.9)", 4);
  strokeE(m.wheels, "rgba(170,180,195,.9)", 1.2);
  strokeE(m.body, "rgba(3,5,8,.9)", 4.5);
  strokeE(m.body, inv ? "#ff5555" : "#ffffff", 1.4);
  strokeE(m.tail, "rgba(230,70,70,.98)", 1.8);
  strokeE(m.nose, inv ? "#ff9a9a" : "rgba(255,200,70,.98)", 1.8);
  if (size > 80) {
    const tip = project([sm.x + R3[0][2] * 3.5, sm.y + R3[1][2] * 3.5, sm.z + R3[2][2] * 3.5]);
    if (tip) { ctx.strokeStyle = inv ? "#ff5555" : "#3fb950"; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(c0[0], c0[1]); ctx.lineTo(tip[0], tip[1]); ctx.stroke(); }
  }
}

// pasado/futuro del recorrido: brillo atras, atenuado adelante (ventana local por rendimiento)
function drawProgress() {
  if (!showTel || !trk || trk.n < 3) return;
  const i = curIndex();
  if (i < 0) return;
  const WIN = 320;
  const a = Math.max(0, i - WIN), b = Math.min(trk.n - 1, i + WIN);
  let p = project([trk.X[i], trk.Y[i], trk.Z[i]]);
  if (!p) return;
  ctx.lineWidth = 5;
  ctx.strokeStyle = "rgba(4,7,11,.55)";
  ctx.beginPath();
  let q = p;
  for (let k = i + 1; k <= b; k++) {
    const r = project([trk.X[k], trk.Y[k], trk.Z[k]]);
    if (!r) { q = r; continue; }
    ctx.moveTo(q[0], q[1]); ctx.lineTo(r[0], r[1]); q = r;
  }
  ctx.stroke();
  ctx.lineWidth = 3;
  ctx.strokeStyle = "rgba(255,255,255,.5)";
  ctx.beginPath();
  q = p;
  for (let k = i - 1; k >= a; k--) {
    const r = project([trk.X[k], trk.Y[k], trk.Z[k]]);
    if (!r) { q = r; continue; }
    ctx.moveTo(q[0], q[1]); ctx.lineTo(r[0], r[1]); q = r;
  }
  ctx.stroke();
}

function drawMarker() {
  if (!showTel) return;
  const i = curIndex();
  if (i < 0) return;
  const sm = sampleSmooth(idx) || samples[i];
  const p = project([sm.x, sm.y, sm.z]);
  if (!p) return;

  // estela de las ultimas ~20 muestras, terminando EXACTO en el marcador (sin saltos al cambiar de muestra)
  ctx.lineWidth = 2;
  const k0 = Math.max(0, i - 20);
  let pa = project([samples[k0].x, samples[k0].y, samples[k0].z]);
  const nseg = i - k0 + 1;
  for (let k = k0 + 1; k <= i + 1; k++) {
    const pb = k <= i ? project([samples[k].x, samples[k].y, samples[k].z]) : p;
    const f = (k - k0 - 1) / nseg;
    ctx.strokeStyle = `rgba(255,255,255,${0.04 + 0.3 * f})`;
    ctx.beginPath();
    ctx.moveTo(pa[0], pa[1]);
    ctx.lineTo(pb[0], pb[1]);
    ctx.stroke();
    pa = pb;
  }

  // linea al piso (altura)
  const g = project([sm.x, sm.y, sm.z - 6]);
  if (g) {
    ctx.strokeStyle = "rgba(255,255,255,.22)";
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(p[0], p[1]);
    ctx.lineTo(g[0], g[1]);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // rumbo en pantalla
  const R = rotMatrix(num(sm.rx), num(sm.ry), num(sm.rz));
  const fx = R[0][1], fy = R[1][1], fz = R[2][1];   // local +Y = frente del coche
  const ah = project([sm.x + fx * 6, sm.y + fy * 6, sm.z + fz * 6]);
  const ang = ah ? Math.atan2(ah[1] - p[1], ah[0] - p[0]) : 0;
  const upz = Math.cos(num(sm.rx) * Math.PI / 180) * Math.cos(num(sm.ry) * Math.PI / 180);
  const inv = upz < -0.3;

  // anillo base
  ctx.strokeStyle = inv ? "#ff5555" : "#ffffff";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(p[0], p[1], 10, 0, Math.PI * 2);
  ctx.stroke();

  if (markerMode === "box") {
    const cm = CAR_MODELS[samples[i].veh];                 // modelo propio si existe; si no, la caja generica
    if (cm) { drawCarModel(cm, sm, inv); return; }
    // caja 3D del coche (largo 4.5, ancho 1.9, alto 1.15)
    const L = 4.5, Wd = 1.9, Ht = 1.15;
    const local = [];
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
      const taper = sy > 0 ? 0.62 : 1.0;   // morro mas angosto
      local.push([sx * Wd / 2 * taper, sy * L / 2, sz * Ht / 2]);
    }
    const R3 = rotMatrix(num(sm.rx), num(sm.ry), num(sm.rz));
    const wp = local.map((c) => [
      sm.x + R3[0][0] * c[0] + R3[0][1] * c[1] + R3[0][2] * c[2],
      sm.y + R3[1][0] * c[0] + R3[1][1] * c[1] + R3[1][2] * c[2],
      sm.z + R3[2][0] * c[0] + R3[2][1] * c[1] + R3[2][2] * c[2],
    ]);
    const pp = wp.map((q) => project(q));
    if (pp.every(Boolean)) {
      const E = [[0,1],[0,2],[1,3],[2,3],[4,5],[4,6],[5,7],[6,7],[0,4],[1,5],[2,6],[3,7]];
      ctx.strokeStyle = "rgba(3,5,8,.9)";
      ctx.lineWidth = 4.5;
      ctx.beginPath();
      for (const [a, b] of E) { ctx.moveTo(pp[a][0], pp[a][1]); ctx.lineTo(pp[b][0], pp[b][1]); }
      ctx.stroke();
      ctx.strokeStyle = inv ? "#ff5555" : "#ffffff";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (const [a, b] of E) { ctx.moveTo(pp[a][0], pp[a][1]); ctx.lineTo(pp[b][0], pp[b][1]); }
      ctx.stroke();
      // techo (z+) semitransparente para ver el roll
      ctx.beginPath();
      const top = [1, 3, 7, 5];
      ctx.moveTo(pp[top[0]][0], pp[top[0]][1]);
      for (let k = 1; k < top.length; k++) ctx.lineTo(pp[top[k]][0], pp[top[k]][1]);
      ctx.closePath();
      ctx.fillStyle = inv ? "rgba(255,85,85,.45)" : "rgba(120,190,255,.35)";
      ctx.fill();
      // frente (morro) y cola: para saber hacia donde mira
      const face = (idx2, color) => {
        ctx.beginPath();
        ctx.moveTo(pp[idx2[0]][0], pp[idx2[0]][1]);
        for (let k = 1; k < idx2.length; k++) ctx.lineTo(pp[idx2[k]][0], pp[idx2[k]][1]);
        ctx.closePath();
        ctx.fillStyle = color;
        ctx.fill();
      };
      face([2, 3, 7, 6], inv ? "rgba(255,85,85,.7)" : "rgba(255,200,70,.8)");  // frente
      face([0, 1, 5, 4], "rgba(220,40,40,.55)");                               // cola
      // vector "arriba" para leer la orientacion
      const up = [R3[0][2], R3[1][2], R3[2][2]];
      const tip = project([sm.x + up[0] * 3.5, sm.y + up[1] * 3.5, sm.z + up[2] * 3.5]);
      if (tip) {
        ctx.strokeStyle = inv ? "#ff5555" : "#3fb950";
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(p[0], p[1]); ctx.lineTo(tip[0], tip[1]); ctx.stroke();
      }
    }
    return;
  }

  ctx.save();
  ctx.translate(p[0], p[1]);
  ctx.rotate(ang);
  ctx.scale(1, inv ? -1 : 1);
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = "#0b0e13";
  if (markerMode === "car") {
    ctx.fillStyle = inv ? "#ff5555" : "#f2f5f9";
    ctx.fillRect(-8, -4, 16, 8);
    ctx.strokeRect(-8, -4, 16, 8);
    ctx.fillStyle = "#7fb2ff";
    ctx.fillRect(-1, -3, 4, 6);
  } else {
    ctx.beginPath();
    ctx.moveTo(10, 0);
    ctx.lineTo(-6, -6);
    ctx.lineTo(-3, 0);
    ctx.lineTo(-6, 6);
    ctx.closePath();
    ctx.fillStyle = inv ? "#ff5555" : "#ffffff";
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

function drawMini() {
  mctx.clearRect(0, 0, mini.width, mini.height);
  if (!showTel || !samples.length) return;
  if (miniNeedStatic) {
    miniStatic.width = mini.width;
    miniStatic.height = mini.height;
    const g = miniStatic.getContext("2d");
    g.clearRect(0, 0, miniStatic.width, miniStatic.height);
    let minx = 1e9, maxx = -1e9, miny = 1e9, maxy = -1e9;
    for (const s of samples) {
      if (s.x < minx) minx = s.x; if (s.x > maxx) maxx = s.x;
      if (s.y < miny) miny = s.y; if (s.y > maxy) maxy = s.y;
    }
    const sc = Math.min(mini.width / Math.max(1, maxx - minx), mini.height / Math.max(1, maxy - miny)) * 0.85;
    const ox = (mini.width - (maxx - minx) * sc) / 2;
    const oy = (mini.height - (maxy - miny) * sc) / 2;
    mini.P = (x, y) => [ox + (x - minx) * sc, mini.height - (oy + (y - miny) * sc)];
    const P = mini.P;
    g.lineWidth = 1.5;
    g.strokeStyle = "#4a86e8";
    g.beginPath();
    for (let i = 0; i < samples.length; i++) {
      const p = P(samples[i].x, samples[i].y);
      if (i === 0) g.moveTo(p[0], p[1]); else g.lineTo(p[0], p[1]);
    }
    g.stroke();
    miniNeedStatic = false;
  }
  if (!mini.P) return;
  mctx.drawImage(miniStatic, 0, 0);
  const i = curIndex();
  if (i >= 0) {
    const s1 = samples[i];
    const s2 = samples[Math.min(i + 1, samples.length - 1)];
    const f = idx - i;
    const p = mini.P(s1.x + (s2.x - s1.x) * f, s1.y + (s2.y - s1.y) * f);
    mctx.fillStyle = "#fff";
    mctx.beginPath(); mctx.arc(p[0], p[1], 4, 0, Math.PI * 2); mctx.fill();
  }
}

// ---------- linea de tiempo coloreada: velocidad, aire, invertido, nitro y cambios de coche ----------
function buildTimeline() {
  tlStatic = null;
  if (!tctx || !trk || !tl.width) return;
  const w = tl.width, h = tl.height, k = trk;
  tlStatic = document.createElement("canvas");
  tlStatic.width = w; tlStatic.height = h;
  const c = tlStatic.getContext("2d");
  const t0 = k.T[0], span = Math.max(1, k.T[k.n - 1] - t0), laneH = 4, spdH = h - 3 * laneH - 3;
  for (let x = 0; x < w; x++) {
    let i0 = Math.floor(timeToIdx(t0 + span * x / w)), i1 = Math.ceil(timeToIdx(t0 + span * (x + 1) / w));
    i0 = Math.max(0, Math.min(k.n - 1, i0)); i1 = Math.max(i0, Math.min(k.n - 1, i1));
    let vmax = 0, air = 0, inv = 0, nit = 0;
    for (let i = i0; i <= i1; i++) {
      if (k.BK[i] > vmax) vmax = k.BK[i];
      air |= k.FL[i] & 1; inv |= (k.FL[i] >> 1) & 1; nit |= k.NIT[i];
    }
    const bh = Math.max(2, Math.round(spdH * (vmax + 1) / BUCKETS));
    c.fillStyle = BCOL[vmax]; c.fillRect(x, spdH - bh, 1, bh);
    if (air) { c.fillStyle = "#ffe066"; c.fillRect(x, spdH + 2, 1, laneH - 1); }
    if (inv) { c.fillStyle = "#ff44dd"; c.fillRect(x, spdH + 2 + laneH, 1, laneH - 1); }
    if (nit) { c.fillStyle = "#ff4d2e"; c.fillRect(x, spdH + 2 + 2 * laneH, 1, laneH - 1); }
  }
  for (const i of k.VCH) {                                   // cambio de coche: marca ambar a todo el alto
    const x = Math.round((k.T[i] - t0) / span * (w - 1));
    c.fillStyle = "#ffd33d"; c.fillRect(x - 1, 0, 2, h);
  }
}
function drawTimeline() {
  if (!tctx || !trk || !tl.width) return;
  if (!tlStatic) buildTimeline();
  if (!tlStatic) return;
  const w = tl.width, h = tl.height;
  const f = (idxToTime(idx) - trk.T[0]) / Math.max(1, trk.T[trk.n - 1] - trk.T[0]);
  const px = Math.round(Math.max(0, Math.min(1, f)) * (w - 1));
  if (px === tlPx) return;                                    // el cabezal no se movio: nada que redibujar
  tlPx = px;
  tctx.clearRect(0, 0, w, h);
  tctx.drawImage(tlStatic, 0, 0);
  tctx.fillStyle = "#fff"; tctx.fillRect(px - 1, 0, 2, h);
}
let tlDrag = false;
function tlSeek(e) {
  if (!trk) return;
  const r = tl.getBoundingClientRect();
  const f = Math.max(0, Math.min(1, (e.clientX - r.left) / Math.max(1, r.width)));
  idx = timeToIdx(trk.T[0] + f * (trk.T[trk.n - 1] - trk.T[0]));
  draw();
}
if (tl && tl.addEventListener) {
  tl.addEventListener("mousedown", (e) => { tlDrag = true; tlSeek(e); });
  window.addEventListener("mousemove", (e) => { if (tlDrag) tlSeek(e); });
  window.addEventListener("mouseup", () => { tlDrag = false; });
}

// ---------- frame: render inmediato (drawNow) y peticion coalescida (draw) ----------
let drawQueued = false, lastPerf = 0;
let frameAcc = 0, frameN = 0, framePeak = 0, framePeakShown = 0, drawAcc = 0, drawN = 0, drawMs = 0;
const statsEl = $("stats");
const perfEl = document.createElement("div");
perfEl.style.cssText = "font-size:11px;color:#6f7a8c;margin:-4px 0 8px";
if (statsEl.parentNode) statsEl.parentNode.insertBefore(perfEl, statsEl.nextSibling);

// varios eventos de mouse/teclado por frame (mouse de 1000 Hz) = UN solo render; en reproduccion lo hace el loop
function draw() {
  if (playing || drawQueued) return;
  drawQueued = true;
  requestAnimationFrame(() => { drawQueued = false; drawNow(); });
}

function noteFrame(ms) {
  frameAcc += ms; frameN++;
  if (ms > framePeak) framePeak = ms;
  if (frameAcc >= 500) {
    fps = 1000 / (frameAcc / frameN);
    framePeakShown = framePeak;
    frameAcc = 0; frameN = 0; framePeak = 0;
  }
}

function drawNow() {
  const t0 = performance.now();
  if (follow && trk && showTel) {
    // la camara se ancla al marcador ya suavizado: sin lerp dependiente del framerate ni zona muerta
    const s = sampleSmooth(idx);
    cam.target[0] = s.x; cam.target[1] = s.y; cam.target[2] = s.z;
  }
  renderStatic();
  blitStatic();
  drawProgress();
  drawMarker();
  drawMini();
  drawTimeline();
  updateStats();
  drawAcc += performance.now() - t0; drawN++;
  if (drawN >= 30) { drawMs = drawAcc / drawN; drawAcc = 0; drawN = 0; }
}

function setText(el, v) { if (el && el.__t !== v) { el.__t = v; el.textContent = v; } }
function setBar(el, pct, color) {
  if (!el) return;
  const w = pct.toFixed(0) + "%";
  if (el.__w !== w) { el.__w = w; el.style.width = w; }
  if (el.__c !== color) { el.__c = color; el.style.background = color; }
}

let lastStatsCi = -2, lastVeh = null;
// tacometro: aguja con velocidad, zonas y marcha (reemplaza la barra VEL)
function drawTacho(vel, gear, withNum) {
  const cv = $("tacho");
  if (!cv) return;
  const c = cv.getContext("2d");
  const W = cv.width, H = cv.height;
  c.clearRect(0, 0, W, H);
  const cx = W / 2, cy = H / 2 + 2, R = Math.min(W, H) / 2 - 7;
  const a0 = Math.PI * 0.75, a1 = Math.PI * 2.25, MAX = 300;
  const v = Math.max(0, Math.min(1, vel / MAX));
  c.lineWidth = 6;
  c.strokeStyle = "rgba(255,255,255,.10)";
  c.beginPath(); c.arc(cx, cy, R, a0, a1); c.stroke();
  const zone = (f0, f1, col) => {
    c.strokeStyle = col;
    c.beginPath(); c.arc(cx, cy, R, a0 + (a1 - a0) * f0, a0 + (a1 - a0) * f1); c.stroke();
  };
  zone(0, 180 / MAX, "#3fb950");
  zone(180 / MAX, 240 / MAX, "#d29922");
  zone(240 / MAX, 1, "#e5534b");
  const a = a0 + (a1 - a0) * v;
  c.strokeStyle = "#eaf0f8"; c.lineWidth = 2;
  c.beginPath(); c.moveTo(cx, cy); c.lineTo(cx + Math.cos(a) * (R - 3), cy + Math.sin(a) * (R - 3)); c.stroke();
  c.fillStyle = "#eaf0f8";
  c.beginPath(); c.arc(cx, cy, 3, 0, Math.PI * 2); c.fill();
  c.textAlign = "center"; c.textBaseline = "middle";
  if (withNum) {
    c.fillStyle = "#cfd6e2"; c.font = "bold 13px Segoe UI";
    c.fillText(String(Math.round(vel)), cx, cy + R * 0.5);
  }
  if (gear != null) {
    c.fillStyle = "#8a94a6"; c.font = "10px Segoe UI";
    c.fillText("G" + gear, cx, cy - R * 0.4);
  }
}
function applySpeedMode() {
  const sp = $("hudSpeedVal");
  if (sp && sp.parentElement) sp.parentElement.style.display = speedMode === "tachonum" ? "none" : "";
  const tc = $("tacho");
  if (tc) tc.style.display = speedMode === "num" ? "none" : "";
}
function updateVehHud(s) {
  const el = $("hudVeh");
  if (!el) return;
  const m = s.veh != null ? s.veh : null;
  setText(el, m == null ? "—" : vehName(m));
  if (m !== lastVeh) {
    const changed = lastVeh !== null && m !== null;
    lastVeh = m;
    if (changed && el.parentNode && el.parentNode.classList) {   // destello breve: el usuario ve que cambio el coche
      el.parentNode.classList.remove("flash");
      void el.parentNode.offsetWidth;
      el.parentNode.classList.add("flash");
    }
  }
}
function updateStats() {
  const nowMs = performance.now();
  const objCount = (showMap ? mapObjs.length : 0) + (showTel ? telObjs.length : 0);
  if (nowMs - lastPerf > 250) {
    lastPerf = nowMs;
    perfEl.textContent = `${fps.toFixed(0)} fps · pico ${framePeakShown.toFixed(0)} ms · dibujo ${drawMs.toFixed(1)} ms · ${objCount} piezas`;
  }
  const el = statsEl;
  if (!trk || !showTel) {
    const h = `<div style="color:#6f7a8c">${objCount} piezas visibles</div>`;
    if (el.__h !== h) { el.__h = h; el.innerHTML = h; }
    return;
  }
  const ci = curIndex();
  if (playing && ci === lastStatsCi) return;      // misma muestra que el frame anterior: el DOM ya esta al dia
  lastStatsCi = ci;
  const s = samples[ci];
  const nit = (s.nitc != null) ? s.nitc : (s.nit != null ? s.nit : 0);
  const roll = num(s.rx);
  const upz = Math.cos(num(s.rx) * Math.PI / 180) * Math.cos(num(s.ry) * Math.PI / 180);
  const upside = upz < -0.3 ? ' <b style="color:#ff5555">INVERTIDO</b>' : '';
  const html =
    `<div>t <b>${(s.t/1000).toFixed(2)} s</b> · muestra <b>${ci+1}/${samples.length}</b></div>` +
    `<div>vel <b>${num(s.s).toFixed(0)} km/h</b> · z <b>${num(s.z).toFixed(1)}</b></div>` +
    `<div>salud <b>${num(s.h).toFixed(0)}</b> · w <b>${num(s.w)}</b></div>` +
    `<div>nitro <b>${nit}</b> · veh <b>${s.veh != null ? vehName(s.veh) : "—"}</b> · aire <b>${s.air != null ? s.air : 0}</b> · roll <b>${roll.toFixed(0)}°</b>${upside}</div>` +
    `<div>pieza <b>${s.oc ? s.oc : "—"}</b></div>` +
    `<div style="color:#6f7a8c">aire ${(airSamples / playbackHz).toFixed(1)}s · inv ${(invSamples / playbackHz).toFixed(1)}s</div>`;
  if (el.__h !== html) { el.__h = html; el.innerHTML = html; }
  const hp = num(s.h);
  const nitLevel = (s.nitl != null) ? num(s.nitl) : -1;
  const nitB = (s.nitc != null) ? num(s.nitc) : 0;
  const pct = Math.max(0, Math.min(100, hp / 1000 * 100));
  const hpCol = pct < 30 ? "#e5534b" : pct < 60 ? "#d29922" : "#3fb950";
  setBar($("hpBar"), pct, hpCol);
  setText($("hpVal"), hp.toFixed(0));
  const npct = nitLevel >= 0 ? Math.max(0, Math.min(100, nitLevel * 100))
                             : Math.max(0, Math.min(100, nitB / 10 * 100));
  setBar($("nitBar"), npct, "#38bdf8");
  const nitTxt = nitLevel >= 0 ? (nitLevel * 100).toFixed(0) + "%" : String(nitB);
  setText($("nitVal"), nitTxt);
  setBar($("hudHp"), pct, hpCol);
  setText($("hudHpVal"), hp.toFixed(0));
  setBar($("hudNit"), npct, "#38bdf8");
  setText($("hudNitVal"), nitTxt + (num(s.nit) === 1 ? " ON" : ""));
  const vel = num(s.s);
  updateVehHud(s);
  setText($("hudSpeedVal"), vel.toFixed(0));
  drawTacho(vel, s.gear, speedMode === "tachonum");
  setText($("idxInfo"), `${ci+1}/${samples.length}`);
  const tm = $("time"), mx = Math.max(0, samples.length - 1);
  if (tm.max != mx) tm.max = mx;
  if (tm.value != ci) tm.value = ci;
}

// ---------- UI ----------
function resize() {
  W = view.clientWidth; H = view.clientHeight;
  view.width = W; view.height = H;
  bufCanvas.width = W + 2*M; bufCanvas.height = H + 2*M;
  mini.width = mini.clientWidth; mini.height = mini.clientHeight;
  if (tl && tl.clientWidth) { tl.width = tl.clientWidth; tl.height = tl.clientHeight || 38; }
  tlStatic = null; tlPx = -1;
  miniNeedStatic = true;
  needStatic = true;
  draw();
}

function panOffset() {
  if (!staticTarget || cam.zoom !== staticZoom) return [0, 0];
  const b = basis();
  const dx = cam.target[0] - staticTarget[0];
  const dy = cam.target[1] - staticTarget[1];
  const dz = cam.target[2] - staticTarget[2];
  const sx = (b.u[0] * dx + b.u[1] * dy + b.u[2] * dz) * cam.zoom;
  const sy = (b.v[0] * dx + b.v[1] * dy + b.v[2] * dz) * cam.zoom;
  return [-sx, sy];
}

function blitStatic() {
  const po = panOffset();
  // desplazamiento en px enteros: nitido y sin remuestreo bilineal
  const sx = M + Math.round(-po[0]), sy = M + Math.round(-po[1]);
  ctx.clearRect(0, 0, W, H);
  ctx.drawImage(bufCanvas, sx, sy, W, H, 0, 0, W, H);
}

function setTel(text, name) {
  samples = parseTel(text);
  prepTrack();
  miniNeedStatic = true;
  airSamples = 0; invSamples = 0;
  if (trk) for (let i = 0; i < trk.n; i++) { if (trk.FL[i] & 1) airSamples++; if (trk.FL[i] & 2) invSamples++; }
  idx = 0; playT = 0; lastLoopIdx = -1; lastStatsCi = -2; lastVeh = null; tlStatic = null; tlPx = -1;
  buildTelObjs();

  // muestras por segundo reales (solo para mostrar aire/inv en segundos; la reproduccion usa el tiempo real)
  if (samples.length > 1) {
    const dt_ms = samples[samples.length - 1].t - samples[0].t;
    playbackHz = ((samples.length - 1) / (dt_ms / 1000)) || 20;
  } else {
    playbackHz = 20;
  }

  const mapTag = (meta && meta.map) ? meta.map : "";
  $("fileInfo").textContent = `${name}${mapTag ? " · " + mapTag : ""} · ${samples.length} muestras · ${telObjs.length} piezas`;
  if ($("hudMap")) $("hudMap").textContent = mapTag ? ("mapa: " + mapTag) : "";
  if (mapTag) document.title = "MTA Viewer — " + mapTag;
  showTel = true;
  $("showTelChk").checked = true;
  needStatic = true;
  fitCam();
  draw();
  checkMatch();
}

function setMap(text, name) {
  mapObjs = parseMap(text);
  mapGroups = buildGroups(mapObjs);
  $("fileInfo").textContent = `${name} · ${mapObjs.length} objetos`;
  showMap = true;
  $("showMapChk").checked = true;
  needStatic = true;
  if (!samples.length || !showTel) fitCam();
  draw();
  checkMatch();
}

$("showMapChk").addEventListener("change", (e) => { showMap = e.target.checked; mapDirty = true; needStatic = true; draw(); });
$("showTelChk").addEventListener("change", (e) => { showTel = e.target.checked; telDirty = true; needStatic = true; draw(); });
$("showGridChk").addEventListener("change", (e) => { showGrid = e.target.checked; needStatic = true; draw(); });

$("telFile").addEventListener("change", (e) => {
  const f = e.target.files[0]; if (!f) return;
  const r = new FileReader();
  r.onload = () => { try { setTel(String(r.result), f.name); } catch (err) { alert("Error: " + err.message); } };
  r.readAsText(f);
});
$("mapFile").addEventListener("change", (e) => {
  const f = e.target.files[0]; if (!f) return;
  const r = new FileReader();
  r.onload = () => { try { setMap(String(r.result), f.name); } catch (err) { alert("Error: " + err.message); } };
  r.readAsText(f);
});

$("fitBtn").onclick = () => { fitCam(); draw(); };
$("topBtn").onclick = () => { cam.pitch = Math.PI/2 - 0.02; cam.yaw = 0; needStatic = true; draw(); };
$("followChk").addEventListener("change", (e) => { follow = e.target.checked; needStatic = true; draw(); });
$("qualitySel").addEventListener("change", (e) => { quality = e.target.value; needStatic = true; draw(); });

$("playBtn").onclick = () => {
  if (!samples.length) { alert("Cargá una telemetría primero"); return; }
  
  // Rebobinado automático si terminó la reproducción
  if (!playing && idx >= samples.length - 1) {
      idx = 0;
  }

  playing = !playing;
  $("playBtn").textContent = playing ? "⏸" : "▶";
  if (playing) { lastFrame = performance.now(); lastLoopIdx = -1; requestAnimationFrame(loop); }
};

$("prevBtn").onclick = () => { idx = Math.max(0, curIndex()-1); draw(); };
$("nextBtn").onclick = () => { idx = Math.min(samples.length-1, curIndex()+1); draw(); };
$("time").addEventListener("input", (e) => { idx = parseInt(e.target.value,10) || 0; draw(); });

// rango de altura para resaltar piezas
function applyZRange() {
  const a = parseFloat($("zmin").value), b = parseFloat($("zmax").value);
  if (!isNaN(a) && !isNaN(b)) highlightZ = [Math.min(a, b), Math.max(a, b)];
  else highlightZ = null;
  needStatic = true;
  draw();
}
// buscar la muestra por numero de pieza (oc)
function searchNumber() {
  const n = parseInt($("searchN").value, 10);
  if (isNaN(n)) return;
  const re = new RegExp("\\(" + n + "\\)\\s*$");
  for (let i = 0; i < samples.length; i++) {
    const oc = samples[i].oc || "";
    if (re.test(oc)) { idx = i; cam.target = [samples[i].x, samples[i].y, samples[i].z]; needStatic = true; draw(); return; }
  }
  alert("No hay muestra con la pieza #" + n);
}
// buscar una muestra por tiempo (segundos o mm:ss)
function searchTime() {
  const raw = ($("searchT").value || "").trim();
  if (!raw) return;
  let sec = NaN;
  if (raw.includes(":")) {
    const p = raw.split(":").map((x) => parseFloat(x));
    if (p.length === 2) sec = p[0] * 60 + p[1];
    else if (p.length === 3) sec = p[0] * 3600 + p[1] * 60 + p[2];
  } else {
    sec = parseFloat(raw);
  }
  if (isNaN(sec) || sec < 0) { alert("Tiempo invalido"); return; }
  if (!samples.length) return;
  const t0 = samples[0].t;
  let best = 0, bd = Infinity;
  for (let i = 0; i < samples.length; i++) {
    const ts = (samples[i].t - t0) / 1000;
    const d = Math.abs(ts - sec);
    if (d < bd) { bd = d; best = i; }
  }
  idx = best;
  playT = samples[best].t;
  cam.target = [samples[best].x, samples[best].y, samples[best].z];
  needStatic = true;
  draw();
}
if ($("btnTime")) $("btnTime").onclick = searchTime;
if ($("searchT")) $("searchT").addEventListener("keydown", (e) => { if (e.key === "Enter") searchTime(); });
if ($("btnZ")) $("btnZ").onclick = applyZRange;
if ($("btnSearch")) $("btnSearch").onclick = searchNumber;
if ($("searchN")) $("searchN").addEventListener("keydown", (e) => { if (e.key === "Enter") searchNumber(); });

function loop(now) {
  if (!playing) return;
  let dt = (now - lastFrame) / 1000;
  lastFrame = now;
  // el reloj sigue al tiempo real: un frame lento ya no "atrasa" la reproduccion (antes dt se recortaba a 33 ms)
  if (!(dt > 0)) dt = 0; else if (dt > 0.1) dt = 0.1;
  noteFrame(dt * 1000);
  if (!trk) { playing = false; $("playBtn").textContent = "▶"; return; }

  if (idx !== lastLoopIdx) playT = idxToTime(idx);      // el usuario movio la linea de tiempo
  playT += dt * 1000 * playSpeed;
  idx = timeToIdx(playT);                               // por tiempo REAL de cada muestra, no a ritmo fijo por indice
  if (playT >= trk.T[trk.n - 1]) {
    idx = trk.n - 1;
    playing = false;
    $("playBtn").textContent = "▶";
  }
  lastLoopIdx = idx;
  drawNow();
  if (playing) requestAnimationFrame(loop);
}

// ---------- navegacion ajustada ----------
let drag = null;
view.addEventListener("contextmenu", (e) => e.preventDefault());
view.addEventListener("mousedown", (e) => {
  drag = { x: e.clientX, y: e.clientY, pan: e.button === 2 || e.shiftKey };
  dragging = true;
});
window.addEventListener("mouseup", () => { if (drag) { drag = null; dragging = false; needStatic = true; draw(); } });
window.addEventListener("mousemove", (e) => {
  if (!drag) return;
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  drag.x = e.clientX; drag.y = e.clientY;
  const b = basis();
  
  if (drag.pan) {
    const Xs = -dx / cam.zoom;
    const Ys = dy / cam.zoom;
    cam.target[0] += b.u[0]*Xs + b.v[0]*Ys;
    cam.target[1] += b.u[1]*Xs + b.v[1]*Ys;
    cam.target[2] += b.u[2]*Xs + b.v[2]*Ys;
  } else {
    cam.yaw -= dx * 0.005;
    cam.pitch += dy * 0.005;
    cam.pitch = Math.max(-1.5, Math.min(Math.PI/2, cam.pitch));
  }
  if (!drag.pan) needStatic = true;     // el pan puro lo resuelve el scroll de franjas (sin re-render completo)
  draw();
});

view.addEventListener("wheel", (e) => {
  e.preventDefault();
  const b = basis();
  const mx = e.offsetX, my = e.offsetY;
  const z1 = cam.zoom;
  const zoomFactor = e.deltaY > 0 ? 0.85 : 1.15;
  const z2 = Math.max(0.02, Math.min(40, z1 * zoomFactor));
  const Xs = (mx - W/2) / z1;
  const Ys = (H/2 - my) / z1;
  const wx = b.u[0]*Xs + b.v[0]*Ys;
  const wy = b.u[1]*Xs + b.v[1]*Ys;
  const wz = b.u[2]*Xs + b.v[2]*Ys;
  const k = 1 - z2/z1;
  cam.target[0] += wx * k; 
  cam.target[1] += wy * k; 
  cam.target[2] += wz * k;
  cam.zoom = z2;
  needStatic = true;
  draw();
}, { passive: false });

view.addEventListener("dblclick", (e) => {
  if (!samples.length || !showTel) return;
  const mx = e.offsetX, my = e.offsetY;
  let best = -1, bd = 40;
  for (let i=0;i<samples.length;i++) {
    const p = project([samples[i].x, samples[i].y, samples[i].z]);
    const d = Math.hypot(p[0]-mx, p[1]-my);
    if (d < bd) { bd = d; best = i; }
  }
  if (best >= 0) { idx = best; frameOn(samples[best]); draw(); }
});

window.addEventListener("keydown", (e) => {
  if (e.target && /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
  const b = basis();
  const step = 40 / cam.zoom;
  switch (e.key.toLowerCase()) {
    case "w": cam.target[0] += b.v[0]*step; cam.target[1] += b.v[1]*step; cam.target[2] += b.v[2]*step; break;
    case "s": cam.target[0] -= b.v[0]*step; cam.target[1] -= b.v[1]*step; cam.target[2] -= b.v[2]*step; break;
    case "a": cam.target[0] -= b.u[0]*step; cam.target[1] -= b.u[1]*step; cam.target[2] -= b.u[2]*step; break;
    case "d": cam.target[0] += b.u[0]*step; cam.target[1] += b.u[1]*step; cam.target[2] += b.u[2]*step; break;
    case "q": cam.zoom = Math.max(0.02, cam.zoom*0.88); break;
    case "e": cam.zoom = Math.min(40, cam.zoom*1.12); break;
    case "arrowleft": cam.yaw += 0.06; break;
    case "arrowright": cam.yaw -= 0.06; break;
    case "arrowup": cam.pitch = Math.min(Math.PI/2, cam.pitch+0.05); break;
    case "arrowdown": cam.pitch = Math.max(-1.5, cam.pitch-0.05); break;
    case "r": fitCam(); break;
    case "t": cam.pitch = Math.PI/2-0.02; cam.yaw = 0; break;
    case "f": follow = !follow; $("followChk").checked = follow; break;
    case "g": showGrid = !showGrid; if ($("showGridChk")) $("showGridChk").checked = showGrid; break;
    case " ": e.preventDefault(); $("playBtn").click(); break;
    default: return;
  }
  needStatic = true;
  draw();
});

let touch = null;
view.addEventListener("touchstart", (e) => {
  if (e.touches.length === 1) touch = { x: e.touches[0].clientX, y: e.touches[0].clientY };
  else if (e.touches.length === 2) {
    const dx = e.touches[0].clientX - e.touches[1].clientX;
    const dy = e.touches[0].clientY - e.touches[1].clientY;
    touch = { dist: Math.hypot(dx, dy), cx: (e.touches[0].clientX+e.touches[1].clientX)/2, cy: (e.touches[0].clientY+e.touches[1].clientY)/2 };
  }
}, { passive: true });
view.addEventListener("touchmove", (e) => {
  e.preventDefault();
  if (e.touches.length === 1 && touch && touch.x != null) {
    const dx = e.touches[0].clientX - touch.x, dy = e.touches[0].clientY - touch.y;
    touch.x = e.touches[0].clientX; touch.y = e.touches[0].clientY;
    cam.yaw -= dx*0.005; cam.pitch = Math.max(-1.5, Math.min(Math.PI/2, cam.pitch + dy*0.005));
  } else if (e.touches.length === 2 && touch && touch.dist) {
    const dx = e.touches[0].clientX - e.touches[1].clientX;
    const dy = e.touches[0].clientY - e.touches[1].clientY;
    const d = Math.hypot(dx, dy) || 1;
    cam.zoom = Math.max(0.02, Math.min(40, cam.zoom * (d / touch.dist)));
    touch.dist = d;
  }
  needStatic = true;
  draw();
}, { passive: false });
view.addEventListener("touchend", () => { touch = null; needStatic = true; draw(); }, { passive: true });

view.addEventListener("dragover", (e) => e.preventDefault());
view.addEventListener("drop", (e) => {
  e.preventDefault();
  const f = e.dataTransfer.files[0]; if (!f) return;
  const r = new FileReader();
  r.onload = () => {
    try {
      if (/\.map$/i.test(f.name) || /<map/i.test(String(r.result).slice(0,200))) setMap(String(r.result), f.name);
      else setTel(String(r.result), f.name);
    } catch (err) { alert("Error: " + err.message); }
  };
  r.readAsText(f);
});

function miniToWorld(ev) {
  if (!samples.length || !showTel) return null;
  let minx = 1e9, maxx = -1e9, miny = 1e9, maxy = -1e9;
  for (const s of samples) {
    if (s.x < minx) minx = s.x; if (s.x > maxx) maxx = s.x;
    if (s.y < miny) miny = s.y; if (s.y > maxy) maxy = s.y;
  }
  const sc = Math.min(mini.width / Math.max(1, maxx-minx), mini.height / Math.max(1, maxy-miny)) * 0.85;
  const ox = (mini.width - (maxx-minx)*sc)/2;
  const oy = (mini.height - (maxy-miny)*sc)/2;
  const r = mini.getBoundingClientRect();
  const px = (ev.clientX - r.left) * (mini.width / r.width);
  const py = (ev.clientY - r.top) * (mini.height / r.height);
  const x = minx + (px - ox) / sc;
  const y = miny + (mini.height - oy - py) / sc;
  return [x, y];
}
mini.addEventListener("click", (ev) => {
  const w = miniToWorld(ev);
  if (w) { cam.target[0] = w[0]; cam.target[1] = w[1]; needStatic = true; draw(); }
});

window.addEventListener("resize", resize);
resize();
// mostrar/ocultar el panel derecho

if ($("settingsBtn")) $("settingsBtn").onclick = () => $("settingsModal").classList.add("show");
if ($("closeSettings")) $("closeSettings").onclick = () => $("settingsModal").classList.remove("show");
if ($("settingsModal")) $("settingsModal").addEventListener("click", (e) => { if (e.target.id === "settingsModal") e.target.classList.remove("show"); });
if ($("pickupsChk")) $("pickupsChk").addEventListener("change", (e) => { showPickups = e.target.checked; mapDirty = true; needStatic = true; draw(); });
if ($("markersChk")) $("markersChk").addEventListener("change", (e) => { showMarkers = e.target.checked; mapDirty = true; needStatic = true; draw(); });
if ($("markerSel")) $("markerSel").addEventListener("change", (e) => {
  markerMode = e.target.value === "car" ? "car" : e.target.value === "box" ? "box" : "arrow";
  draw();
});
if ($("carStyleSel")) $("carStyleSel").addEventListener("change", (e) => { carStyle = e.target.value; draw(); });

if ($("speedModeSel")) $("speedModeSel").addEventListener("change", (e) => {
  speedMode = e.target.value === "num" ? "num" : e.target.value === "tachonum" ? "tachonum" : "numtacho";
  applySpeedMode();
  draw();
});
if ($("speedSel")) $("speedSel").addEventListener("change", (e) => {
  playSpeed = parseFloat(e.target.value) || 1;
});


// ---------- agregar archivo (+), match mapa/recorrido ----------
function mapNumbers() {
  const set = new Set();
  for (const o of mapObjs) {
    const m = /\((\d+)\)\s*$/.exec(o.id || "");
    if (m) set.add(m[1]);
  }
  return set;
}
function checkMatch() {
  const sel = $("viewMode");
  if (!sel) return;
  if (!mapObjs.length || !samples.length) { sel.style.display = "none"; return; }
  const byId = new Map();
  for (const o of mapObjs) {
    const m = /\((\d+)\)\s*$/.exec(o.id || "");
    if (m) byId.set(m[1], o);
  }
  let hit = 0, strong = 0;
  for (const s of samples) {
    const m = /\((\d+)\)\s*$/.exec(s.oc || "");
    if (!m) continue;
    const o = byId.get(m[1]);
    if (!o) continue;
    hit++;
    if (typeof s.ox === "number") {
      let cx = 0, cy = 0, cz = 0;
      for (const q of o.corners) { cx += q[0]; cy += q[1]; cz += q[2]; }
      cx /= o.corners.length; cy /= o.corners.length; cz /= o.corners.length;
      const d = Math.hypot(s.ox - cx, s.oy - cy, s.oz - cz);
      if (d < 8) strong++;
    }
  }
  if (strong >= 10 && hit >= 10) {
    sel.style.display = "";
    if ($("matchInfo")) { $("matchInfo").textContent = `✓ misma pista (${hit})`; $("matchInfo").style.color = "#3fb950"; }
    showMap = true;
    if ($("showMapChk")) $("showMapChk").checked = true;
    needStatic = true;
    draw();
  } else {
    sel.style.display = "none";
    if ($("matchInfo")) {
      $("matchInfo").textContent = "✗ telemetría y mapa no coinciden";
      $("matchInfo").style.color = "#ff5555";
    }
    showMap = false;
    if ($("showMapChk")) $("showMapChk").checked = false;
    needStatic = true;
    draw();
  }
}
if ($("addBtn")) $("addBtn").onclick = () => $("addFile").click();
if ($("addFile")) $("addFile").addEventListener("change", async (e) => {
  const files = Array.from(e.target.files || []);
  for (const f of files) {
    const text = await f.text();
    if (/<map[\s>]/i.test(text.slice(0, 400))) setMap(text, f.name);
    else setTel(text, f.name);
  }
  e.target.value = "";
  checkMatch();
});
if ($("viewMode")) $("viewMode").addEventListener("change", (e) => {
  showMap = e.target.value === "map";
  if ($("showMapChk")) $("showMapChk").checked = showMap;
  needStatic = true;
  draw();
});
if ($("panelBtn")) $("panelBtn").onclick = () => {
  const p = $("panel");
  if (!p) return;
  p.classList.toggle("hidden");
  $("panelBtn").textContent = p.classList.contains("hidden") ? "Panel ◨" : "Panel ◧";
  resize();
};

// ---------- ajustes persistentes ----------
function saveSettings() {
  try {
    localStorage.setItem("mtaViewerSettings", JSON.stringify({
      marker: markerMode, quality, speed: playSpeed, grid: showGrid,
      pickups: showPickups, markers: showMarkers, style: carStyle, map: showMap, tel: showTel, follow, hud: speedMode,
    }));
  } catch (_) {}
}
function loadSettings() {
  let o;
  try { o = JSON.parse(localStorage.getItem("mtaViewerSettings") || "{}"); } catch (_) { return; }
  if (o.marker) { markerMode = o.marker; if ($("markerSel")) $("markerSel").value = o.marker; }
  if (o.quality) { quality = o.quality; if ($("qualitySel")) $("qualitySel").value = o.quality; }
  if (o.speed) { playSpeed = o.speed; if ($("speedSel")) $("speedSel").value = String(o.speed); }
  if (o.hud) { speedMode = o.hud; if ($("speedModeSel")) $("speedModeSel").value = o.hud; }
  if (typeof o.grid === "boolean") { showGrid = o.grid; if ($("showGridChk")) $("showGridChk").checked = o.grid; }
  if (typeof o.pickups === "boolean") { showPickups = o.pickups; if ($("pickupsChk")) $("pickupsChk").checked = o.pickups; }
  if (o.style) { carStyle = o.style; if ($("carStyleSel")) $("carStyleSel").value = o.style; }
  if (typeof o.markers === "boolean") { showMarkers = o.markers; if ($("markersChk")) $("markersChk").checked = o.markers; }
  if (typeof o.map === "boolean") { showMap = o.map; if ($("showMapChk")) $("showMapChk").checked = o.map; }
  if (typeof o.tel === "boolean") { showTel = o.tel; if ($("showTelChk")) $("showTelChk").checked = o.tel; }
  if (typeof o.follow === "boolean") { follow = o.follow; if ($("followChk")) $("followChk").checked = o.follow; }
  needStatic = true;
  applySpeedMode();
}
if ($("settingsModal")) $("settingsModal").addEventListener("change", saveSettings);
if ($("followChk")) $("followChk").addEventListener("change", saveSettings);
loadSettings();
