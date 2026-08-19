// server.js — Backend v2 ITP-EarthWatch
// Análisis satelital comparativo con Sentinel Hub:
//  - Máscara de nubes SCL por polígono
//  - NDVI enmascarado (un solo grupo, units DN)
//  - Composite temporal server-side (mediana)
//  - Índice radar RVI continuo (VV/VH)
//  - Detección de cambio dual-sensor (NDVI + RVI)
//  - Serie temporal NDVI
//  - Clasificación adaptativa (Otsu) + presets
//  - Rate limiting + healthz + caché de token
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { fromArrayBuffer } = require('geotiff');
const { PNG } = require('pngjs');

const app = express();
app.use(cors({ origin: true }));
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`);
  next();
});
app.use(express.json({ limit: '10mb' }));
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json({ error: 'JSON inválido o demasiado grande.' });
  }
  next(err);
});
app.use(rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas solicitudes. Espera un momento.' }
}));

// ============================================================
// FIREBASE ADMIN — metering mensual por usuario y polígono
// ============================================================
let admin = null, db = null;
let meteringEnabled = false;
try {
  const saJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  const saPath = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (saJson) {
    admin = require('firebase-admin');
    admin.initializeApp({ credential: admin.credential.cert(JSON.parse(saJson)) });
    db = admin.firestore();
    meteringEnabled = true;
    console.log('🔥 Firebase Admin inicializado desde FIREBASE_SERVICE_ACCOUNT_JSON (metering ACTIVO).');
  } else if (saPath && fs.existsSync(saPath)) {
    admin = require('firebase-admin');
    admin.initializeApp({ credential: admin.credential.cert(require(saPath)) });
    db = admin.firestore();
    meteringEnabled = true;
    console.log('🔥 Firebase Admin inicializado desde FIREBASE_SERVICE_ACCOUNT (metering por polígono ACTIVO).');
  } else {
    console.warn(`⚠️ Credencial de servicio de Firebase no configurada (FIREBASE_SERVICE_ACCOUNT_JSON o FIREBASE_SERVICE_ACCOUNT=${saPath}) → metering DESACTIVADO.`);
  }
} catch (e) {
  console.error('❌ No se pudo inicializar Firebase Admin:', e.message);
}

// Clave del mes local (YYYY-MM); los créditos se restablecen el día 1 a las 00:00.
function monthKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
// Clave del día local (YYYY-MM-DD): mismo polígono el mismo día NO descuenta; otro día sí.
function dayKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
// Suma de polígonos-día del mes (todas las llaves de días que empiezan con YYYY-MM).
function usageOfMonth(pusage, month) {
  let total = 0;
  for (const k of Object.keys(pusage || {})) {
    if (k.startsWith(month) && Array.isArray(pusage[k])) total += pusage[k].length;
  }
  return total;
}
// Hash canónico del polígono: coords redondeadas a ~1 m + orden normalizado.
function polygonHash(ring) {
  const pts = ring.map(c => [Math.round(c[0] * 1e5) / 1e5, Math.round(c[1] * 1e5) / 1e5]);
  if (pts.length > 1 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]) pts.pop();
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return crypto.createHash('sha256').update(JSON.stringify(pts)).digest('hex');
}
async function checkUser(req, res) {
  if (!meteringEnabled) return true;
  const m = (req.headers.authorization || '').match(/^Bearer (.+)$/i);
  if (!m) { res.status(401).json({ error: 'No autenticado. Vuelve a iniciar sesión.' }); return false; }
  try { req.uid = (await admin.auth().verifyIdToken(m[1])).uid; }
  catch (e) { res.status(401).json({ error: 'Sesión inválida o expirada. Vuelve a iniciar sesión.' }); return false; }
  // Sesión única: si el usuario inició sesión en otro dispositivo, este queda invalidado.
  try {
    const snap = await db.collection('users').doc(req.uid).get();
    const sid = snap.exists ? snap.data().sessionId : null;
    if (sid && req.headers['x-session-id'] !== sid) {
      res.status(401).json({
        code: 'SESION_OTRO_DISPOSITIVO',
        error: 'Tu sesión se cerró porque tu cuenta inició sesión en otro dispositivo. Si fuiste tú, no tienes que hacer nada. De lo contrario, solicita el cambio de tu contraseña.'
      });
      return false;
    }
  } catch (e) { /* no bloquear si falla la lectura */ }
  return true;
}
// Ventana de nieve por empresa: `meses_nieve` admite "4-10", "4,5,6,7,8,9,10" o un rango que cruza
// el año ("11-3"). Si falta, está vacío o no es válido → null (sin máscara de nieve: no se pide B11).
function parseMesesNieve(v) {
  const out = new Set();
  const push = (n) => { if (Number.isFinite(n) && n >= 1 && n <= 12) out.add(n); };
  if (Array.isArray(v)) { for (const x of v) push(Number(x)); }
  else if (typeof v === 'number') { push(v); }
  else if (typeof v === 'string') {
    v = v.trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    for (const part of v.split(',')) {
      const t = part.trim();
      if (!t) continue;
      const m = t.match(/^(\d{1,2})\s*-\s*(\d{1,2})$/);
      if (m) {
        const a = parseInt(m[1], 10), b = parseInt(m[2], 10);
        if (a >= 1 && a <= 12 && b >= 1 && b <= 12) {
          if (a <= b) { for (let i = a; i <= b; i++) push(i); }
          else { for (let i = a; i <= 12; i++) push(i); for (let i = 1; i <= b; i++) push(i); }
        }
      } else {
        push(parseInt(t, 10));
      }
    }
  }
  return out.size ? Array.from(out).sort((x, y) => x - y) : null;
}
// Lee la cuota mensual y la ventana de nieve de la empresa del usuario (colección `empresas`,
// doc id = valor de `empresa`). Devuelve null si el usuario no tiene empresa o el doc no existe.
async function readEmpresa(data) {
  const key = data && typeof data.empresa === 'string' ? data.empresa.trim() : '';
  if (!key) return null;
  const snap = await db.collection('empresas').doc(key).get();
  if (!snap.exists) return null;
  const d = snap.data() || {};
  const limit = Number(d.cuota_mensual) || 0;
  const day = dayKey();
  const pusage = (d.polygonUsage && typeof d.polygonUsage === 'object') ? d.polygonUsage : {};
  return { key, limit, used: usageOfMonth(pusage, monthKey()), todayUsage: pusage[day] || [], hashDay: day, mesesNieve: parseMesesNieve(d.meses_nieve) };
}
// Pre-chequeo: bloquea (429) solo si el polígono-día es NUEVO y la cuota del mes (usuario o empresa) está al tope.
async function meterPolygon(req, res, ring) {
  if (!meteringEnabled) return { ok: true, counted: false };
  const hash = polygonHash(ring);
  const day = dayKey();
  const month = monthKey();
  const snap = await db.collection('users').doc(req.uid).get();
  const data = snap.exists ? snap.data() : {};
  const limit = Number(data.polygonLimit) || 100;
  const pusage = (data.polygonUsage && typeof data.polygonUsage === 'object') ? data.polygonUsage : {};
  const todayUsage = pusage[day] || [];
  const used = usageOfMonth(pusage, month);
  const emp = await readEmpresa(data);
  if (todayUsage.includes(hash)) return { ok: true, counted: false, hash, day, month, empresa: emp ? { ...emp, counted: false } : null };
  if (used >= limit) {
    res.status(429).json({
      error: `Has alcanzado tu límite mensual de ${limit} polígonos. Contacta al administrador para ampliarlo.`,
      quota: { used: limit, limit, remaining: 0 }
    });
    return { ok: false };
  }
  if (emp && emp.limit > 0 && !emp.todayUsage.includes(hash) && emp.used >= emp.limit) {
    res.status(429).json({
      error: `La cuota mensual de tu empresa (${emp.limit} polígonos) se agotó. Contacta al administrador para ampliarla.`,
      quota: { used, limit, remaining: Math.max(0, limit - used), empresa: { used: emp.used, limit: emp.limit, remaining: 0 } }
    });
    return { ok: false };
  }
  return { ok: true, counted: true, hash, day, month, empresa: emp ? { ...emp, counted: !emp.todayUsage.includes(hash) } : null };
}
// Commit al finalizar con éxito: suma el hash del día (transacción, usuario y empresa) y devuelve las cuotas mensuales.
async function commitPolygon(req, res, m) {
  if (!meteringEnabled) return null;
  if (m.counted) {
    const ref = db.collection('users').doc(req.uid);
    await db.runTransaction(async (t) => {
      const snap = await t.get(ref);
      const data = snap.exists ? snap.data() : {};
      const limit = Number(data.polygonLimit) || 100;
      const pusage = (data.polygonUsage && typeof data.polygonUsage === 'object') ? data.polygonUsage : {};
      const usage = pusage[m.day] || [];
      const used = usageOfMonth(pusage, m.month);
      if (usage.includes(m.hash) || used >= limit) return;
      usage.push(m.hash);
      t.set(ref, { polygonUsage: { ...pusage, [m.day]: usage } }, { merge: true });
    });
  }
  if (m.empresa && m.empresa.counted && m.empresa.limit > 0) {
    const ref = db.collection('empresas').doc(m.empresa.key);
    await db.runTransaction(async (t) => {
      const snap = await t.get(ref);
      const d = snap.exists ? snap.data() : {};
      const limit = Number(d.cuota_mensual) || 0;
      if (limit <= 0) return;
      const pusage = (d.polygonUsage && typeof d.polygonUsage === 'object') ? d.polygonUsage : {};
      const usage = pusage[m.empresa.hashDay] || [];
      const used = usageOfMonth(pusage, m.month);
      if (usage.includes(m.hash) || used >= limit) return;
      usage.push(m.hash);
      t.set(ref, { polygonUsage: { ...pusage, [m.empresa.hashDay]: usage } }, { merge: true });
    });
  }
  const snap = await db.collection('users').doc(req.uid).get();
  const data = snap.exists ? snap.data() : {};
  const limit = Number(data.polygonLimit) || 100;
  const pusage = (data.polygonUsage && typeof data.polygonUsage === 'object') ? data.polygonUsage : {};
  const used = usageOfMonth(pusage, monthKey());
  const quota = { used, limit, remaining: Math.max(0, limit - used) };
  if (m.empresa && m.empresa.limit > 0) {
    const empSnap = await db.collection('empresas').doc(m.empresa.key).get();
    const ed = empSnap.exists ? empSnap.data() : {};
    const epusage = (ed.polygonUsage && typeof ed.polygonUsage === 'object') ? ed.polygonUsage : {};
    const eused = usageOfMonth(epusage, monthKey());
    quota.empresa = { used: eused, limit: m.empresa.limit, remaining: Math.max(0, m.empresa.limit - eused) };
  }
  return quota;
}
async function meterEndpoints(req, res, ring) {
  if (!(await checkUser(req, res))) return null;
  const m = await meterPolygon(req, res, ring);
  if (!m.ok) return null;
  return m;
}
// Ventana de nieve activa para la petición (según `meses_nieve` de la empresa del usuario).
// null = la empresa no la configuró → no se pide la banda SWIR y no se enmascara nieve.
function snowMonthsOf(m) {
  return m && m.empresa && Array.isArray(m.empresa.mesesNieve) ? m.empresa.mesesNieve : null;
}

const PORT = process.env.PORT || 10002;
const PROCESS_URL = 'https://services.sentinel-hub.com/api/v1/process';
const CATALOG_URL = 'https://services.sentinel-hub.com/api/v1/catalog/1.0.0/search';
const CRS = 'http://www.opengis.net/def/crs/OGC/1.3/CRS84';

// ============================================================
// TOKEN (caché)
// ============================================================
let tokenCache = { value: null, expiresAt: 0 };
async function getToken() {
  if (tokenCache.value && Date.now() < tokenCache.expiresAt) return tokenCache.value;
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: process.env.CLIENT_ID,
    client_secret: process.env.CLIENT_SECRET
  });
  const r = await fetch('https://services.sentinel-hub.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  });
  if (!r.ok) throw new Error('No se pudo obtener token: ' + (await r.text()).slice(0, 200));
  const data = await r.json();
  tokenCache = { value: data.access_token, expiresAt: Date.now() + ((data.expires_in || 1800) - 120) * 1000 };
  return tokenCache.value;
}

// ============================================================
// HELPERS GEOMETRÍA
// ============================================================
function toRing(coords) {
  if (!Array.isArray(coords) || coords.length === 0) return null;
  let ring = (Array.isArray(coords[0]) && Array.isArray(coords[0][0])) ? coords[0] : coords;
  const a = ring[0], b = ring[ring.length - 1];
  if (a && b && (a[0] !== b[0] || a[1] !== b[1])) ring = ring.concat([[a[0], a[1]]]);
  return ring;
}
function bboxOf(ring) {
  let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
  for (const c of ring) {
    if (!Array.isArray(c) || c.length < 2) return null;
    minLon = Math.min(minLon, c[0]); maxLon = Math.max(maxLon, c[0]);
    minLat = Math.min(minLat, c[1]); maxLat = Math.max(maxLat, c[1]);
  }
  if (minLon === Infinity) return null;
  return [minLon, minLat, maxLon, maxLat];
}
function areaOfBbox(bbox) {
  const [minLon, minLat, maxLon, maxLat] = bbox;
  const R = 6371000;
  const dLat = (maxLat - minLat) * Math.PI / 180;
  const dLon = (maxLon - minLon) * Math.PI / 180;
  const area = R * R * dLon * (Math.sin(maxLat * Math.PI / 180) - Math.sin(minLat * Math.PI / 180));
  const aspect = (dLon * Math.cos((minLat + maxLat) / 2 * Math.PI / 180)) / Math.max(1e-9, dLat);
  return { area: Math.abs(area), aspectRatio: aspect };
}
function imageSize(bbox, maxPx = 512) {
  const { area, aspectRatio } = areaOfBbox(bbox);
  const side = Math.sqrt(area);
  let base = Math.max(128, Math.min(maxPx, Math.round(side / 10)));
  let width, height;
  if (aspectRatio >= 1) {
    width = Math.round(base * Math.sqrt(aspectRatio));
    height = Math.round(width / aspectRatio);
  } else {
    height = Math.round(base * Math.sqrt(1 / aspectRatio));
    width = Math.round(height * aspectRatio);
  }
  return { width: Math.max(64, Math.min(maxPx, width)), height: Math.max(64, Math.min(maxPx, height)) };
}
function areaPerPixel(bbox, width, height) {
  const [minLon, minLat, maxLon, maxLat] = bbox;
  const latMid = ((minLat + maxLat) / 2) * Math.PI / 180;
  const wMeters = (maxLon - minLon) * 111320 * Math.cos(latMid);
  const hMeters = (maxLat - minLat) * 110540;
  return (wMeters * hMeters) / (width * height);
}
function polygonAreaHa(ring) {
  let sum = 0;
  const R = 6371000;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const latA = a[1] * Math.PI / 180, latB = b[1] * Math.PI / 180;
    const dLon = (b[0] - a[0]) * Math.PI / 180;
    sum += dLon * (2 + Math.sin(latA) + Math.sin(latB));
  }
  const area = (R * R * Math.abs(sum)) / 2;
  return area / 10000;
}
function pointInRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    const intersect = ((yi > lat) !== (yj > lat)) && (lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}
function maskIndices(width, height, bbox, ring) {
  const [minLon, minLat, maxLon, maxLat] = bbox;
  const idx = new Uint32Array(width * height);
  let n = 0;
  for (let py = 0; py < height; py++) {
    const lat = maxLat - (py / (height - 1)) * (maxLat - minLat);
    for (let px = 0; px < width; px++) {
      const lon = minLon + (px / (width - 1)) * (maxLon - minLon);
      if (pointInRing(lon, lat, ring)) idx[n++] = py * width + px;
    }
  }
  return idx.slice(0, n);
}

// ============================================================
// HELPERS SENTINEL HUB
// ============================================================
async function shFetch(payload) {
  const r = await fetch(PROCESS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${await getToken()}` },
    body: JSON.stringify(payload)
  });
  const buf = Buffer.from(await r.arrayBuffer());
  if (!r.ok) {
    let msg = buf.toString('utf8', 0, 400);
    try { msg = JSON.parse(msg).error?.message || msg; } catch (e) { /* ignore */ }
    throw new Error('Sentinel Hub: ' + msg);
  }
  return buf;
}
async function parseTiff(buf) {
  const tiff = await fromArrayBuffer(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const image = await tiff.getImage();
  const width = image.getWidth(), height = image.getHeight();
  const data = await image.readRasters({ interleave: false });
  return { width, height, bands: data.map((d, i) => ({ values: d, band: i })) };
}
async function catalogSearch({ bbox, collections, datetime, limit = 100, filter, next }) {
  const payload = { bbox, collections, datetime, limit };
  if (filter) payload.filter = filter;
  if (next) payload.next = next;
  const r = await fetch(CATALOG_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${await getToken()}` },
    body: JSON.stringify(payload)
  });
  const text = await r.text();
  if (!r.ok) throw new Error('Catálogo: ' + text.slice(0, 300));
  return JSON.parse(text);
}
// Token de paginación del catálogo (rel=next con body.next, estilo offset).
function catalogNext(j) {
  const n = (j && (j.links || [])).find(l => l.rel === 'next');
  return (n && n.body && n.body.next) || null;
}
function sleep(ms) { return new Promise(res => setTimeout(res, ms)); }

// ============================================================
// TRUE COLOR AUTORENDERIZADO (bandas TIFF con units DN)
// ============================================================
// El render PNG delegado a Sentinel Hub era inestable: cuando el granulo se servia en
// escala x10000 (nativa L2A) en vez de reflectancia 0-1, el evalscript 2.5*B*255
// saturada a blanco; con la banda B02 muerta quedaba amarillo. Pedimos las bandas
// crudas B04/B03/B02 como TIFF con units:"DN" (escala forzada 0-10000, independiente
// de lo que el granulo interno use) y renderizamos nosotros: refl = DN/10000, *2.5,
// clamp. El estado blanco pasa a ser imposible. Detector de granulo degradado en las
// bandas (vacio o banda azul muerta) con reintento; desactivable con TRUECOLOR_RETRY=0.
const TRUECOLOR_RETRY = process.env.TRUECOLOR_RETRY !== '0';
const TRUECOLOR_EVAL = `//VERSION=3
function setup() {
  return {
    input: [{ bands: ["B04","B03","B02"], units: "DN" }],
    output: { id: "res", bands: 3, sampleType: "FLOAT32" }
  };
}
function evaluatePixel(sample) { return { res: [sample.B04, sample.B03, sample.B02] }; }`;
function trueColorPayload({ ring, date, width, height }) {
  return {
    input: {
      bounds: { geometry: { type: 'Polygon', coordinates: [ring] } },
      data: [{ type: 'sentinel-2-l2a', dataFilter: { timeRange: { from: `${date}T00:00:00Z`, to: `${date}T23:59:59Z` }, maxCloudCoverage: 100 }, mosaicking: 'SCENE', units: 'DN' }]
    },
    output: { width, height, responses: [{ identifier: 'res', format: { type: 'image/tiff' } }] },
    evalscript: TRUECOLOR_EVAL
  };
}
// Detecta un granulo degradado en las bandas crudas: vacio (todo ~0, imagen negra),
// con la banda azul muerta (B02 ~0 mientras B04/B03 sanos, imagen amarilla) o
// "improbablemente oscuro" (ninguna banda supera DN 250 en todo el bbox: no hay nada
// brillante; suele ser el otro granulo del mismo dia, sin el cultivo, en vez del correcto).
function trueColorBandStats(bands, width, height) {
  const n = width * height;
  const means = [0, 0, 0];
  const maxs = [0, 0, 0];
  let valid = 0;
  for (let i = 0; i < n; i++) {
    let all = true;
    for (let b = 0; b < 3; b++) {
      const v = bands[b][i];
      if (v === undefined || v === null || Number.isNaN(v)) { all = false; break; }
      means[b] += v;
      if (v > maxs[b]) maxs[b] = v;
    }
    if (all) valid++;
  }
  if (valid === 0) return { degraded: true, validFraction: 0, means: [0, 0, 0], maxs: [0, 0, 0] };
  const m = means.map(x => x / valid);
  const empty = m[0] < 5 && m[1] < 5 && m[2] < 5;
  const deadBlue = m[2] < 30 && m[0] > 200 && m[1] > 200;
  const allDark = Math.max(...maxs) < 250;
  return { degraded: valid / n < 0.3 || empty || deadBlue || allDark, validFraction: valid / n, means: m, maxs };
}
async function shFetchTrueColorBands(payload, { attempts = 4, baseDelay = 1500 } = {}) {
  if (!TRUECOLOR_RETRY) {
    const { bands } = await parseTiff(await shFetch(payload));
    return bands.map(b => b.values);
  }
  let lastStats = null;
  for (let a = 0; a < attempts; a++) {
    let bands;
    try { bands = (await parseTiff(await shFetch(payload))).bands.map(b => b.values); }
    catch (e) { if (a < attempts - 1) { await sleep(baseDelay * Math.pow(2, a) * (0.75 + Math.random() * 0.5)); continue; } throw e; }
    const stats = trueColorBandStats(bands, payload.output.width, payload.output.height);
    if (!stats.degraded) return bands;
    lastStats = stats;
    if (a < attempts - 1) await sleep(baseDelay * Math.pow(2, a) * (0.75 + Math.random() * 0.5));
  }
  const m = lastStats.means.map(x => Math.round(x));
  const x = lastStats.maxs.map(x => Math.round(x));
  throw new Error(`Sentinel Hub sirvió un granulo truecolor degradado (B04/B03/B02 medio ${m.join('/')} máx ${x.join('/')}, válidos ${Math.round(lastStats.validFraction * 100)}%); se reintentó ${attempts} veces sin éxito.`);
}
// Render propio del truecolor desde bandas DN (0-10000) → reflectancia 0-1 → *2.5.
function renderTrueColorPng(bands, width, height) {
  const out = new PNG({ width, height });
  for (let i = 0; i < width * height; i++) {
    const rv = v => (Number.isFinite(v) ? v : 0);
    out.data[i * 4] = Math.max(0, Math.min(255, Math.round(2.5 * (rv(bands[0][i]) / 10000) * 255)));
    out.data[i * 4 + 1] = Math.max(0, Math.min(255, Math.round(2.5 * (rv(bands[1][i]) / 10000) * 255)));
    out.data[i * 4 + 2] = Math.max(0, Math.min(255, Math.round(2.5 * (rv(bands[2][i]) / 10000) * 255)));
    out.data[i * 4 + 3] = 255;
  }
  return PNG.sync.write(out);
}

// ============================================================
// EVALUACIÓN ÓPTICA (NDVI + nubes SCL, un grupo DN)
// ============================================================
// ¿Aplica la máscara de nieve a una fecha? Solo si la empresa configuró `meses_nieve`
// y el mes de la fecha cae dentro de la ventana. Fechas en otro formato → false (seguro).
function useSnowForDate(date, snowMonths) {
  if (!snowMonths || !snowMonths.length || typeof date !== 'string' || date.length < 7) return false;
  const mon = Number(date.slice(5, 7));
  return Number.isFinite(mon) && snowMonths.includes(mon);
}
// Diagnóstico: píxeles del óptico secundario enmascarados por nieve (ndvi NaN con cloud=0),
// válidos y nube. null si no hay óptico.
function snowMaskStats(s) {
  if (!s || !s.ndvi || !s.cloud) return null;
  let masked = 0, valid = 0, cloud = 0;
  for (let i = 0; i < s.ndvi.length; i++) {
    const n = s.ndvi[i], c = s.cloud[i];
    if (Number.isFinite(n) && Number.isFinite(c)) { valid++; if (c === 1) cloud++; }
    else if (!Number.isFinite(n) && Number.isFinite(c) && c === 0) masked++;
  }
  return { masked, valid, cloud, total: s.ndvi.length };
}
const OPTICAL_EVAL = `//VERSION=3
function setup() {
  return {
    input: [{ bands: ["B04","B08","SCL"], units: "DN" }],
    output: [{ id: "res", bands: 2, sampleType: "FLOAT32" }]
  };
}
function isCloud(scl) { return scl === 3 || scl === 8 || scl === 9 || scl === 10; }
function valid(scl) { return scl !== 0 && scl !== 1 && scl !== 11; }
function evaluatePixel(sample) {
  var scl = sample.SCL;
  if (!valid(scl)) return { res: [NaN, NaN] };
  var ndvi = (sample.B08 - sample.B04) / (sample.B08 + sample.B04 + 1e-8);
  return { res: [(ndvi + 1) / 2, isCloud(scl) ? 1 : 0] };
}`;

// Igual al anterior + banda SWIR (B11) para la máscara de nieve: píxeles con NDSI alto
// (nieve brillante) se marcan como sin dato (NaN) sin contarlos como nube. La nieve en
// SCL queda etiquetada como nube (8/9/10), por eso el chequeo va ANTES del isCloud.
// B11 en L2A es reflectancia x10000; B04 >= 2000 (refl >= 0.2) descarta agua turbia/vegetación.
const OPTICAL_EVAL_SNOW = `//VERSION=3
function setup() {
  return {
    input: [{ bands: ["B04","B08","B11","SCL"], units: "DN" }],
    output: [{ id: "res", bands: 2, sampleType: "FLOAT32" }]
  };
}
function isCloud(scl) { return scl === 3 || scl === 8 || scl === 9 || scl === 10; }
function valid(scl) { return scl !== 0 && scl !== 1 && scl !== 11; }
function evaluatePixel(sample) {
  var scl = sample.SCL;
  if (!valid(scl)) return { res: [NaN, NaN] };
  var ndsi = (sample.B04 - sample.B11) / (sample.B04 + sample.B11 + 1e-8);
  if (ndsi >= 0.45 && sample.B04 >= 2000) return { res: [NaN, 0] };
  var ndvi = (sample.B08 - sample.B04) / (sample.B08 + sample.B04 + 1e-8);
  return { res: [(ndvi + 1) / 2, isCloud(scl) ? 1 : 0] };
}`;

// Variantes con detector de CALIMA/NIEBLA para la nubosidad por polígono (cloud-polygon):
// además de la máscara SCL, un píxel cuenta como nube si el azul (B02) está elevado con
// NDVI bajo (calima fina que el SCL de L2A no clasifica), o si es brillante y casi blanco
// en las 3 bandas visibles. Así fechas como 2026-07-03/2026-06-26 (imagen blanca por
// neblina) dejan de mostrar 0% de nubosidad.
const OPTICAL_EVAL_HAZE = `//VERSION=3
function setup() {
  return {
    input: [{ bands: ["B02","B03","B04","B08","SCL"], units: "DN" }],
    output: [{ id: "res", bands: 2, sampleType: "FLOAT32" }]
  };
}
function isCloud(scl) { return scl === 3 || scl === 8 || scl === 9 || scl === 10; }
function valid(scl) { return scl !== 0 && scl !== 1 && scl !== 11; }
function evaluatePixel(sample) {
  var scl = sample.SCL;
  if (!valid(scl)) return { res: [NaN, NaN] };
  var ndvi = (sample.B08 - sample.B04) / (sample.B08 + sample.B04 + 1e-8);
  var hazy = (sample.B02 > 1000 && ndvi < 0.25) || (sample.B02 > 1700 && sample.B03 > 1700 && sample.B04 > 1700);
  return { res: [(ndvi + 1) / 2, (isCloud(scl) || hazy) ? 1 : 0] };
}`;
const OPTICAL_EVAL_HAZE_SNOW = `//VERSION=3
function setup() {
  return {
    input: [{ bands: ["B02","B03","B04","B08","B11","SCL"], units: "DN" }],
    output: [{ id: "res", bands: 2, sampleType: "FLOAT32" }]
  };
}
function isCloud(scl) { return scl === 3 || scl === 8 || scl === 9 || scl === 10; }
function valid(scl) { return scl !== 0 && scl !== 1 && scl !== 11; }
function evaluatePixel(sample) {
  var scl = sample.SCL;
  if (!valid(scl)) return { res: [NaN, NaN] };
  var ndsi = (sample.B04 - sample.B11) / (sample.B04 + sample.B11 + 1e-8);
  if (ndsi >= 0.45 && sample.B04 >= 2000) return { res: [NaN, 0] };
  var ndvi = (sample.B08 - sample.B04) / (sample.B08 + sample.B04 + 1e-8);
  var hazy = (sample.B02 > 1000 && ndvi < 0.25) || (sample.B02 > 1700 && sample.B03 > 1700 && sample.B04 > 1700);
  return { res: [(ndvi + 1) / 2, (isCloud(scl) || hazy) ? 1 : 0] };
}`;

async function fetchOptical({ ring, bbox, date, width, height, maxCloud = 100, snowMonths = null }) {
  const payload = {
    input: {
      bounds: { geometry: { type: 'Polygon', coordinates: [ring] } },
      data: [{ type: 'sentinel-2-l2a', dataFilter: { timeRange: { from: `${date}T00:00:00Z`, to: `${date}T23:59:59Z` }, maxCloudCoverage: maxCloud } }]
    },
    output: {
      width, height,
      responses: [{ identifier: 'res', format: { type: 'image/tiff' } }]
    },
    evalscript: useSnowForDate(date, snowMonths) ? OPTICAL_EVAL_SNOW : OPTICAL_EVAL
  };
  const buf = await shFetch(payload);
  const { bands } = await parseTiff(buf);
  if (bands.length < 2) throw new Error('Respuesta óptica incompleta (bands=' + bands.length + ')');
  return { ndvi: bands[0].values, cloud: bands[1].values, width, height };
}

// Igual a fetchOptical pero con la máscara de calima (solo se usa para nubosidad por polígono).
async function fetchOpticalHaze({ ring, bbox, date, width, height, maxCloud = 100, snowMonths = null }) {
  const payload = {
    input: {
      bounds: { geometry: { type: 'Polygon', coordinates: [ring] } },
      data: [{ type: 'sentinel-2-l2a', dataFilter: { timeRange: { from: `${date}T00:00:00Z`, to: `${date}T23:59:59Z` }, maxCloudCoverage: maxCloud } }]
    },
    output: {
      width, height,
      responses: [{ identifier: 'res', format: { type: 'image/tiff' } }]
    },
    evalscript: useSnowForDate(date, snowMonths) ? OPTICAL_EVAL_HAZE_SNOW : OPTICAL_EVAL_HAZE
  };
  const buf = await shFetch(payload);
  const { bands } = await parseTiff(buf);
  if (bands.length < 2) throw new Error('Respuesta óptica incompleta (bands=' + bands.length + ')');
  return { ndvi: bands[0].values, cloud: bands[1].values, width, height };
}

async function fetchTrueColor({ ring, bbox, date, width, height }) {
  const bands = await shFetchTrueColorBands(trueColorPayload({ ring, date, width, height }));
  return 'data:image/png;base64,' + renderTrueColorPng(bands, width, height).toString('base64');
}

// Truecolor recortado al polígono: fuera del anillo queda transparente (para superponer en el mapa).
async function fetchTrueColorMasked({ ring, bbox, date, width, height }) {
  const bands = await shFetchTrueColorBands(trueColorPayload({ ring, date, width, height }));
  const src = PNG.sync.read(renderTrueColorPng(bands, width, height));
  const mask = maskIndices(width, height, bbox, ring);
  const inside = new Uint8Array(width * height);
  for (const p of mask) inside[p] = 1;
  const out = new PNG({ width, height });
  for (let p = 0; p < width * height; p++) {
    const i = p * 4;
    out.data[i] = src.data[i];
    out.data[i + 1] = src.data[i + 1];
    out.data[i + 2] = src.data[i + 2];
    out.data[i + 3] = inside[p] ? 255 : 0;
  }
  return 'data:image/png;base64,' + PNG.sync.write(out).toString('base64');
}

async function findNearestOpticalDate(bbox, date, maxDays = 60) {
  const ref = new Date(date);
  const start = new Date(ref); start.setDate(start.getDate() - maxDays);
  const end = new Date(ref); end.setDate(end.getDate() + maxDays);
  const data = await catalogSearch({
    bbox,
    collections: ['sentinel-2-l2a'],
    datetime: `${start.toISOString().split('T')[0]}T00:00:00Z/${end.toISOString().split('T')[0]}T23:59:59Z`,
    limit: 100,
    filter: 'eo:cloud_cover < 60'
  });
  let best = null, bestDist = Infinity;
  for (const f of data.features) {
    const d = f.properties.datetime.split('T')[0];
    const dist = Math.abs(new Date(d) - ref);
    if (dist < bestDist) { bestDist = dist; best = d; }
  }
  return best;
}

// ============================================================
// EVALUACIÓN RADAR (RVI continuo)
// ============================================================
const RVI_EVAL = `//VERSION=3
function setup() {
  return {
    input: [{ bands: ["VV","VH"], units: "LINEAR_POWER" }],
    output: [{ id: "rvi", bands: 1, sampleType: "FLOAT32" }]
  };
}
function evaluatePixel(sample) {
  var vv = sample.VV; var vh = sample.VH;
  if (vv === undefined || vh === undefined || !isFinite(vv) || !isFinite(vh) || vv <= 0) return { rvi: [NaN] };
  var rvi = (4 * vh) / (vv + vh);
  return { rvi: [Math.max(0, Math.min(1, rvi))] };
}`;

async function findRadarDate(bbox) {
  const now = new Date();
  const start = new Date(); start.setFullYear(now.getFullYear() - 1);
  const data = await catalogSearch({
    bbox,
    collections: ['sentinel-1-grd'],
    datetime: `${start.toISOString().split('T')[0]}T00:00:00Z/${now.toISOString().split('T')[0]}T23:59:59Z`,
    limit: 30
  });
  // Solo 1SDV (VV/VH): el RVI necesita esas bandas; las escenas 1SDH (HH/HV) no sirven.
  for (const f of data.features) {
    if (f.id && f.id.includes('1SDV')) {
      return { date: f.properties.datetime.split('T')[0], id: f.id, pol: 'DV' };
    }
  }
  return null;
}
async function fetchRvi({ ring, bbox, date, width, height, polarization = 'DV' }) {
  const payload = {
    input: {
      bounds: { geometry: { type: 'Polygon', coordinates: [ring] } },
      data: [{
        type: 'sentinel-1-grd',
        dataFilter: { timeRange: { from: `${date}T00:00:00Z`, to: `${date}T23:59:59Z` }, polarization, instrumentMode: 'IW' },
        processing: { mosaicking: 'ORBIT' }
      }]
    },
    output: { width, height, responses: [{ identifier: 'rvi', format: { type: 'image/tiff' } }] },
    evalscript: RVI_EVAL
  };
  const buf = await shFetch(payload);
  const { bands } = await parseTiff(buf);
  return { rvi: medianFilter(bands[0].values, width, height, 2), width, height };
}

// Filtro de mediana (ventana 5x5) sobre un raster de punto flotante con NaN en píxeles inválidos.
// Reduce el speckle del radar sin desplazar los bordes (a diferencia de un promedio).
const _medScratch = [];
function medianFilter(arr, width, height, radius = 2) {
  if (radius <= 0 || width <= 0 || height <= 0) return arr;
  const out = new arr.constructor(arr.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      if (!Number.isFinite(arr[idx])) { out[idx] = NaN; continue; }
      _medScratch.length = 0;
      for (let dy = -radius; dy <= radius; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= height) continue;
        const rowBase = yy * width;
        for (let dx = -radius; dx <= radius; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= width) continue;
          const v = arr[rowBase + xx];
          if (Number.isFinite(v)) _medScratch.push(v);
        }
      }
      if (!_medScratch.length) { out[idx] = NaN; continue; }
      _medScratch.sort((a, b) => a - b);
      out[idx] = _medScratch[Math.floor(_medScratch.length / 2)];
    }
  }
  return out;
}

// ============================================================
// CONSENSO DUAL-SENSOR (Bosque = NDVI alto Y RVI alto)
// ============================================================
// Caché en memoria de rasters (S2 óptico / S1 radar) por polígono+fecha+resolución.
// Evita descargar el sensor complementario varias veces (~15 min).
const CONSENSUS_TTL_MS = 15 * 60 * 1000;
const rasterCache = new Map();
function consensusCacheKey(prefix, ring, date, width, height, extra = '') {
  return `${prefix}|${polygonHash(ring)}|${date}|${width}x${height}|${extra}`;
}
function consensusCacheGet(key) {
  const e = rasterCache.get(key);
  if (e && Date.now() - e.t < CONSENSUS_TTL_MS) return e.v;
  if (e) rasterCache.delete(key);
  return null;
}
function consensusCacheSet(key, v) {
  rasterCache.set(key, { v, t: Date.now() });
  if (rasterCache.size > 500) {
    const now = Date.now();
    for (const [k, e] of rasterCache) if (now - e.t > CONSENSUS_TTL_MS) rasterCache.delete(k);
  }
}
async function cachedOptical({ ring, bbox, date, width, height, snowMonths = null }) {
  const key = consensusCacheKey('s2', ring, date, width, height, useSnowForDate(date, snowMonths) ? 'snow' : '');
  const hit = consensusCacheGet(key);
  if (hit) return hit;
  const v = await fetchOptical({ ring, bbox, date, width, height, snowMonths });
  consensusCacheSet(key, v);
  return v;
}
async function cachedOpticalHaze({ ring, bbox, date, width, height, snowMonths = null }) {
  const key = consensusCacheKey('s2h', ring, date, width, height, useSnowForDate(date, snowMonths) ? 'snow' : '');
  const hit = consensusCacheGet(key);
  if (hit) return hit;
  const v = await fetchOpticalHaze({ ring, bbox, date, width, height, snowMonths });
  consensusCacheSet(key, v);
  return v;
}
async function cachedRvi({ ring, bbox, date, width, height, polarization = 'DV' }) {
  const key = consensusCacheKey('s1', ring, date, width, height, polarization);
  const hit = consensusCacheGet(key);
  if (hit) return hit;
  const v = await fetchRvi({ ring, bbox, date, width, height, polarization });
  consensusCacheSet(key, v);
  return v;
}
// Mejor esfuerzo: RVI cercano a la fecha óptica (nunca revienta la petición principal).
async function rviNearOptical({ ring, bbox, date, width, height, polarization = 'DV' }) {
  try {
    const near = await findRadarDateNear(bbox, date);
    if (!near) return null;
    const res = await cachedRvi({ ring, bbox, date: near.date, width, height, polarization });
    return { rvi: res.rvi, date: near.date };
  } catch (e) { return null; }
}
// Mejor esfuerzo: NDVI cercano a la fecha radar (nunca revienta la petición principal).
async function opticalNearRadar({ ring, bbox, date, width, height, snowMonths = null }) {
  try {
    const near = await findNearestOpticalDate(bbox, date, 30);
    if (!near) return null;
    const res = await cachedOptical({ ring, bbox, date: near, width, height, snowMonths });
    return { ndvi: res.ndvi, cloud: res.cloud, date: near };
  } catch (e) { return null; }
}
// Clasifica con la banda primaria pero degrada "Bosque" a "Vegetación densa (no boscosa)"
// cuando el sensor secundario TIENE dato pero no alcanza su propio umbral de bosque (regla
// estricta AND). Si el secundario NO tiene dato para el píxel (nieve, nube, fuera de escena),
// el primario no se degrada: sin evidencia en contra, se respeta la lectura del primario.
function consensusClassify(primaryVals, secondaryVals, mask, primaryClasses, secondaryClasses) {
  if (!secondaryVals) return classifyMasked(primaryVals, mask, primaryClasses);
  const n = primaryClasses.length;
  const out = new Uint8Array(primaryVals.length).fill(255);
  const pForest = primaryClasses.map((c, i) => c.forest ? i : -1).filter(i => i >= 0);
  const sForest = secondaryClasses.map((c, i) => c.forest ? i : -1).filter(i => i >= 0);
  const demoteTo = primaryClasses.findIndex(c => c.forest) - 1;
  for (let k = 0; k < mask.length; k++) {
    const p = mask[k];
    const v = primaryVals[p];
    if (v === undefined || v === null || Number.isNaN(v)) continue;
    let i = -1;
    for (let c = 0; c < n; c++) {
      if (v >= primaryClasses[c].from && v < primaryClasses[c].to) { i = c; break; }
    }
    if (i < 0) continue;
    if (pForest.includes(i)) {
      const sv = secondaryVals[p];
      if (sv !== undefined && sv !== null && !Number.isNaN(sv)) {
        let j = -1;
        for (let c = 0; c < secondaryClasses.length; c++) {
          if (sv >= secondaryClasses[c].from && sv < secondaryClasses[c].to) { j = c; break; }
        }
        if (j < 0 || !sForest.includes(j)) i = demoteTo;
      }
    }
    out[p] = i;
  }
  return out;
}
// Conteo de áreas directamente desde un raster de clases (resultado del consenso).
function classAreasFromRaster(cls, mask, classes, areaPerPx) {
  const cnt = new Array(classes.length).fill(0);
  for (let k = 0; k < mask.length; k++) {
    const i = cls[mask[k]];
    if (i >= 0 && i < classes.length) cnt[i]++;
  }
  const areas = classes.map((c, i) => ({ ...c, pixels: cnt[i], areaHa: 0, pct: 0 }));
  let total = 0;
  for (const c of areas) total += c.pixels;
  for (const c of areas) {
    c.areaHa = (c.pixels * areaPerPx) / 10000;
    c.pct = total ? (c.pixels / total) * 100 : 0;
    delete c.from; delete c.to;
  }
  return { classes: areas, totalPixels: total, areaHa: (total * areaPerPx) / 10000 };
}

// Backscatter VV/VH en dB (para el reporte) — misma escena
const DB_EVAL = `//VERSION=3
function setup() {
  return {
    input: [{ bands: ["VV","VH"], units: "LINEAR_POWER" }],
    output: [{ id: "db", bands: 2, sampleType: "FLOAT32" }]
  };
}
function evaluatePixel(sample) {
  var vv = sample.VV; var vh = sample.VH;
  if (vv === undefined || vh === undefined || !isFinite(vv) || !isFinite(vh) || vv <= 0 || vh <= 0) return { db: [NaN, NaN] };
  return { db: [10 * Math.log10(vv), 10 * Math.log10(vh)] };
}`;
async function fetchBackscatterDb({ ring, bbox, date, width, height, polarization = 'DV' }) {
  const payload = {
    input: {
      bounds: { geometry: { type: 'Polygon', coordinates: [ring] } },
      data: [{
        type: 'sentinel-1-grd',
        dataFilter: { timeRange: { from: `${date}T00:00:00Z`, to: `${date}T23:59:59Z` }, polarization, instrumentMode: 'IW' },
        processing: { mosaicking: 'ORBIT' }
      }]
    },
    output: { width, height, responses: [{ identifier: 'db', format: { type: 'image/tiff' } }] },
    evalscript: DB_EVAL
  };
  const buf = await shFetch(payload);
  const { bands } = await parseTiff(buf);
  if (bands.length < 2) throw new Error('Respuesta radar incompleta (bands=' + bands.length + ')');
  return { vv: bands[0].values, vh: bands[1].values, width, height };
}

// ============================================================
// ESTADÍSTICAS
// ============================================================
function statsOf(values, idx) {
  let sum = 0, n = 0;
  for (let k = 0; k < idx.length; k++) {
    const v = values[idx[k]];
    if (v === undefined || v === null || Number.isNaN(v)) continue;
    sum += v; n++;
  }
  return { mean: n ? sum / n : null, n };
}
function cloudPctOf(values, idx) {
  let nCloud = 0, nClear = 0;
  for (let k = 0; k < idx.length; k++) {
    const v = values[idx[k]];
    if (v === undefined || v === null || Number.isNaN(v)) continue;
    if (v === 1) nCloud++; else nClear++;
  }
  const total = nCloud + nClear;
  return total ? { cloudPct: (nCloud / total) * 100, validPixels: total } : { cloudPct: null, validPixels: 0 };
}
function histogramOf(values, idx, buckets = 60) {
  const counts = new Array(buckets).fill(0);
  let total = 0;
  for (let k = 0; k < idx.length; k++) {
    const v = values[idx[k]];
    if (v === undefined || v === null || Number.isNaN(v)) continue;
    let b = Math.floor(v * buckets);
    if (b >= buckets) b = buckets - 1;
    if (b < 0) b = 0;
    counts[b]++; total++;
  }
  return { counts, buckets, total };
}
function otsuFromHist(counts, total) {
  let sum = 0;
  for (let i = 0; i < counts.length; i++) sum += i * counts[i];
  let sumB = 0, wB = 0, maxVar = -1, threshold = -1;
  for (let i = 0; i < counts.length; i++) {
    wB += counts[i];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += i * counts[i];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > maxVar) { maxVar = between; threshold = i; }
  }
  return threshold === -1 ? null : (threshold + 0.5) / counts.length;
}
function classAreas(values, idx, classes, areaPerPx) {
  const areas = classes.map(c => ({ ...c, pixels: 0, areaHa: 0, pct: 0 }));
  for (let k = 0; k < idx.length; k++) {
    const v = values[idx[k]];
    if (v === undefined || v === null || Number.isNaN(v)) continue;
    for (const c of areas) {
      if (v >= c.from && v < c.to) { c.pixels++; break; }
    }
  }
  let total = 0;
  for (const c of areas) total += c.pixels;
  for (const c of areas) {
    c.areaHa = (c.pixels * areaPerPx) / 10000;
    c.pct = total ? (c.pixels / total) * 100 : 0;
    delete c.from; delete c.to;
  }
  return { classes: areas, totalPixels: total, areaHa: (total * areaPerPx) / 10000 };
}

// ============================================================
// COLORES / PNG
// ============================================================
function toPng(values, width, height, colorFn, idx) {
  const png = new PNG({ width, height });
  for (let p = 0; p < width * height; p++) {
    const v = values[p];
    let r, g, b;
    if (v === undefined || v === null || Number.isNaN(v)) { r = 0; g = 0; b = 0; }
    else { [r, g, b] = colorFn(v); }
    const o = p * 4;
    png.data[o] = r; png.data[o + 1] = g; png.data[o + 2] = b; png.data[o + 3] = 255;
  }
  return 'data:image/png;base64,' + PNG.sync.write(png).toString('base64');
}
const colorNdvi = (v) => {
  if (v < 0.55) return [37, 99, 235];        // agua / sin vegetación
  if (v < 0.68) return [194, 178, 128];      // suelo desnudo
  if (v < 0.75) return [227, 198, 26];       // escasa
  if (v < 0.8) return [47, 158, 68];         // moderada
  if (v < 0.85) return [22, 101, 52];        // vegetación densa (no boscosa)
  return [5, 46, 22];                        // bosque
};
const colorRvi = (v) => {
  if (v < 0.15) return [37, 99, 235];
  if (v < 0.3) return [194, 178, 128];
  if (v < 0.5) return [227, 198, 26];
  if (v < 0.6) return [47, 158, 68];
  if (v < 0.7) return [22, 101, 52];
  return [5, 46, 22];
};
const colorDiff = (v) => {
  const t = Math.max(-1, Math.min(1, v));
  if (t < 0) return [220, 38, 38];           // disminución
  if (t > 0) return [22, 163, 74];           // aumento
  return [245, 245, 245];
};

// ============================================================
// CLASES POR DEFECTO
// ============================================================
const OPTICAL_CLASSES = [
  { id: 'water', label: 'Agua / sin vegetación', from: -Infinity, to: 0.55, color: '#2563eb' },
  { id: 'barren', label: 'Suelo desnudo', from: 0.55, to: 0.68, color: '#c2b280' },
  { id: 'sparse', label: 'Vegetación escasa', from: 0.68, to: 0.75, color: '#e3c61a' },
  { id: 'moderate', label: 'Vegetación moderada', from: 0.75, to: 0.8, color: '#2f9e44' },
  { id: 'vegdense', label: 'Vegetación densa (no boscosa)', from: 0.8, to: 0.85, color: '#166534' },
  { id: 'forest', label: 'Bosque', from: 0.85, to: Infinity, color: '#052e16', forest: true }
];
const RVI_CLASSES = [
  { id: 'water', label: 'Agua / sin vegetación', from: -Infinity, to: 0.15, color: '#2563eb' },
  { id: 'bare', label: 'Suelo desnudo', from: 0.15, to: 0.3, color: '#c2b280' },
  { id: 'grass', label: 'Vegetación escasa', from: 0.3, to: 0.5, color: '#e3c61a' },
  { id: 'shrub', label: 'Vegetación moderada', from: 0.5, to: 0.6, color: '#2f9e44' },
  { id: 'vegdense', label: 'Vegetación densa (no boscosa)', from: 0.6, to: 0.7, color: '#166534' },
  { id: 'forest', label: 'Bosque', from: 0.7, to: Infinity, color: '#052e16', forest: true }
];

// ============================================================
// ESTIMACIÓN DE VOLUMEN (ha cosechadas × vol_ha)
// Tabla de rendimiento POR DEFECTO, referencial INFOR (IT220, 2018),
// recalibrable con los datos reales del cliente (Solicitud-cliente).
// ============================================================
// MAI (m³/ha/año) a la edad de rotación según clase de sitio. Valores tipo del
// estudio INFOR IT220: pino radiata ~23-28 en zonas 4/6/7 (macrorregión II),
// E. globulus ~19-26 con corrección a la baja de 20-30% por Gonipterus/sequía,
// E. nitens ~34 (sus zonas principales son 4, 6, 7 y 9). La forma de la curva de
// volumen en pie es Chapman-Richards (k, m), calibrada para que el IMA a la edad
// de rotación sea exactamente el MAI del sitio.
const YIELD_CFG = {
  pinus:    { rot: 24, k: 0.08, m: 2.5, alto: 30, medio: 24, bajo: 16 },
  globulus: { rot: 12, k: 0.22, m: 2.5, alto: 26, medio: 19, bajo: 12 },
  nitens:   { rot: 14, k: 0.14, m: 2.2, alto: 38, medio: 33, bajo: 24 }
};
const YIELD_MIN_AGE = 5, YIELD_MAX_AGE = 30;
const VALID_SPECIES = ['pinus', 'globulus', 'nitens'];
const VALID_SITES = ['alto', 'medio', 'bajo'];
const SPECIES_LABELS = { pinus: 'Pino radiata', globulus: 'Eucalyptus globulus', nitens: 'Eucalyptus nitens' };

// Genera la tabla de vol_ha (m³/ha por especie, sitio y edad) con la curva de
// Chapman-Richards calibrada para que el IMA a la rotación sea el MAI del sitio.
function buildYieldTable(cfg) {
  const out = {};
  for (const [sp, c] of Object.entries(cfg)) {
    out[sp] = {};
    for (const site of VALID_SITES) {
      const denom = Math.pow(1 - Math.exp(-c.k * c.rot), c.m);
      out[sp][site] = {};
      for (let a = YIELD_MIN_AGE; a <= YIELD_MAX_AGE; a++) {
        out[sp][site][a] = Math.round((c[site] * c.rot) * Math.pow(1 - Math.exp(-c.k * a), c.m) / denom);
      }
    }
  }
  return out;
}

// Tabla de rendimiento EDITABLE: si existe rendimiento_volumen.csv (columnas
// especie,sitio,edad,vol_ha; una fila por edad) se carga y tiene prioridad sobre la
// tabla por defecto. Eliminando el CSV se vuelve a la curva YIELD_CFG (INFOR IT220).
// Ubicación: se prefiere la carpeta del Frontend (más accesible para el cliente);
// si no existe, la del Backend; y RENDIMIENTO_CSV con un path explícito gana siempre.
function yieldCsvPath() {
  if (process.env.RENDIMIENTO_CSV) return process.env.RENDIMIENTO_CSV;
  const front = path.join(__dirname, '..', 'Frontend', 'data', 'rendimiento_volumen.csv');
  return fs.existsSync(front) ? front : path.join(__dirname, 'data', 'rendimiento_volumen.csv');
}
function loadYieldTable() {
  const csvPath = yieldCsvPath();
  try {
    const rows = {};
    for (const raw of fs.readFileSync(csvPath, 'utf8').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const [esp, sitio, edad, vol] = line.split(',').map(s => s.trim());
      if (!VALID_SPECIES.includes(esp) || !VALID_SITES.includes(sitio)) continue;
      const a = parseInt(edad, 10), v = parseFloat(vol);
      if (!Number.isFinite(a) || !Number.isFinite(v)) continue;
      if (a < YIELD_MIN_AGE || a > YIELD_MAX_AGE) continue;
      (rows[esp] = rows[esp] || {})[sitio] = rows[esp][sitio] || {};
      rows[esp][sitio][a] = Math.round(v);
    }
    const complete = VALID_SPECIES.every(sp => VALID_SITES.every(site => rows[sp] && rows[sp][site]));
    if (complete) {
      console.log('[volumen] tabla de rendimiento cargada desde ' + csvPath);
      return rows;
    }
    console.warn('[volumen] CSV incompleto (' + csvPath + '); se usa la tabla por defecto');
  } catch (e) {
    console.warn('[volumen] sin CSV de rendimiento; se usa la tabla por defecto (' + e.message + ')');
  }
  return buildYieldTable(YIELD_CFG);
}
const YIELD_TABLE = loadYieldTable();
let _yieldTable = null, _yieldMtime = -1;
// Relee el CSV en cada llamada si cambió (mtime): editar el CSV
// se aplica en la siguiente petición, sin reiniciar el servidor.
function yieldTable() {
  const csvPath = yieldCsvPath();
  try {
    const st = fs.statSync(csvPath);
    if (st.mtimeMs !== _yieldMtime) {
      _yieldTable = loadYieldTable();
      _yieldMtime = st.mtimeMs;
    }
  } catch (e) {
    if (!_yieldTable) _yieldTable = buildYieldTable(YIELD_CFG);
  }
  return _yieldTable;
}
function volHaOf(speciesId, siteId, age) {
  const sp = yieldTable()[speciesId];
  const st = sp && sp[siteId];
  if (!st) return null;
  const a = Math.round(Number(age));
  if (!Number.isFinite(a) || a < YIELD_MIN_AGE || a > YIELD_MAX_AGE) return null;
  return { age: a, volHa: st[a] };
}
// Metadatos de la tabla en uso, para /warmup (verificar deploy del backend).
function yieldMeta() {
  const t = yieldTable();
  let filas = 0;
  for (const sp of Object.values(t)) for (const st of Object.values(sp)) filas += Object.keys(st).length;
  return { archivo: yieldCsvPath(), filas, csv: 'Frontend\\data\\rendimiento_volumen.csv (preferido) o Backend\\data\\rendimiento_volumen.csv' };
}

// ============================================================
// V5 — RENDIMIENTO POR COMUNA EN METROS RUMA (MR)
// Fórmula: MR = edad (años) × factor_MR(comuna, especie) × superficie (ha).
// Tabla: rendimiento_ruma.csv (NOM_COMUNA;PINO_MR;EGG_MR;EN_MR), editable en caliente.
// Comuna: se infiere desde las coordenadas del polígono con comunas_chile.geojson,
// o se pasa manualmente en req.body.comuna.
// ============================================================
function normComunaName(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toUpperCase().replace(/[-–—]/g, ' ').replace(/\s+/g, ' ').trim();
}
function rumaCsvPath() {
  if (process.env.RENDIMIENTO_RUMA_CSV) return process.env.RENDIMIENTO_RUMA_CSV;
  const front = path.join(__dirname, '..', 'Frontend', 'data', 'rendimiento_ruma.csv');
  return fs.existsSync(front) ? front : path.join(__dirname, 'data', 'rendimiento_ruma.csv');
}
let _rumaTable = null, _rumaMtime = -1;
function loadRumaTable() {
  const csvPath = rumaCsvPath();
  const out = {};
  try {
    for (const raw of fs.readFileSync(csvPath, 'utf8').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const cols = line.split(';').map(s => s.trim());
      if (cols.length < 4) continue;
      const key = normComunaName(cols[0]);
      const p = parseFloat(cols[1]), g = parseFloat(cols[2]), n = parseFloat(cols[3]);
      if (!key || !Number.isFinite(p) || !Number.isFinite(g) || !Number.isFinite(n)) continue;
      out[key] = { comuna: cols[0].toUpperCase(), pino: p, globulus: g, nitens: n };
    }
    console.log('[ruma] tabla MR por comuna cargada: ' + Object.keys(out).length + ' comunas desde ' + csvPath);
  } catch (e) {
    console.warn('[ruma] sin CSV de rendimiento MR (' + e.message + ')');
  }
  return out;
}
function rumaTable() {
  const csvPath = rumaCsvPath();
  try {
    const st = fs.statSync(csvPath);
    if (st.mtimeMs !== _rumaMtime) { _rumaTable = loadRumaTable(); _rumaMtime = st.mtimeMs; }
  } catch (e) {
    if (!_rumaTable) { _rumaTable = loadRumaTable(); _rumaMtime = -1; }
  }
  return _rumaTable || {};
}
function rumaComunaList() {
  return Object.values(rumaTable()).map(r => r.comuna).sort((a, b) => a.localeCompare(b, 'es'));
}
// Índice de comunas desde GeoJSON (346 comunas de Chile).
function comunasGeoPath() {
  if (process.env.COMUNAS_GEOJSON) return process.env.COMUNAS_GEOJSON;
  return path.join(__dirname, 'data', 'comunas_chile.geojson');
}
let COMUNAS_INDEX = null;
function loadComunasIndex() {
  const p = comunasGeoPath();
  try {
    const gj = JSON.parse(fs.readFileSync(p, 'utf8'));
    const index = [];
    for (const f of (gj.features || [])) {
      const name = (f.properties && (f.properties.Comuna || f.properties.comuna || f.properties.NOMBRE)) || '';
      const key = normComunaName(name);
      if (!key) continue;
      const geom = f.geometry || {};
      const polys = geom.type === 'Polygon' ? [geom.coordinates]
        : geom.type === 'MultiPolygon' ? geom.coordinates : [];
      if (!polys.length) continue;
      index.push({ key, name, region: (f.properties && f.properties.Region) || null, polys });
    }
    console.log('[comunas] índice cargado: ' + index.length + ' comunas desde ' + p);
    return index;
  } catch (e) {
    console.warn('[comunas] sin GeoJSON de comunas (' + e.message + '); la comuna se resolverá manual.');
    return [];
  }
}
function pointInPolys(lon, lat, polys) {
  let inside = false;
  for (const poly of polys) {
    for (const ring of poly) {
      let c = false;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
        if (((yi > lat) !== (yj > lat)) && (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi)) c = !c;
      }
      if (c) inside = !inside;
    }
  }
  return inside;
}
function comunaAt(lon, lat) {
  if (!COMUNAS_INDEX || !COMUNAS_INDEX.length) return null;
  for (const fe of COMUNAS_INDEX) if (pointInPolys(lon, lat, fe.polys)) return fe;
  return null;
}
function polygonCentroid(ring) {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const p = ring[i], q = ring[i + 1];
    const cr = p[0] * q[1] - q[0] * p[1];
    a += cr; cx += (p[0] + q[0]) * cr; cy += (p[1] + q[1]) * cr;
  }
  a /= 2;
  if (!a || !Number.isFinite(a)) return { lon: ring[0][0], lat: ring[0][1] };
  return { lon: cx / (6 * a), lat: cy / (6 * a) };
}
function comunaOfRing(ring, bbox) {
  if (!COMUNAS_INDEX || !COMUNAS_INDEX.length) return null;
  const c = polygonCentroid(ring);
  let hit = comunaAt(c.lon, c.lat);
  if (hit) return hit;
  const votes = {};
  const N = 6;
  for (let i = 0; i <= N; i++) {
    for (let j = 0; j <= N; j++) {
      const lon = bbox[0] + (bbox[2] - bbox[0]) * i / N;
      const lat = bbox[1] + (bbox[3] - bbox[1]) * j / N;
      if (!pointInPolys(lon, lat, [ring])) continue;
      const h = comunaAt(lon, lat);
      if (h) votes[h.key] = (votes[h.key] || 0) + 1;
    }
  }
  let bestKey = null, bestN = 0;
  for (const k in votes) if (votes[k] > bestN) { bestN = votes[k]; bestKey = k; }
  return bestKey ? (COMUNAS_INDEX.find(x => x.key === bestKey) || null) : null;
}
COMUNAS_INDEX = loadComunasIndex();

// Detección heurística de especie sobre los píxeles clasificados como bosque en la
// escena "antes". El eucalipto de copa cerrada muestra NDVI medio alto y poca
// dispersión; el pino radiata presenta NDVI algo menor y mayor variabilidad (dosel
// más abierto con sotobosque). Es una clasificación referencial: el usuario puede
// corregirla manualmente. No distingue globulus de nitens (espectro similar).
function detectSpecies(ndvi, mask) {
  if (!ndvi || !mask) return { group: 'unknown', label: 'Sin escena óptica de referencia', confidence: 0 };
  const vals = [];
  for (let k = 0; k < mask.length; k++) {
    const p = mask[k];
    const v = ndvi[p];
    if (v === undefined || v === null || Number.isNaN(v) || v < 0.80) continue;
    vals.push(v);
  }
  const n = vals.length;
  if (n < 50) return { group: 'unknown', label: 'Sin píxeles de bosque suficientes', confidence: 0 };
  const mean = vals.reduce((s, v) => s + v, 0) / n;
  const sd = Math.sqrt(vals.reduce((s, v) => s + (v - mean) * (v - mean), 0) / n);
  const cv = sd / mean;
  if (mean >= 0.88 && cv <= 0.10) return { group: 'eucalipto', label: 'Eucalyptus (copas cerradas)', confidence: 0.8 };
  if (mean >= 0.85 && cv <= 0.14) return { group: 'eucalipto', label: 'Eucalyptus (probable)', confidence: 0.6 };
  if (mean >= 0.80) return { group: 'pino', label: 'Pino radiata (probable)', confidence: 0.6 };
  return { group: 'pino', label: 'Pino radiata', confidence: 0.5 };
}

// Clase de sitio inferida por coordenadas (heurística por latitud; referencial y
// editable en el formulario). El mapa fino por comuna/zona de crecimiento se puede
// calibrar después con los propios sitios/índices de sitio de las geocercas del cliente.
function inferSiteClass(lat) {
  if (lat < -37.5) return { id: 'alto', label: 'Alto', inferred: true, note: 'inferida: sur (Araucanía sur / Los Ríos)' };
  if (lat > -34.8) return { id: 'bajo', label: 'Bajo', inferred: true, note: 'inferida: norte (Valparaíso / RM / O\'Higgins norte)' };
  return { id: 'medio', label: 'Medio', inferred: true, note: 'inferida: centro (Maule / Biobío / Araucanía norte)' };
}

// Construye el bloque "volumen" para cualquier análisis que entregue ha de bosque
// perdido (cosecha): detección de especie + clase de sitio + m³ estimados.
function computeVolumeInfo(reqBody, ndviBefore, mask, bbox, lostHa, date2) {
  const speciesIn = String(reqBody.especie || '').trim().toLowerCase();
  const siteIn = String(reqBody.sitio || 'auto').trim().toLowerCase();
  const ageIn = (reqBody.edad !== undefined && reqBody.edad !== null && reqBody.edad !== '') ? Number(reqBody.edad) : NaN;
  const anioIn = (reqBody.anioPlantacion !== undefined && reqBody.anioPlantacion !== null && reqBody.anioPlantacion !== '') ? Number(reqBody.anioPlantacion) : NaN;
  const detected = detectSpecies(ndviBefore, mask);
  const speciesSel = VALID_SPECIES.includes(speciesIn)
    ? speciesIn
    : (detected.group === 'eucalipto' ? 'globulus' : (detected.group === 'pino' ? 'pinus' : null));
  const siteSel = VALID_SITES.includes(siteIn)
    ? { id: siteIn, label: siteIn[0].toUpperCase() + siteIn.slice(1), inferred: false, note: 'seleccionado manualmente' }
    : inferSiteClass(bbox[1] + (bbox[3] - bbox[1]) / 2);
  const edad = !Number.isNaN(ageIn) ? ageIn : (!Number.isNaN(anioIn) ? (new Date(date2).getFullYear() - anioIn) : NaN);
  const estimado = (!Number.isNaN(edad) && speciesSel && lostHa !== null)
    ? (() => { const v = volHaOf(speciesSel, siteSel.id, edad); return v ? {
          especie: speciesSel, especieLabel: SPECIES_LABELS[speciesSel],
          edad: v.age, volHa: v.volHa, haCosechadas: lostHa, m3: Math.round(lostHa * v.volHa),
          sitio: siteSel.id, sitioLabel: siteSel.label,
          fuente: 'INFOR 2018 (IT220) · valores referenciales'
        } : null; })()
    : null;
  return {
    haCosechadas: lostHa,
    especie: { deteccion: detected, seleccion: speciesSel, pista: 'Detección heurística sobre los píxeles de bosque de la escena "antes" (NDVI medio y dispersión); corregible por el usuario. En "Auto": pino → Pino radiata; eucalipto → E. globulus (si es E. nitens, selecciónala manualmente).' },
    sitio: siteSel,
    edad: !Number.isNaN(edad) ? edad : null,
    estimado
  };
}

// ============================================================
// COSECHA NETA (antes − desp) Y SU DESCOMPOSICIÓN POR ESPECIE (V4)
// ============================================================
// La "cosecha" se define como el Δ neto de bosque entre las dos fechas sobre la
// clasificación CONSENSO dual (Bosque = NDVI≥0.85 Y RVI≥0.70): cosecha = antes −
// desp = perdido bruto − ganado bruto. Como el consenso es el MISMO en las dos
// pestañas (NDVI y RVI comparten la máscara de bosque), el número de cosecha es
// idéntico en ambas (esto elimina la divergencia que causaba el "corte claro por
// sensor"). La descomposición por especie se hace sobre los píxeles que realmente
// salieron de bosque ("perdido" bruto) y su mix se aplica a la superficie neta:
// ha_esp = netoHa × pct_esp (Opción A).
// Clasificación de especie por píxel desde el NDVI de la escena "antes" (heurística,
// misma base que detectSpecies): eucalipto de copa cerrada → NDVI alto; pino → NDVI
// algo menor. Solo separa Eucalipto/Pino/Otra; el E. globulus vs E. nitens no se
// distingue por espectro (se asigna globulus y el usuario puede corregir).
function speciesOfPixel(ndviVal) {
  if (ndviVal === undefined || ndviVal === null || Number.isNaN(ndviVal)) return null;
  if (ndviVal >= 0.88) return { group: 'eucalipto', species: 'globulus', label: 'Eucalyptus (copas cerradas)' };
  if (ndviVal >= 0.85) return { group: 'pino', species: 'pinus', label: 'Pino radiata (probable)' };
  return { group: 'otra', species: null, label: 'Mezcla / borde' };
}
function computeCosechaInfo(reqBody, ndviBefore, c1, c2, mask, classes, areaPx, forest, bbox, date2) {
  const f = classes.findIndex(c => c.forest);
  const groups = {
    eucalipto: { species: 'globulus', label: 'Eucalyptus (copas cerradas)', px: 0 },
    pino:      { species: 'pinus',    label: 'Pino radiata',                  px: 0 },
    otra:      { species: null,       label: 'Mezcla / borde',                px: 0 }
  };
  let lostPx = 0;
  if (f >= 0) {
    for (let k = 0; k < mask.length; k++) {
      const p = mask[k];
      if (c1[p] === f && c2[p] !== f && c2[p] !== 255) {
        lostPx++;
        const g = speciesOfPixel(ndviBefore && ndviBefore[p]);
        groups[g ? g.group : 'otra'].px++;
      }
    }
  }
  // ---- V5 (Metros Ruma): solo Edad; comuna automática o manual; override por grupo. ----
  const speciesIn = String(reqBody.especie || '').trim().toLowerCase();
  const ageIn = (reqBody.edad !== undefined && reqBody.edad !== null && reqBody.edad !== '') ? Number(reqBody.edad) : NaN;
  const overrideIn = (reqBody.especieOverride && typeof reqBody.especieOverride === 'object') ? reqBody.especieOverride : {};
  const manual = VALID_SPECIES.includes(speciesIn) ? speciesIn : null;
  const edad = !Number.isNaN(ageIn) ? ageIn : NaN;
  // Comuna: manual si viene req.body.comuna; si no, inferida desde el polígono (GeoJSON).
  const ruma = rumaTable();
  let comunaRow = null, comuna = null;
  const comunaInput = String(reqBody.comuna || '').trim();
  if (comunaInput) {
    const key = normComunaName(comunaInput);
    comunaRow = ruma[key] || null;
    comuna = {
      id: key,
      label: comunaRow ? comunaRow.comuna : comunaInput,
      inferred: false,
      note: 'seleccionada manualmente' + (comunaRow ? '' : ' — no está en la tabla MR')
    };
  } else {
    const ringIn = toRing(reqBody.coordinates || []);
    const geo = (ringIn && ringIn.length) ? comunaOfRing(ringIn, bbox) : null;
    if (geo) {
      const key = normComunaName(geo.name);
      comunaRow = ruma[key] || null;
      comuna = {
        id: key,
        label: comunaRow ? comunaRow.comuna : geo.name,
        inferred: true,
        note: comunaRow ? 'inferida desde las coordenadas del polígono' : 'comuna no está en la tabla MR'
      };
    }
  }
  // Superficies de bosque y cosecha neta (antes − desp) derivadas del objeto `forest`
  // (comp.forest de compareCategories): perdido/ganado brutos en ha; neto = perdido −
  // ganado; antes/después vienen de ha1/ha2 (si faltan, se derivan del neto).
  const perdidoHa = (forest && typeof forest.lost === 'number') ? forest.lost : 0;
  const ganadoHa = (forest && typeof forest.gained === 'number') ? forest.gained : 0;
  const netoHa = perdidoHa - ganadoHa;
  const antesHa = (forest && typeof forest.ha1 === 'number') ? forest.ha1 : Math.max(0, perdidoHa);
  const despuesHa = (forest && typeof forest.ha2 === 'number') ? forest.ha2 : Math.max(0, antesHa - netoHa);
  const neto = (Number.isFinite(netoHa) && netoHa > 0) ? netoHa : 0;
  // Descomposición por especie y volumen (MR) por fila.
  const porEspecie = [];
  let totalMR = 0;
  if (!Number.isNaN(edad) && neto > 0 && comunaRow) {
    const speciesOfGroup = group => {
      const ov = overrideIn[group];
      return VALID_SPECIES.includes(ov) ? ov : (groups[group].species || null);
    };
    const MR_COL = { pinus: 'pino', globulus: 'globulus', nitens: 'nitens' };
    const factorOf = sp => comunaRow ? comunaRow[MR_COL[sp]] : null; // comunaRow: {pino, globulus, nitens}
    const addRowMR = (species, group, ha) => {
      const factor = factorOf(species);
      if (!Number.isFinite(factor)) return;
      const mr = Math.round(edad * factor * ha);
      totalMR += mr;
      porEspecie.push({
        especie: species, group,
        label: SPECIES_LABELS[species],
        ha: Math.round(ha * 100) / 100,
        pct: Math.round((ha / neto) * 1000) / 10,
        factorMR: factor, mr
      });
    };
    if (manual) {
      addRowMR(manual, null, neto);
    } else if (lostPx > 0) {
      for (const g of [groups.eucalipto, groups.pino]) {
        const grp = g === groups.eucalipto ? 'eucalipto' : 'pino';
        if (g.px > 0) addRowMR(speciesOfGroup(grp), grp, neto * g.px / lostPx);
      }
      if (groups.otra.px > 0) {
        porEspecie.push({
          especie: null, group: 'otra', label: groups.otra.label,
          ha: Math.round((neto * groups.otra.px / lostPx) * 100) / 100,
          pct: Math.round((groups.otra.px / lostPx) * 1000) / 10,
          factorMR: null, mr: null
        });
      }
    } else if (perdidoHa > 0) {
      addRowMR(manual || 'pinus', null, neto);
    }
  }
  const eucPct = lostPx ? Math.round((groups.eucalipto.px / lostPx) * 1000) / 10 : 0;
  const pinPct = lostPx ? Math.round((groups.pino.px / lostPx) * 1000) / 10 : 0;
  const otPct  = lostPx ? Math.round((groups.otra.px / lostPx) * 1000) / 10 : 0;
  const conf = lostPx ? Math.round((Math.max(groups.eucalipto.px, groups.pino.px) / lostPx) * 100) : 0;
  return {
    cosechaHa: Math.round(neto * 100) / 100,
    antesHa: Math.round(antesHa * 100) / 100,
    despuesHa: Math.round(despuesHa * 100) / 100,
    perdidoHa: Math.round(perdidoHa * 100) / 100,
    ganadoHa: Math.round(ganadoHa * 100) / 100,
    netoHa: Math.round(netoHa * 100) / 100,
    mixPerdido: { eucalipto: eucPct, pino: pinPct, otra: otPct, pixels: lostPx },
    porEspecie,
    totalMR,
    comuna,
    especie: {
      manual: !!manual,
      seleccion: manual,
      deteccion: {
        label: lostPx ? 'Mezcla por píxel según NDVI de la escena "antes" (Eucalipto ≥ 0.88 / Pino 0.85–0.88)' : 'Sin píxeles perdidos',
        confidence: lostPx ? conf : 0,
        pista: 'La descomposición por especie se hizo sobre los píxeles que salieron de bosque (perdido bruto) y se aplicó al neto (cosecha = antes − desp). La detección separa Eucalipto/Pino desde NDVI de 10 m; puedes ajustar qué especie asignar a cada grupo en el paso "Ajustar especies".'
      }
    },
    edad: !Number.isNaN(edad) ? edad : null,
    fuente: 'Tabla de rendimiento por comuna y especie (Metros Ruma, MR) — datos del cliente'
  };
  // ============================================================
  // (CONSERVADO COMENTADO) Cálculo ANTERIOR en m³ por sitio/edad (INFOR 2018):
  //   const siteIn = String(reqBody.sitio || 'auto').trim().toLowerCase();
  //   const anioIn = (reqBody.anioPlantacion !== undefined && reqBody.anioPlantacion !== null && reqBody.anioPlantacion !== '') ? Number(reqBody.anioPlantacion) : NaN;
  //   const siteSel = VALID_SITES.includes(siteIn)
  //     ? { id: siteIn, label: siteIn[0].toUpperCase() + siteIn.slice(1), inferred: false, note: 'seleccionado manualmente' }
  //     : inferSiteClass(bbox[1] + (bbox[3] - bbox[1]) / 2);
  //   const edadM3 = !Number.isNaN(ageIn) ? ageIn : (!Number.isNaN(anioIn) ? (new Date(date2).getFullYear() - anioIn) : NaN);
  //   let totalM3 = 0;
  //   if (!Number.isNaN(edadM3) && neto > 0) {
  //     const addRow = (species, label, ha) => {
  //       const v = volHaOf(species, siteSel.id, edadM3);
  //       if (!v) return;
  //       const m3 = Math.round(ha * v.volHa);
  //       totalM3 += m3;
  //       porEspecie.push({ especie: species, label, ha: Math.round(ha * 100) / 100,
  //         pct: Math.round((ha / neto) * 1000) / 10, volHa: v.volHa, edad: v.age, m3 });
  //     };
  //     if (manual) addRow(manual, SPECIES_LABELS[manual], neto);
  //     else if (lostPx > 0) {
  //       for (const g of [groups.eucalipto, groups.pino])
  //         if (g.px > 0 && g.species) addRow(g.species, g.label, neto * g.px / lostPx);
  //       if (groups.otra.px > 0) porEspecie.push({ especie: null, label: groups.otra.label,
  //         ha: Math.round((neto * groups.otra.px / lostPx) * 100) / 100,
  //         pct: Math.round((groups.otra.px / lostPx) * 1000) / 10, volHa: null, m3: null });
  //     } else if (perdidoHa > 0) addRow(manual || 'pinus', SPECIES_LABELS[manual || 'pinus'], neto);
  //   }
  //   // return { ... (V3/V4) ..., totalM3, sitio: siteSel, fuente: 'INFOR 2018 (IT220) · valores referenciales' };
  // ============================================================
}

// ============================================================
// RUTAS
// ============================================================
app.get('/', (req, res) => res.json({ name: 'ITP-EarthWatch API v2', status: 'ok' }));
app.get('/healthz', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));
// Calienta la instancia: despierta Render si estaba dormida y deja el token de Sentinel Hub
// en caché, para que la primera consulta del día no pague además la obtención del token.
app.get('/warmup', async (req, res) => {
  try {
    const fresh = !tokenCache.value || Date.now() >= tokenCache.expiresAt;
    await getToken();
    res.json({ ok: true, token: fresh ? 'refrescado' : 'en caché', time: new Date().toISOString(), truecolor: 'bands-tiff', volumen: yieldMeta() });
  } catch (e) {
    res.status(500).json({ ok: false, error: String((e && e.message) || e) });
  }
});
app.post('/api/prueba', (req, res) => res.json({ ok: true, received: Object.keys(req.body || {}) }));

function badParams(res, msg) { return res.status(400).json({ error: msg }); }

// 0) Lista de comunas disponibles en la tabla MR (para el selector manual).
app.post('/api/v2/comunas', (req, res) => {
  try {
    res.json({ comunas: rumaComunaList() });
  } catch (e) {
    res.status(500).json({ error: 'No se pudo leer la tabla de comunas: ' + e.message });
  }
});

// 1) Fechas disponibles (escena completa)
app.post('/api/v2/get-valid-dates', async (req, res) => {
  try {
    const ring = toRing(req.body.coordinates);
    const maxCloud = Number(req.body.maxCloudCoverage || 50);
    const daysBack = Number(req.body.daysBack || 365);
    const bbox = bboxOf(ring);
    if (!ring || !bbox) return badParams(res, 'Parámetro coordinates inválido.');
    const now = new Date();
    const start = new Date(); start.setDate(now.getDate() - daysBack);
    const params = {
      bbox,
      collections: ['sentinel-2-l2a'],
      datetime: `${start.toISOString().split('T')[0]}T00:00:00Z/${now.toISOString().split('T')[0]}T23:59:59Z`,
      limit: 100,
      filter: `eo:cloud_cover < ${maxCloud}`
    };
    // Pagina el catálogo (rel=next con body.next) para no truncar en 100 escenas:
    // cada fecha S2 genera ~4 escenas, así que 100 escenas ≈ solo 24 fechas. Con
    // paginación se obtienen TODAS las fechas del año.
    const seen = new Set();
    const dates = [];
    let data = await catalogSearch(params);
    for (let page = 0; page < 6 && data; page++) {
      for (const f of data.features || []) {
        const d = f.properties.datetime.split('T')[0];
        if (seen.has(d)) continue;
        seen.add(d);
        dates.push({ date: d, cloudCover: Math.round(f.properties['eo:cloud_cover'] * 10) / 10 });
      }
      const tok = catalogNext(data);
      if (!tok) break;
      data = await catalogSearch({ ...params, next: tok });
    }
    dates.sort((a, b) => new Date(b.date) - new Date(a.date));
    res.json({ hasCoverage: dates.length > 0, totalDates: dates.length, dates, areaHa: polygonAreaHa(ring) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 2) Cobertura de nubes SOBRE el polígono (SCL) para fechas dadas
app.post('/api/v2/cloud-polygon', async (req, res) => {
  try {
    const ring = toRing(req.body.coordinates);
    const dates = (req.body.dates || []).slice(0, 20);
    const size = Math.min(Number(req.body.size || 256), 512);
    const bbox = bboxOf(ring);
    if (!ring || !bbox) return badParams(res, 'Parámetro coordinates inválido.');
    const m = await meterEndpoints(req, res, ring);
    if (!m) return;
    const out = [];
    for (const d of dates) {
      try {
        // cachedOpticalHaze: reusa el raster óptico cacheado (15 min) y aplica la máscara
        // de calima además del SCL, para que la nubosidad "real" coincida con lo visible.
        const { ndvi, cloud } = await cachedOpticalHaze({ ring, bbox, date: d.date || d, width: size, height: size, snowMonths: snowMonthsOf(m) });
        const mask = maskIndices(size, size, bbox, ring);
        const cp = cloudPctOf(cloud, mask);
        out.push({ date: d.date || d, sceneCloud: d.cloudCover ?? null, polygonCloud: cp.cloudPct });
      } catch (e) {
        out.push({ date: d.date || d, sceneCloud: d.cloudCover ?? null, polygonCloud: null, error: e.message });
      }
    }
    const quota = await commitPolygon(req, res, m);
    res.json({ dates: out, quota });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 3) Imagen óptica (truecolor o NDVI) con opción de composite
app.post('/api/v2/image', async (req, res) => {
  try {
    const ring = toRing(req.body.coordinates);
    const date = req.body.date;
    const mode = req.body.mode || 'ndvi';
    const composite = Number(req.body.composite || 0);
    const bbox = bboxOf(ring);
    if (!ring || !bbox || !date) return badParams(res, 'Faltan coordinates o date.');
    const m = await meterEndpoints(req, res, ring);
    if (!m) return;
    const { width, height } = imageSize(bbox, 512);

    if (mode === 'truecolor') {
      let d = date;
      if (req.body.nearest) {
        d = await findNearestOpticalDate(bbox, date);
        if (!d) return badParams(res, 'No hay escena S2 cercana para el color real.');
      }
      const image = await fetchTrueColor({ ring, bbox, date: d, width, height });
      const quota = await commitPolygon(req, res, m);
      return res.json({ image, usedDate: d, bbox, width, height, mode, quota });
    }

    // ---- NDVI (con o sin composite server-side) ----
    if (!composite || composite <= 0) {
      const { ndvi, cloud } = await cachedOptical({ ring, bbox, date, width, height, snowMonths: snowMonthsOf(m) });
      const mask = maskIndices(width, height, bbox, ring);
      const cp = cloudPctOf(cloud, mask);
      const st = statsOf(ndvi, mask);
      const hist = histogramOf(ndvi, mask, 60);
      const otsu = otsuFromHist(hist.counts, hist.total);
      const areaPx = areaPerPixel(bbox, width, height);
      const cls = OPTICAL_CLASSES.map(c => ({ ...c }));
      const secondary = await rviNearOptical({ ring, bbox, date, width, height });
      const clsRaster = consensusClassify(ndvi, secondary && secondary.rvi, mask, cls, RVI_CLASSES);
      const areas = classAreasFromRaster(clsRaster, mask, cls, areaPx);
      const image = toPng(clsRaster, width, height, colorClass(cls), mask);
      const quota = await commitPolygon(req, res, m);
      return res.json({
        image, usedDate: date, bbox, width, height, mode: 'ndvi',
        stats: { mean: st.mean, otsu },
        histogram: hist, areaPerPixel: areaPx, cloudPct: cp.cloudPct, classes: areas.classes, areaHa: areas.areaHa,
        consensus: !!secondary, consensusSensorDate: secondary ? secondary.date : null,
        snow: { months: snowMonthsOf(m) || [], mask: useSnowForDate(date, snowMonthsOf(m)) },
        quota
      });
    }

    // ---- Composite: mediana de hasta 8 fechas despejadas alrededor de `date` ----
    const start = new Date(date); start.setDate(start.getDate() - composite);
    const end = new Date(date); end.setDate(end.getDate() + composite);
    const catalog = await catalogSearch({
      bbox,
      collections: ['sentinel-2-l2a'],
      datetime: `${start.toISOString().split('T')[0]}T00:00:00Z/${end.toISOString().split('T')[0]}T23:59:59Z`,
      limit: 50,
      filter: 'eo:cloud_cover < 40'
    });
    const seen = new Set(); const cands = [];
    for (const f of catalog.features) {
      const d = f.properties.datetime.split('T')[0];
      if (seen.has(d)) continue; seen.add(d);
      cands.push({ date: d, cloud: f.properties['eo:cloud_cover'], dist: Math.abs(new Date(d) - new Date(date)) });
    }
    cands.sort((a, b) => a.dist - b.dist);
    const picks = cands.slice(0, 8);
    if (picks.length === 0) return badParams(res, 'No hay adquisiciones despejadas en el rango del composite.');

    const stacks = [];
    const used = [];
    for (const p of picks) {
      try {
        const { ndvi, cloud } = await fetchOptical({ ring, bbox, date: p.date, width, height, snowMonths: snowMonthsOf(m) });
        const mask = maskIndices(width, height, bbox, ring);
        const cp = cloudPctOf(cloud, mask);
        stacks.push({ ndvi, mask, cloudPct: cp.cloudPct, date: p.date });
        used.push({ date: p.date, polygonCloud: cp.cloudPct, sceneCloud: p.cloud });
      } catch (e) { /* omitir fecha fallida */ }
    }
    if (stacks.length === 0) return res.status(500).json({ error: 'No se pudieron procesar fechas para el composite.' });
    const mask = stacks[0].mask;
    const median = new Float32Array(width * height).fill(NaN);
    const tmp = [];
    for (let k = 0; k < mask.length; k++) {
      const p = mask[k];
      tmp.length = 0;
      for (const s of stacks) {
        const v = s.ndvi[p];
        if (v !== undefined && v !== null && !Number.isNaN(v)) tmp.push(v);
      }
      if (tmp.length) {
        tmp.sort((a, b) => a - b);
        const m = Math.floor(tmp.length / 2);
        median[p] = tmp.length % 2 ? tmp[m] : (tmp[m - 1] + tmp[m]) / 2;
      }
    }
    const st = statsOf(median, mask);
    const hist = histogramOf(median, mask, 60);
    const otsu = otsuFromHist(hist.counts, hist.total);
    const areaPx = areaPerPixel(bbox, width, height);
    const cls = OPTICAL_CLASSES.map(c => ({ ...c }));
    const secondary = await rviNearOptical({ ring, bbox, date, width, height });
    const clsRaster = consensusClassify(median, secondary && secondary.rvi, mask, cls, RVI_CLASSES);
    const areas = classAreasFromRaster(clsRaster, mask, cls, areaPx);
    const image = toPng(clsRaster, width, height, colorClass(cls), mask);
    const bestCloud = used.reduce((m, u) => (u.polygonCloud === null ? m : Math.min(m, u.polygonCloud)), 100);
    const quota = await commitPolygon(req, res, m);
    res.json({
      image, usedDate: date, usedDates: used, bbox, width, height, mode: 'ndvi', composite: true,
      stats: { mean: st.mean, otsu },
      histogram: hist, areaPerPixel: areaPx, cloudPct: bestCloud, classes: areas.classes, areaHa: areas.areaHa,
      consensus: !!secondary, consensusSensorDate: secondary ? secondary.date : null,
      quota
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 3b) Foto de contexto: truecolor de una fecha dada SIN descontar cuota de polígonos (solo requiere sesión).
app.post('/api/v2/recent-scene', async (req, res) => {
  try {
    if (!(await checkUser(req, res))) return;
    const ring = toRing(req.body.coordinates);
    const date = req.body.date;
    const bbox = bboxOf(ring);
    if (!ring || !bbox || !date) return badParams(res, 'Faltan coordinates o date.');
    const { width, height } = imageSize(bbox, 512);
    // Misma imagen truecolor que el "Ver color real" de los paneles (/api/v2/image
    // mode=truecolor), sin enmascarar al polígono: así el estiraje de
    // enhanceTrueColor usa el mismo histograma y el mapa se ve igual que los análisis.
    const image = await fetchTrueColor({ ring, bbox, date, width, height });
    res.json({ image, usedDate: date, bbox, width, height });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 4) Estadísticas radar (RVI + backscatter dB)
app.post('/api/v2/radar-stats', async (req, res) => {
  try {
    const ring = toRing(req.body.coordinates);
    const date = req.body.date;
    const bbox = bboxOf(ring);
    if (!ring || !bbox) return badParams(res, 'Parámetro coordinates inválido.');
    const m = await meterEndpoints(req, res, ring);
    if (!m) return;
    const { width, height } = imageSize(bbox, 512);
    let d = date;
    let pol = 'DV';
    let auto = false;
    if (!d) {
      const found = await findRadarDate(bbox);
      if (!found) return res.status(404).json({ error: 'No se encontraron escenas radar dual-pol en el área.' });
      d = found.date; pol = found.pol; auto = true;
    }
    let { rvi } = await cachedRvi({ ring, bbox, date: d, width, height, polarization: pol });
    const mask = maskIndices(width, height, bbox, ring);
    let st = statsOf(rvi, mask);
    if (st.n === 0 && !auto) {
      const near = await findRadarDateNear(bbox, d);
      if (near) {
        d = near.date;
        ({ rvi } = await cachedRvi({ ring, bbox, date: d, width, height, polarization: pol }));
        st = statsOf(rvi, mask);
      }
    }
    if (st.n === 0) return res.status(404).json({ error: 'No hay escenas radar válidas cerca de la fecha indicada.' });
    const hist = histogramOf(rvi, mask, 60);
    const otsu = otsuFromHist(hist.counts, hist.total);
    const areaPx = areaPerPixel(bbox, width, height);
    const cls = RVI_CLASSES.map(c => ({ ...c }));
    const secondary = await opticalNearRadar({ ring, bbox, date: d, width, height, snowMonths: snowMonthsOf(m) });
    const clsRaster = consensusClassify(rvi, secondary && secondary.ndvi, mask, cls, OPTICAL_CLASSES);
    const areas = classAreasFromRaster(clsRaster, mask, cls, areaPx);
    const image = toPng(clsRaster, width, height, colorClass(cls), mask);
    let vvDb = null, vhDb = null;
    try {
      const db = await fetchBackscatterDb({ ring, bbox, date: d, width, height, polarization: pol });
      const svv = statsOf(db.vv, mask), svh = statsOf(db.vh, mask);
      vvDb = svv.mean; vhDb = svh.mean;
    } catch (e) { /* dB opcional */ }
    const quota = await commitPolygon(req, res, m);
    res.json({
      image, usedDate: d, polarization: pol, bbox, width, height,
      stats: { rviMean: st.mean, vvDb, vhDb, otsu },
      histogram: hist, areaPerPixel: areaPx, classes: areas.classes, areaHa: areas.areaHa,
      consensus: !!secondary, consensusSensorDate: secondary ? secondary.date : null,
      quota
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 5) Cambio dual-sensor (ΔNDVI + ΔRVI + concordancia)
app.post('/api/v2/change', async (req, res) => {
  try {
    const ring = toRing(req.body.coordinates);
    const date1 = req.body.date1, date2 = req.body.date2;
    const bbox = bboxOf(ring);
    if (!ring || !bbox || !date1 || !date2) return badParams(res, 'Faltan coordinates, date1 o date2.');
    const m = await meterEndpoints(req, res, ring);
    if (!m) return;
    const { width, height } = imageSize(bbox, 512);
    const mask = maskIndices(width, height, bbox, ring);

    const [o1, o2] = await Promise.all([
      cachedOptical({ ring, bbox, date: date1, width, height, snowMonths: snowMonthsOf(m) }),
      cachedOptical({ ring, bbox, date: date2, width, height, snowMonths: snowMonthsOf(m) })
    ]);
    const areaPx = areaPerPixel(bbox, width, height);
    const cls = OPTICAL_CLASSES.map(c => ({ ...c }));
    let c1 = classifyMasked(o1.ndvi, mask, cls);
    let c2 = classifyMasked(o2.ndvi, mask, cls);
    // Radar para el consenso y el acuerdo: usa las fechas de la pestaña RVI si están
    // dentro de ±15 días de la fecha óptica correspondiente; si no, la escena 1SDV más
    // cercana a cada fecha. Antes usaba la más reciente del último año para el "antes",
    // lo que desalineaba el consenso con una escena futura (p. ej. 08-04 para un date1
    // de 04-02). Ahora el "antes" se alinea con date1.
    const radarDate1 = req.body.radarDate1 || null;
    const radarDate2 = req.body.radarDate2 || null;
    const band = (Number(req.body.band) > 0 && Number(req.body.band) < 0.5) ? Number(req.body.band) : FOREST_BAND;
    const inWindow = (ref, v) => v && Math.abs(new Date(v) - new Date(ref)) <= 15 * 864e5;
    const r1 = (inWindow(date1, radarDate1) ? { date: radarDate1, pol: 'DV' } : null)
      || (await findRadarDateNear(bbox, date1))
      || (await findRadarDate(bbox));
    let radar = null;
    if (r1) {
      const r2 = (inWindow(date2, radarDate2) ? { date: radarDate2, pol: 'DV' } : null)
        || (await findRadarDateNear(bbox, date2))
        || r1;
      const pol = r1.pol || 'DV';
      const [rad1, rad2] = await Promise.all([
        cachedRvi({ ring, bbox, date: r1.date, width, height, polarization: pol }),
        cachedRvi({ ring, bbox, date: r2.date, width, height, polarization: pol })
      ]);
      radar = { rvi1: rad1.rvi, rvi2: rad2.rvi, date1: r1.date, date2: r2.date, pol };
      c1 = consensusClassify(o1.ndvi, rad1.rvi, mask, cls, RVI_CLASSES);
      c2 = consensusClassify(o2.ndvi, rad2.rvi, mask, cls, RVI_CLASSES);
    }
    const comp = compareCategories(c1, c2, mask, cls, areaPx);
    const robust = robustChange(c1, c2, o1.ndvi, o2.ndvi, mask, cls, areaPx, band);
    const corte = robustChange(c1, c2, o1.ndvi, o2.ndvi, mask, cls, areaPx, CORTE_BAND);
    const compR = compareCategories(c1, robustAfter(c1, c2, o1.ndvi, o2.ndvi, mask, cls, CORTE_BAND), mask, cls, areaPx);
    // Cosecha neta (antes − desp) con descomposición por especie (V4, aditivo).
    const cosecha = computeCosechaInfo(req.body, o1.ndvi, c1, c2, mask, cls, areaPx, comp.forest, bbox, date2);

    const dNdvi = new Float32Array(width * height).fill(NaN);
    const dRvi = new Float32Array(width * height).fill(NaN);
    let agree = { bothDecrease: 0, bothIncrease: 0, mixed: 0, valid: 0 };
    const EPS = 0.02;
    for (let k = 0; k < mask.length; k++) {
      const p = mask[k];
      const n1 = o1.ndvi[p], n2 = o2.ndvi[p];
      if (n1 !== undefined && n2 !== undefined && !Number.isNaN(n1) && !Number.isNaN(n2)) dNdvi[p] = n2 - n1;
      if (radar) {
        const a = radar.rvi1[p], b = radar.rvi2[p];
        if (a !== undefined && b !== undefined && !Number.isNaN(a) && !Number.isNaN(b)) dRvi[p] = b - a;
      }
      const dn = dNdvi[p], dr = dRvi[p];
      if (!Number.isNaN(dn) && !Number.isNaN(dr)) {
        agree.valid++;
        if (dn < -EPS && dr < -EPS) agree.bothDecrease++;
        else if (dn > EPS && dr > EPS) agree.bothIncrease++;
        else agree.mixed++;
      }
    }
    const mean = (arr) => { let s = 0, n = 0; for (const v of arr) { if (!Number.isNaN(v)) { s += v; n++; } } return n ? s / n : null; };
    const imgN = toPng(dNdvi, width, height, colorDiff, mask);
    const imgR = radar ? toPng(dRvi, width, height, colorDiff, mask) : null;
    const agreementPct = agree.valid ? (((agree.bothDecrease + agree.bothIncrease) / agree.valid) * 100) : null;
    const quota = await commitPolygon(req, res, m);

    // ---- Estimación de volumen (ha cosechadas × vol_ha) ----
    // La cosecha se estima con la banda FIJA de corte claro (CORTE_BAND), no con la
    // banda ajustable del formulario: así el número de cosecha no cambia con ese control.
    const lostHa = (corte && typeof corte.lost === 'number') ? corte.lost
      : ((comp.forest && typeof comp.forest.lost === 'number') ? comp.forest.lost : null);
    const volumen = computeVolumeInfo(req.body, o1.ndvi, mask, bbox, lostHa, date2);
    if (volumen && corte) volumen.corteBand = corte.band;
    res.json({
      optical: { date1, date2, dNdviMean: mean(dNdvi), image: imgN },
      radar: radar ? { date1: radar.date1, date2: radar.date2, polarization: radar.pol, dRviMean: mean(dRvi), image: imgR } : null,
      agreement: {
        bothDecrease: agree.bothDecrease, bothIncrease: agree.bothIncrease, mixed: agree.mixed,
        validPixels: agree.valid, agreementPct
      },
      bbox, width, height,
      classes: comp.rows,
      forest: comp.forest,
      forestRob: compR.forest,
      classesRob: compR.rows,
      robust,
      corte,
      consensus: !!radar,
      snow: { months: snowMonthsOf(m) || [], mask1: useSnowForDate(date1, snowMonthsOf(m)), mask2: useSnowForDate(date2, snowMonthsOf(m)) },
      volumen,
      cosecha,
      quota
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

async function findRadarDateNear(bbox, date) {
  const d = new Date(date);
  const from = new Date(d); from.setDate(from.getDate() - 3);
  const to = new Date(d); to.setDate(to.getDate() + 3);
  const data = await catalogSearch({
    bbox,
    collections: ['sentinel-1-grd'],
    datetime: `${from.toISOString().split('T')[0]}T00:00:00Z/${to.toISOString().split('T')[0]}T23:59:59Z`,
    limit: 10
  });
  // Solo 1SDV (VV/VH) y la fecha más cercana a la referencia: así el "Comparar NDVI"
  // usa la misma escena radar que elegiría el usuario en la pestaña RVI.
  let best = null, bestDist = Infinity;
  for (const f of data.features) {
    if (!f.id || !f.id.includes('1SDV')) continue;
    const dd = f.properties.datetime.split('T')[0];
    const dist = Math.abs(new Date(dd) - d);
    if (dist < bestDist) { bestDist = dist; best = { date: dd, id: f.id }; }
  }
  return best;
}

// 6) Serie temporal NDVI
app.post('/api/v2/ndvi-timeseries', async (req, res) => {
  try {
    const ring = toRing(req.body.coordinates);
    const maxDates = Math.min(Number(req.body.maxDates || 20), 30);
    const maxSceneCloud = Number(req.body.maxSceneCloud || 40);
    const bbox = bboxOf(ring);
    if (!ring || !bbox) return badParams(res, 'Parámetro coordinates inválido.');
    const m = await meterEndpoints(req, res, ring);
    if (!m) return;
    const now = new Date();
    const start = new Date(); start.setFullYear(now.getFullYear() - 1);
    const data = await catalogSearch({
      bbox,
      collections: ['sentinel-2-l2a'],
      datetime: `${start.toISOString().split('T')[0]}T00:00:00Z/${now.toISOString().split('T')[0]}T23:59:59Z`,
      limit: 100,
      filter: `eo:cloud_cover < ${maxSceneCloud}`
    });
    const seen = new Set(); const dates = [];
    for (const f of data.features) {
      const d = f.properties.datetime.split('T')[0];
      if (seen.has(d)) continue; seen.add(d);
      dates.push({ date: d, cloud: f.properties['eo:cloud_cover'] });
    }
    dates.sort((a, b) => new Date(a.date) - new Date(b.date));
    const picks = dates.slice(-maxDates);
    const W = 256, H = 256;
    const mask = maskIndices(W, H, bbox, ring);
    const series = [];
    for (const p of picks) {
      try {
        const { ndvi, cloud } = await fetchOptical({ ring, bbox, date: p.date, width: W, height: H, snowMonths: snowMonthsOf(m) });
        const cp = cloudPctOf(cloud, mask);
        const st = statsOf(ndvi, mask);
        series.push({ date: p.date, sceneCloud: Math.round(p.cloud * 10) / 10, polygonCloud: cp.cloudPct, ndviMean: st.mean });
      } catch (e) {
        series.push({ date: p.date, sceneCloud: p.cloud, polygonCloud: null, ndviMean: null, error: e.message });
      }
    }
    const quota = await commitPolygon(req, res, m);
    res.json({ series, quota });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 7) Info del polígono
app.post('/api/v2/polygon-info', (req, res) => {
  try {
    const ring = toRing(req.body.coordinates);
    const bbox = bboxOf(ring);
    if (!ring || !bbox) return badParams(res, 'Parámetro coordinates inválido.');
    res.json({ areaHa: Math.round(polygonAreaHa(ring) * 100) / 100, bbox });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
// COMPARACIÓN DE CATEGORÍAS ENTRE DOS FECHAS (con enfoque bosque)
// ============================================================
function classifyMasked(values, mask, classes) {
  const n = classes.length;
  const out = new Uint8Array(values.length).fill(255);
  for (let k = 0; k < mask.length; k++) {
    const p = mask[k];
    const v = values[p];
    if (v === undefined || v === null || Number.isNaN(v)) continue;
    for (let i = 0; i < n; i++) {
      if (v >= classes[i].from && v < classes[i].to) { out[p] = i; break; }
    }
  }
  return out;
}
function hexRgb(hex) {
  const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
  return [r, g, b];
}
function colorClass(classes) {
  const cols = classes.map(c => hexRgb(c.color));
  return (idx) => (idx >= 0 && idx < cols.length) ? cols[idx] : [0, 0, 0];
}
function compareCategories(c1, c2, mask, classes, areaPerPx) {
  const n = classes.length;
  const forestIds = classes.map((c, i) => c.forest ? i : -1).filter(i => i >= 0);
  const isForest = (i) => forestIds.includes(i);
  const cnt1 = new Array(n).fill(0), cnt2 = new Array(n).fill(0);
  const matrix = Array.from({ length: n }, () => new Array(n).fill(0));
  let valid = 0, same = 0;
  for (let k = 0; k < mask.length; k++) {
    const p = mask[k];
    const a = c1[p], b = c2[p];
    if (a === 255 || b === 255) continue;
    cnt1[a]++; cnt2[b]++; matrix[a][b]++;
    valid++;
    if (a === b) same++;
  }
  const toHa = (c) => (c * areaPerPx) / 10000;
  const rows = classes.map((c, i) => ({
    id: c.id, label: c.label, color: c.color,
    ha1: Math.round(toHa(cnt1[i]) * 100) / 100,
    ha2: Math.round(toHa(cnt2[i]) * 100) / 100,
    delta: Math.round(toHa(cnt2[i] - cnt1[i]) * 100) / 100,
    deltaPct: cnt1[i] ? Math.round(((cnt2[i] - cnt1[i]) / cnt1[i]) * 1000) / 10 : null
  }));
  let lost = 0, gained = 0;
  for (let i = 0; i < n; i++) {
    if (isForest(i)) continue;
    for (const fid of forestIds) { lost += matrix[fid][i]; gained += matrix[i][fid]; }
  }
  let fcnt1 = 0, fcnt2 = 0;
  for (const fid of forestIds) { fcnt1 += cnt1[fid]; fcnt2 += cnt2[fid]; }
  const forest1 = toHa(fcnt1), forest2 = toHa(fcnt2);
  const codes = new Uint8Array(c1.length).fill(255);
  let cLost = 0, cGained = 0, cOther = 0, cUnchanged = 0;
  for (let k = 0; k < mask.length; k++) {
    const p = mask[k];
    const a = c1[p], b = c2[p];
    if (a === 255 || b === 255) continue;
    if (isForest(a) && isForest(b)) { codes[p] = 4; cUnchanged++; }
    else if (isForest(a) && !isForest(b)) { codes[p] = 1; cLost++; }
    else if (!isForest(a) && isForest(b)) { codes[p] = 2; cGained++; }
    else if (a !== b) { codes[p] = 3; cOther++; }
    else { codes[p] = 4; cUnchanged++; }
  }
  const roundH = (c) => Math.round(toHa(c) * 100) / 100;
  return {
    rows,
    forest: {
      ha1: Math.round(forest1 * 100) / 100,
      ha2: Math.round(forest2 * 100) / 100,
      delta: Math.round((forest2 - forest1) * 100) / 100,
      deltaPct: forest1 ? Math.round(((forest2 - forest1) / forest1) * 1000) / 10 : null,
      lost: roundH(lost),
      gained: roundH(gained),
      net: Math.round(toHa(gained - lost) * 100) / 100
    },
    change: { lostHa: roundH(cLost), gainedHa: roundH(cGained), otherHa: roundH(cOther), unchangedHa: roundH(cUnchanged) },
    agreementPct: valid ? Math.round((same / valid) * 1000) / 10 : null,
    changedPct: valid ? Math.round(((valid - same) / valid) * 1000) / 10 : null,
    validPixels: valid,
    codes
  };
}
const colorChangeMap = (c) => {
  if (c === 1) return [220, 38, 38];
  if (c === 2) return [22, 163, 74];
  if (c === 3) return [250, 204, 21];
  if (c === 4) return [100, 116, 139];
  return [0, 0, 0];
};

// Cambio "robusto" contra el churn: un píxel solo se cuenta como perdido/ganado si
// cruza el umbral de bosque del sensor primario por más que la banda de tolerancia
// (histéresis). Los que oscilan alrededor del umbral (NDVI≈0.85, RVI≈0.70) no se
// contabilizan como cambio. Se construye sobre las clases finales (consenso si hubo
// radar), por lo que no altera las superficies por categoría ya mostradas.
const FOREST_BAND = 0.02;
// Banda FIJA para estimar la cosecha (corte claro): no depende de la banda que el
// usuario ajuste en el formulario, para que "cuánto se cosechó" sea un número estable.
const CORTE_BAND = 0.02;
function robustChange(c1, c2, v1, v2, mask, classes, areaPerPx, band = FOREST_BAND) {
  const f = classes.findIndex(c => c.forest);
  const out = { lost: 0, gained: 0, valid: 0 };
  if (f >= 0) {
    const thr = classes[f].from;
    for (let k = 0; k < mask.length; k++) {
      const p = mask[k];
      const a = v1[p], b = v2[p];
      if (a === undefined || a === null || b === undefined || b === null || Number.isNaN(a) || Number.isNaN(b)) continue;
      out.valid++;
      const was = c1[p] === f, is = c2[p] === f;
      if (was && !is) { if (a >= thr + band && b <= thr - band) out.lost++; }
      else if (!was && is) { if (a <= thr - band && b >= thr + band) out.gained++; }
    }
  }
  const toHa = (c) => Math.round(((c * areaPerPx) / 10000) * 100) / 100;
  return {
    lost: toHa(out.lost), gained: toHa(out.gained), net: toHa(out.gained - out.lost),
    band, validPixels: out.valid,
    changedPct: out.valid ? Math.round(((out.lost + out.gained) / out.valid) * 1000) / 10 : null
  };
}
function robustAfter(c1, c2, v1, v2, mask, classes, band = FOREST_BAND) {
  const f = classes.findIndex(c => c.forest);
  const out = c2.slice();
  if (f >= 0) {
    const thr = classes[f].from;
    for (let k = 0; k < mask.length; k++) {
      const p = mask[k];
      const a = v1[p], b = v2[p];
      if (a === undefined || a === null || b === undefined || b === null || Number.isNaN(a) || Number.isNaN(b)) continue;
      const was = c1[p] === f, is = c2[p] === f;
      if (!was && is) out[p] = c1[p];
      else if (was && !is) { if (!(a >= thr + band && b <= thr - band)) out[p] = c1[p]; }
    }
  }
  return out;
}

// 8) Comparar superficies por categoría entre dos fechas
app.post('/api/v2/compare', async (req, res) => {
  try {
    const ring = toRing(req.body.coordinates);
    const date1 = req.body.date1, date2 = req.body.date2;
    const bbox = bboxOf(ring);
    if (!ring || !bbox || !date1 || !date2) return badParams(res, 'Faltan coordinates, date1 o date2.');
    const m = await meterEndpoints(req, res, ring);
    if (!m) return;
    const { width, height } = imageSize(bbox, 512);
    const mask = maskIndices(width, height, bbox, ring);
    const areaPx = areaPerPixel(bbox, width, height);

    const [o1, o2] = await Promise.all([
      cachedOptical({ ring, bbox, date: date1, width, height, snowMonths: snowMonthsOf(m) }),
      cachedOptical({ ring, bbox, date: date2, width, height, snowMonths: snowMonthsOf(m) })
    ]);
    const cls = OPTICAL_CLASSES.map(c => ({ ...c }));
    let c1 = classifyMasked(o1.ndvi, mask, cls);
    let c2 = classifyMasked(o2.ndvi, mask, cls);
    const cp1 = cloudPctOf(o1.cloud, mask), cp2 = cloudPctOf(o2.cloud, mask);

    const radarDate1 = req.body.radarDate1 || null;
    const radarDate2 = req.body.radarDate2 || null;
    const radarPol = req.body.radarPol || 'DV';
    const band = (Number(req.body.band) > 0 && Number(req.body.band) < 0.5) ? Number(req.body.band) : FOREST_BAND;

    // Radar comparativo (si hay escenas cerca de ambas fechas): alimenta el
    // consenso dual-sensor sin descargar nada extra (reutiliza ra1/ra2 y o1/o2).
    // Si el frontend envía radarDate1/2 usa esas fechas exactas (las mismas de la
    // pestaña RVI) para que ambas comparaciones usen las mismas escenas. Solo las
    // acepta si están cerca de la fecha óptica correspondiente (±15 días); si no,
    // busca la escena 1SDV más cercana (evita alinear con fechas sin relación).
    const inWindow = (ref, v) => v && Math.abs(new Date(v) - new Date(ref)) <= 15 * 864e5;
    let radar = null;
    try {
      const r1 = (inWindow(date1, radarDate1)) ? { date: radarDate1 } : await findRadarDateNear(bbox, date1);
      const r2 = (inWindow(date2, radarDate2)) ? { date: radarDate2 } : await findRadarDateNear(bbox, date2);
      if (r1 && r2 && r1.date !== r2.date) {
        const [ra1, ra2] = await Promise.all([
          cachedRvi({ ring, bbox, date: r1.date, width, height, polarization: radarPol }),
          cachedRvi({ ring, bbox, date: r2.date, width, height, polarization: radarPol })
        ]);
        const rcls = RVI_CLASSES.map(c => ({ ...c }));
        const rc1 = consensusClassify(ra1.rvi, o1.ndvi, mask, rcls, cls);
        const rc2 = consensusClassify(ra2.rvi, o2.ndvi, mask, rcls, cls);
        const rcomp = compareCategories(rc1, rc2, mask, rcls, areaPx);
        const rrobust = robustChange(rc1, rc2, ra1.rvi, ra2.rvi, mask, rcls, areaPx, band);
        radar = {
          date1: r1.date, date2: r2.date, polarization: radarPol,
          forest: rcomp.forest, classes: rcomp.rows, change: rcomp.change,
          agreementPct: rcomp.agreementPct, changedPct: rcomp.changedPct,
          robust: rrobust,
          image1: toPng(rc1, width, height, colorClass(rcls), mask),
          image2: toPng(rc2, width, height, colorClass(rcls), mask),
          changeImage: toPng(rcomp.codes, width, height, colorChangeMap, mask)
        };
        c1 = consensusClassify(o1.ndvi, ra1.rvi, mask, cls, rcls);
        c2 = consensusClassify(o2.ndvi, ra2.rvi, mask, cls, rcls);
      }
    } catch (e) { /* radar opcional */ }
    const comp = compareCategories(c1, c2, mask, cls, areaPx);
    const robust = robustChange(c1, c2, o1.ndvi, o2.ndvi, mask, cls, areaPx, band);
    const corte = robustChange(c1, c2, o1.ndvi, o2.ndvi, mask, cls, areaPx, CORTE_BAND);
    const c2r = robustAfter(c1, c2, o1.ndvi, o2.ndvi, mask, cls, CORTE_BAND);
    const compR = compareCategories(c1, c2r, mask, cls, areaPx);
    const lostHa = (corte && typeof corte.lost === 'number') ? corte.lost
      : ((comp.forest && typeof comp.forest.lost === 'number') ? comp.forest.lost : null);
    const volumen = computeVolumeInfo(req.body, o1.ndvi, mask, bbox, lostHa, date2);
    if (volumen && corte) volumen.corteBand = corte.band;
    // Cosecha neta (antes − desp) con descomposición por especie (V4, aditivo).
    const cosecha = computeCosechaInfo(req.body, o1.ndvi, c1, c2, mask, cls, areaPx, comp.forest, bbox, date2);

    const quota = await commitPolygon(req, res, m);
    res.json({
      optical: {
        date1, date2,
        cloudPct1: cp1.cloudPct, cloudPct2: cp2.cloudPct,
        forest: comp.forest,
        classes: comp.rows,
        change: comp.change,
        forestRob: compR.forest,
        classesRob: compR.rows,
        changeRob: compR.change,
        robust,
        corte,
        agreementPct: comp.agreementPct, changedPct: comp.changedPct,
        areaPerPixel: areaPx,
        image1: toPng(c1, width, height, colorClass(cls), mask),
        image2: toPng(c2, width, height, colorClass(cls), mask),
        image2Rob: toPng(c2r, width, height, colorClass(cls), mask),
        changeImage: toPng(comp.codes, width, height, colorChangeMap, mask),
        changeImageRob: toPng(compR.codes, width, height, colorChangeMap, mask)
      },
      radar,
      bbox, width, height,
      consensus: !!radar,
      snow: { months: snowMonthsOf(m) || [], mask1: useSnowForDate(date1, snowMonthsOf(m)), mask2: useSnowForDate(date2, snowMonthsOf(m)) },
      volumen,
      cosecha,
      quota
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 9) Fechas disponibles de radar (Sentinel-1 GRD dual-pol, modo IW) sobre el polígono
app.post('/api/v2/radar-dates', async (req, res) => {
  try {
    const ring = toRing(req.body.coordinates);
    const bbox = bboxOf(ring);
    if (!ring || !bbox) return badParams(res, 'Parámetro coordinates inválido.');
    const m = await meterEndpoints(req, res, ring);
    if (!m) return;
    const now = new Date();
    const start = new Date();
    start.setFullYear(now.getFullYear() - 1);
    const data = await catalogSearch({
      bbox,
      collections: ['sentinel-1-grd'],
      datetime: start.toISOString() + '/' + now.toISOString(),
      limit: 100
    });
    const seen = new Set();
    const dates = [];
    for (const f of (data.features || [])) {
      // Solo 1SDV (VV/VH): el RVI requiere esas bandas; 1SDH (HH/HV) no es usable.
      if (!(f.id && f.id.includes('1SDV'))) continue;
      const d = (f.properties.datetime || '').split('T')[0];
      if (!d || seen.has(d)) continue;
      seen.add(d);
      dates.push({
        date: d,
        polarization: 'DV',
        relativeOrbit: (f.properties && f.properties['sat:relative_orbit']) || null
      });
    }
    dates.sort((a, b) => new Date(b.date) - new Date(a.date));
    res.json({ dates, count: dates.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 10) Comparar superficies por categoría RVI entre dos fechas radar
app.post('/api/v2/compare-rvi', async (req, res) => {
  try {
    const ring = toRing(req.body.coordinates);
    const date1 = req.body.date1, date2 = req.body.date2;
    const bbox = bboxOf(ring);
    if (!ring || !bbox || !date1 || !date2) return badParams(res, 'Faltan coordinates, date1 o date2.');
    const m = await meterEndpoints(req, res, ring);
    if (!m) return;
    const { width, height } = imageSize(bbox, 512);
    const mask = maskIndices(width, height, bbox, ring);
    const areaPx = areaPerPixel(bbox, width, height);
    const [r1, r2] = await Promise.all([
      cachedRvi({ ring, bbox, date: date1, width, height, polarization: 'DV' }),
      cachedRvi({ ring, bbox, date: date2, width, height, polarization: 'DV' })
    ]);
    const rcls = RVI_CLASSES.map(c => ({ ...c }));
    let rc1 = classifyMasked(r1.rvi, mask, rcls);
    let rc2 = classifyMasked(r2.rvi, mask, rcls);
    // Consenso dual: si el frontend envía opticalDate1/2 usa esas fechas S2 exactas
    // (las mismas de la pestaña "Comparar NDVI"); solo las acepta si están cerca de
    // la fecha radar correspondiente (±15 días); si no, busca la S2 más cercana.
    const opticalDate1 = req.body.opticalDate1 || null;
    const opticalDate2 = req.body.opticalDate2 || null;
    const band = (Number(req.body.band) > 0 && Number(req.body.band) < 0.5) ? Number(req.body.band) : FOREST_BAND;
    const inWindow = (ref, v) => v && Math.abs(new Date(v) - new Date(ref)) <= 15 * 864e5;
    const sec1 = inWindow(date1, opticalDate1)
      ? cachedOptical({ ring, bbox, date: opticalDate1, width, height, snowMonths: snowMonthsOf(m) })
      : opticalNearRadar({ ring, bbox, date: date1, width, height, snowMonths: snowMonthsOf(m) });
    const sec2 = inWindow(date2, opticalDate2)
      ? cachedOptical({ ring, bbox, date: opticalDate2, width, height, snowMonths: snowMonthsOf(m) })
      : opticalNearRadar({ ring, bbox, date: date2, width, height, snowMonths: snowMonthsOf(m) });
    const [s1, s2] = await Promise.all([sec1, sec2]);
    rc1 = consensusClassify(r1.rvi, s1 && s1.ndvi, mask, rcls, OPTICAL_CLASSES);
    rc2 = consensusClassify(r2.rvi, s2 && s2.ndvi, mask, rcls, OPTICAL_CLASSES);
    const comp = compareCategories(rc1, rc2, mask, rcls, areaPx);
    const robust = robustChange(rc1, rc2, r1.rvi, r2.rvi, mask, rcls, areaPx, band);
    const corte = robustChange(rc1, rc2, r1.rvi, r2.rvi, mask, rcls, areaPx, CORTE_BAND);
    const rc2r = robustAfter(rc1, rc2, r1.rvi, r2.rvi, mask, rcls, CORTE_BAND);
    const rcompR = compareCategories(rc1, rc2r, mask, rcls, areaPx);
    const lostHa = (corte && typeof corte.lost === 'number') ? corte.lost
      : ((comp.forest && typeof comp.forest.lost === 'number') ? comp.forest.lost : null);
    const volumen = computeVolumeInfo(req.body, s1 && s1.ndvi, mask, bbox, lostHa, date2);
    if (volumen && corte) volumen.corteBand = corte.band;
    // Cosecha neta (antes − desp) con descomposición por especie (V4, aditivo).
    const cosecha = computeCosechaInfo(req.body, s1 && s1.ndvi, rc1, rc2, mask, rcls, areaPx, comp.forest, bbox, date2);
    const sec1Date = inWindow(date1, opticalDate1) ? opticalDate1 : (s1 && s1.date);
    const sec2Date = inWindow(date2, opticalDate2) ? opticalDate2 : (s2 && s2.date);
    const quota = await commitPolygon(req, res, m);
    res.json({
      radar: {
        date1, date2, polarization: 'DV',
        forest: comp.forest, classes: comp.rows, change: comp.change,
        forestRob: rcompR.forest,
        classesRob: rcompR.rows,
        changeRob: rcompR.change,
        agreementPct: comp.agreementPct, changedPct: comp.changedPct,
        robust,
        corte,
        areaPerPixel: areaPx,
        image1: toPng(rc1, width, height, colorClass(rcls), mask),
        image2: toPng(rc2, width, height, colorClass(rcls), mask),
        image2Rob: toPng(rc2r, width, height, colorClass(rcls), mask),
        changeImage: toPng(comp.codes, width, height, colorChangeMap, mask),
        changeImageRob: toPng(rcompR.codes, width, height, colorChangeMap, mask)
      },
      bbox, width, height,
      consensus: !!(s1 && s1.ndvi) || !!(s2 && s2.ndvi),
      consensusSecondaryDates: [sec1Date, sec2Date],
      snow: { months: snowMonthsOf(m) || [], mask1: useSnowForDate(sec1Date, snowMonthsOf(m)), mask2: useSnowForDate(sec2Date, snowMonthsOf(m)) },
      snowStats1: snowMaskStats(s1), snowStats2: snowMaskStats(s2),
      volumen,
      cosecha,
      quota
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
// HERBICIDE — Control vegetación / Timing / Efectividad
// ============================================================

const HERBICIDE_MOISTURE_EVAL = `//VERSION=3
function setup() {
  return {
    input: [{ bands: ["B03","B04","B05","B08","B11","SCL"], units: "DN" }],
    output: [{ id: "res", bands: 4, sampleType: "FLOAT32" }]
  };
}
function isCloud(scl) { return scl === 3 || scl === 8 || scl === 9 || scl === 10; }
function valid(scl) { return scl !== 0 && scl !== 1 && scl !== 11; }
function evaluatePixel(sample) {
  var scl = sample.SCL;
  if (!valid(scl)) return { res: [NaN, NaN, NaN, NaN] };
  var ndvi = (sample.B08 - sample.B04) / (sample.B08 + sample.B04 + 1e-8);
  var savi = ((sample.B08 - sample.B04) / (sample.B08 + sample.B04 + 0.5)) * 1.5;
  var ndwi = (sample.B03 - sample.B08) / (sample.B03 + sample.B08 + 1e-8);
  var ndre = (sample.B08 - sample.B05) / (sample.B08 + sample.B05 + 1e-8);
  return { res: [(ndvi + 1) / 2, (savi + 1) / 2, (ndwi + 1) / 2, (ndre + 1) / 2] };
}`;

async function fetchHerbicideMoisture({ ring, bbox, date, width, height, snowMonths = null }) {
  const payload = {
    input: {
      bounds: { geometry: { type: 'Polygon', coordinates: [ring] } },
      data: [{ type: 'sentinel-2-l2a', dataFilter: { timeRange: { from: `${date}T00:00:00Z`, to: `${date}T23:59:59Z` }, maxCloudCoverage: 100 } }]
    },
    output: { width, height, responses: [{ identifier: 'res', format: { type: 'image/tiff' } }] },
    evalscript: useSnowForDate(date, snowMonths) ? HERBICIDE_MOISTURE_EVAL : HERBICIDE_MOISTURE_EVAL
  };
  const buf = await shFetch(payload);
  const { bands } = await parseTiff(buf);
  if (bands.length < 4) throw new Error('Respuesta de humedad incompleta (bands=' + bands.length + ')');
  return { ndvi: bands[0].values, savi: bands[1].values, ndwi: bands[2].values, ndre: bands[3].values, width, height };
}

const S1_SAR_EVAL = `//VERSION=3
function setup() {
  return {
    input: [{ bands: ["VV","VH"] }],
    output: [{ id: "res", bands: 3, sampleType: "FLOAT32" }]
  };
}
function evaluatePixel(sample) {
  var vv = 10 * Math.log10(sample.VV);
  var vh = 10 * Math.log10(sample.VH);
  var ratio = vh - vv;
  return { res: [vv, vh, ratio] };
}`;

async function fetchS1Sar({ ring, bbox, date, width, height }) {
  const payload = {
    input: {
      bounds: { geometry: { type: 'Polygon', coordinates: [ring] } },
      data: [{ type: 'sentinel-1-grd', dataFilter: { timeRange: { from: `${date}T00:00:00Z`, to: `${date}T23:59:59Z` }, polarization: 'DV', instrumentMode: 'IW' } }]
    },
    output: { width, height, responses: [{ identifier: 'res', format: { type: 'image/tiff' } }] },
    evalscript: S1_SAR_EVAL
  };
  const buf = await shFetch(payload);
  const { bands } = await parseTiff(buf);
  if (bands.length < 3) throw new Error('Respuesta SAR incompleta (bands=' + bands.length + ')');
  return { vv: bands[0].values, vh: bands[1].values, ratio: bands[2].values, width, height };
}

async function findS1Date({ bbox, month, year, maxDays = 45 }) {
  const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
  const endDate = `${year}-${String(month).padStart(2, '0')}-${new Date(year, month, 0).getDate()}`;
  try {
    const data = await catalogSearch({ bbox, collections: ['sentinel-1-grd'], datetime: `${startDate}T00:00:00Z/${endDate}T23:59:59Z`, limit: 10 });
    if (data.features && data.features.length) {
      const dates = data.features.map(f => f.properties.datetime.split('T')[0]).sort();
      return dates[Math.floor(dates.length / 2)];
    }
  } catch (e) { /* noop */ }
  const py = year - 1;
  const sy2 = `${py}-${String(month).padStart(2, '0')}-01`;
  const ey2 = `${py}-${String(month).padStart(2, '0')}-${new Date(py, month, 0).getDate()}`;
  try {
    const data2 = await catalogSearch({ bbox, collections: ['sentinel-1-grd'], datetime: `${sy2}T00:00:00Z/${ey2}T23:59:59Z`, limit: 10 });
    if (data2.features && data2.features.length) {
      const dates = data2.features.map(f => f.properties.datetime.split('T')[0]).sort();
      return dates[Math.floor(dates.length / 2)];
    }
  } catch (e2) { /* noop */ }
  return null;
}

function smoothSeries(arr, windowSize = 3) {
  const out = new Array(arr.length).fill(null);
  const half = Math.floor(windowSize / 2);
  for (let i = 0; i < arr.length; i++) {
    if (arr[i] === null) continue;
    let sum = 0, n = 0;
    for (let j = Math.max(0, i - half); j <= Math.min(arr.length - 1, i + half); j++) {
      if (arr[j] !== null) { sum += arr[j]; n++; }
    }
    out[i] = n > 0 ? sum / n : null;
  }
  return out;
}

function findLocalExtrema(series) {
  const extrema = [];
  for (let i = 1; i < series.length - 1; i++) {
    if (series[i] === null) continue;
    const prev = series[i - 1], next = series[i + 1];
    if (prev !== null && next !== null) {
      if (series[i] <= prev && series[i] <= next) extrema.push({ index: i, type: 'min', value: series[i] });
      if (series[i] >= prev && series[i] >= next) extrema.push({ index: i, type: 'max', value: series[i] });
    }
  }
  return extrema;
}

function classifyWindows(timeseries, extrema) {
  const valid = timeseries.filter(t => t.ndvi !== null).map(t => t.ndvi);
  const mean = valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : 0.5;
  const windows = [];
  const mins = extrema.filter(e => e.type === 'min');
  for (const m of mins) {
    const val = m.value;
    if (val >= mean) continue;
    let level;
    if (val < 0.35) level = 'optimal';
    else if (val < mean * 0.85) level = 'good';
    else level = 'marginal';
    windows.push({ index: m.index, date: timeseries[m.index]?.date || null, ndvi: val, level, label: level === 'optimal' ? 'Óptima' : level === 'good' ? 'Buena' : 'Marginal' });
  }
  return windows;
}

function computeTrend(series) {
  const valid = series.filter(v => v !== null);
  if (valid.length < 2) return { slope: 0, direction: 'estable', r2: 0 };
  const n = valid.length;
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0;
  for (let i = 0; i < n; i++) {
    sumX += i; sumY += valid[i];
    sumXY += i * valid[i]; sumX2 += i * i; sumY2 += valid[i] * valid[i];
  }
  const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX || 1);
  const r2num = (n * sumXY - sumX * sumY) ** 2;
  const r2den = (n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY) || 1;
  const r2 = r2num / r2den;
  let direction;
  if (slope > 0.005) direction = 'creciente';
  else if (slope < -0.005) direction = 'decreciente';
  else direction = 'estable';
  return { slope: Number(slope.toFixed(5)), direction, r2: Number(r2.toFixed(3)) };
}

function generateHerbicideRecommendation(trend, windows, series, monthlyPattern) {
  const valid = series.filter(v => v !== null);
  const avg = valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : 0;
  const monthNames = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
  const bestWindow = windows.filter(w => w.level === 'optimal' || w.level === 'good').sort((a, b) => a.ndvi - b.ndvi)[0];
  let nextWindow = null;
  if (bestWindow && bestWindow.date) {
    const now = new Date();
    const bestDate = new Date(bestWindow.date);
    let nextDate = new Date(bestDate);
    while (nextDate <= now) nextDate.setMonth(nextDate.getMonth() + 12);
    nextWindow = { date: nextDate.toISOString().split('T')[0], level: bestWindow.level, ndvi: bestWindow.ndvi, basedOn: bestWindow.date };
  }
  const decliningMonths = [];
  const lowStableMonths = [];
  if (monthlyPattern && monthlyPattern.length) {
    const avgByMonth = {};
    monthlyPattern.forEach(p => { if (p.avgNdvi !== null) avgByMonth[p.month] = p.avgNdvi; });
    for (const p of monthlyPattern) {
      if (p.avgNdvi === null || p.avgNdvi < 0.15) continue;
      if (p.n < 2) continue;
      const prev = p.month > 1 ? p.month - 1 : 12;
      const next = p.month < 12 ? p.month + 1 : 1;
      const neighbors = [avgByMonth[prev], avgByMonth[next]].filter(v => v !== undefined);
      if (neighbors.length) {
        const avgNeighbors = neighbors.reduce((a, b) => a + b, 0) / neighbors.length;
        if (avgNeighbors - p.avgNdvi > 0.12) continue;
      }
      if (p.monthTrend === 'descendente') decliningMonths.push(p);
      if (p.avgNdvi < avg && p.monthTrend !== 'creciente') lowStableMonths.push(p);
    }
  }
  decliningMonths.sort((a, b) => a.avgNdvi - b.avgNdvi);
  lowStableMonths.sort((a, b) => a.avgNdvi - b.avgNdvi);
  const now2 = new Date();
  const currentMonth = now2.getMonth() + 1;
  const currentYear = now2.getFullYear();
  const allRelevant = [...decliningMonths.map(p => ({ ...p, reason: 'descendente' })), ...lowStableMonths.filter(p => !decliningMonths.some(d => d.month === p.month)).map(p => ({ ...p, reason: 'bajo_estable' }))];
  allRelevant.sort((a, b) => a.avgNdvi - b.avgNdvi);
  let nextBestMonth = null;
  if (allRelevant.length) {
    for (const c of allRelevant) {
      const year = c.month >= currentMonth ? currentYear : currentYear + 1;
      nextBestMonth = { month: c.month, label: monthNames[c.month - 1], expectedDate: `${year}-${String(c.month).padStart(2, '0')}-15`, avgNdvi: c.avgNdvi, reason: c.reason };
      break;
    }
  }
  const bestMonths = allRelevant.slice(0, 3).map(p => ({ month: p.month, label: monthNames[p.month - 1], avgNdvi: p.avgNdvi, reason: p.reason }));
  let advice;
  const decLabels = decliningMonths.map(p => p.label).join(', ');
  const lowLabels = lowStableMonths.slice(0, 3).map(p => p.label).join(', ');
  if (nextBestMonth) {
    const reasonText = nextBestMonth.reason === 'descendente'
      ? `la cobertura vegetal está en descenso en ${nextBestMonth.label}`
      : `la cobertura vegetal es baja y estable en ${nextBestMonth.label}`;
    advice = `Análisis del patrón estacional NDVI: ${reasonText} (promedio: ${nextBestMonth.avgNdvi.toFixed(3)}). `;
    if (decLabels) advice += `Meses con tendencia descendente: ${decLabels}. `;
    if (lowLabels) advice += `Meses con cobertura baja: ${lowLabels}. `;
    advice += `Estos períodos pueden corresponder a barbecho, post-cosecha o receso vegetativo. Verifique el calendario agrícola de su zona y valide las condiciones de suelo en la Fase 2.`;
  } else if (trend.direction === 'decreciente') {
    advice = 'La vegetación está en declive general. Identifique los meses con menor cobertura en el patrón mensual y valide condiciones en Fase 2.';
  } else if (trend.direction === 'creciente') {
    advice = 'La vegetación está en crecimiento. Los meses de menor cobertura podrían corresponder a post-cosecha o receso. Verifique el calendario agrícola local.';
  } else {
    advice = 'La vegetación es estable. Revise el patrón mensual para identificar períodos de menor cobertura vegetal.';
  }
  return { advice, bestWindow: bestWindow || null, nextWindow, nextBestMonth, bestMonths, decliningMonths: decliningMonths.map(p => ({ month: p.month, label: p.label, avgNdvi: p.avgNdvi })), avgNdvi: Number(avg.toFixed(3)) };
}

// POST /api/v2/herbicide-timing — Fase 1: Detección de ventanas de aplicación
app.post('/api/v2/herbicide-timing', async (req, res) => {
  try {
    const { coordinates, lookbackMonths = 12, maxCloudCoverage = 30 } = req.body || {};
    if (!Array.isArray(coordinates) || coordinates.length < 3) return badParams(res, 'Faltan coordenadas del polígono.');
    const ring = coordinates;
    const bbox = bboxOf(ring);
    if (!bbox) return badParams(res, 'BBOX inválido.');
    const { width, height } = imageSize(bbox);
    const m = await meterEndpoints(req, res, ring);
    if (!m) return;
    const now = new Date();
    const start = new Date(now);
    start.setMonth(start.getMonth() - lookbackMonths);
    const snowM = null;
    const months = [];
    for (let d = new Date(start); d <= now; d.setMonth(d.getMonth() + 1)) {
      months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
    }
    const timeseries = [];
    for (const mk of months) {
      const [y, m2] = mk.split('-').map(Number);
      const monthStart = new Date(y, m2 - 1, 1);
      const monthEnd = new Date(y, m2, 0);
      try {
        const data = await catalogSearch({ bbox, collections: ['sentinel-2-l2a'], datetime: `${monthStart.toISOString().split('T')[0]}T00:00:00Z/${monthEnd.toISOString().split('T')[0]}T23:59:59Z`, limit: 50, filter: `eo:cloud_cover < ${maxCloudCoverage}` });
        if (!data.features || !data.features.length) { timeseries.push({ date: mk + '-15', ndvi: null, savi: null }); continue; }
        const dates = data.features.map(f => f.properties.datetime.split('T')[0]).sort();
        const bestDate = dates[Math.floor(dates.length / 2)];
        const ring2 = toRing(ring);
        const idx = maskIndices(width, height, bbox, ring2);
        const img = await fetchHerbicideMoisture({ ring: ring2, bbox, date: bestDate, width, height });
        const ndviSt = statsOf(img.ndvi, idx);
        const saviSt = statsOf(img.savi, idx);
        timeseries.push({ date: bestDate, ndvi: ndviSt.mean !== null ? Number(((ndviSt.mean * 2 - 1)).toFixed(3)) : null, savi: saviSt.mean !== null ? Number(((saviSt.mean * 2 - 1)).toFixed(3)) : null });
      } catch (e) { timeseries.push({ date: mk + '-15', ndvi: null, savi: null }); }
    }
    const ndviValues = timeseries.map(t => t.ndvi);
    const saviValues = timeseries.map(t => t.savi);
    const smoothed = smoothSeries(ndviValues, 3);
    const extrema = findLocalExtrema(smoothed.map((v, i) => v !== null ? v : ndviValues[i]));
    const windows = classifyWindows(timeseries, extrema);
    const trend = computeTrend(ndviValues);
    const monthNames = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
    const monthAgg = {};
    for (const t of timeseries) {
      if (t.ndvi === null) continue;
      const mon = new Date(t.date).getMonth() + 1;
      if (!monthAgg[mon]) monthAgg[mon] = { sumNdvi: 0, sumSavi: 0, n: 0 };
      monthAgg[mon].sumNdvi += t.ndvi;
      if (t.savi !== null) monthAgg[mon].sumSavi += t.savi;
      monthAgg[mon].n++;
    }
    const monthlyPattern = Array.from({ length: 12 }, (_, i) => {
      const m = i + 1;
      const ag = monthAgg[m];
      const avgNdvi = ag && ag.n > 0 ? Number((ag.sumNdvi / ag.n).toFixed(3)) : null;
      const avgSavi = ag && ag.n > 0 && ag.sumSavi > 0 ? Number((ag.sumSavi / ag.n).toFixed(3)) : null;
      const isWindow = windows.some(w => w.date && new Date(w.date).getMonth() + 1 === m);
      const prevM = i > 0 ? i : 11;
      const prevAg = monthAgg[prevM + 1];
      const prevAvg = prevAg && prevAg.n > 0 ? prevAg.sumNdvi / prevAg.n : null;
      let monthTrend = 'sin_datos';
      if (avgNdvi !== null && prevAvg !== null) {
        const diff = avgNdvi - prevAvg;
        if (diff < -0.03) monthTrend = 'descendente';
        else if (diff > 0.03) monthTrend = 'creciente';
        else monthTrend = 'estable';
      }
      const nCount = ag ? ag.n : 0;
      return { month: m, label: monthNames[i], avgNdvi, avgSavi, n: nCount, isWindow, monthTrend };
    });
    const allN = monthlyPattern.map(p => p.n).filter(v => v > 0);
    const medianN = allN.length ? allN.sort((a, b) => a - b)[Math.floor(allN.length / 2)] : 0;
    const minN = Math.max(2, Math.ceil(medianN * 0.5));
    monthlyPattern.forEach(p => { p.lowData = p.n > 0 && p.n < minN; });
    const avgByMonth2 = {};
    monthlyPattern.forEach(p => { if (p.avgNdvi !== null) avgByMonth2[p.month] = p.avgNdvi; });
    monthlyPattern.forEach(p => {
      p.anomalousLow = false;
      if (p.avgNdvi === null || p.n < 2) return;
      const prev = p.month > 1 ? p.month - 1 : 12;
      const next = p.month < 12 ? p.month + 1 : 1;
      const neighbors = [avgByMonth2[prev], avgByMonth2[next]].filter(v => v !== undefined);
      if (neighbors.length) {
        const avgN = neighbors.reduce((a, b) => a + b, 0) / neighbors.length;
        if (avgN - p.avgNdvi > 0.12) p.anomalousLow = true;
      }
    });
    const rec = generateHerbicideRecommendation(trend, windows, ndviValues, monthlyPattern);
    const quota = await commitPolygon(req, res, m);
    res.json({ timeseries, smoothed, extrema, windows, monthlyPattern, trend, recommendation: rec, quota });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/v2/herbicide-soil — Fase 2: Validación logística (suelo/humedad) — S1+S2 combinado
app.post('/api/v2/herbicide-soil', async (req, res) => {
  try {
    const { coordinates, date, maxCloudCoverage = 30 } = req.body || {};
    if (!Array.isArray(coordinates) || coordinates.length < 3) return badParams(res, 'Faltan coordenadas del polígono.');
    if (!date) return badParams(res, 'Falta la fecha.');
    const ring = coordinates;
    const bbox = bboxOf(ring);
    if (!bbox) return badParams(res, 'BBOX inválido.');
    const { width, height } = imageSize(bbox);
    const m = await meterEndpoints(req, res, ring);
    if (!m) return;
    const ring2 = toRing(ring);
    const idx = maskIndices(width, height, bbox, ring2);
    const dt = new Date(date);
    const month = dt.getMonth() + 1;
    const year = dt.getFullYear();
    const s1Date = await findS1Date({ bbox, month, year });
    let vvMean = null, vhMean = null, ratioMean = null, ndviMean = null, saviMean = null, ndwiMean = null, ndreMean = null;
    let moistureLevel = 'desconocido', transitability = 'desconocido', recommendation = '';
    let sarFound = false, opticalFound = false;
    const promises = [];
    if (s1Date) {
      promises.push(
        fetchS1Sar({ ring: ring2, bbox, date: s1Date, width, height }).then(sar => {
          sarFound = true;
          const vvSt = statsOf(sar.vv, idx);
          const vhSt = statsOf(sar.vh, idx);
          const rSt = statsOf(sar.ratio, idx);
          vvMean = vvSt.mean !== null ? Number(vvSt.mean.toFixed(2)) : null;
          vhMean = vhSt.mean !== null ? Number(vhSt.mean.toFixed(2)) : null;
          ratioMean = rSt.mean !== null ? Number(rSt.mean.toFixed(2)) : null;
          if (vvMean !== null) { if (vvMean > -10) moistureLevel = 'saturado'; else if (vvMean > -12) moistureLevel = 'humedo'; else if (vvMean > -15) moistureLevel = 'normal'; else moistureLevel = 'seco'; }
          if (vvMean !== null) { if (vvMean > -10) transitability = 'no_transitable'; else if (vvMean > -12) transitability = 'marginal'; else transitability = 'transitable'; }
        }).catch(() => {})
      );
    }
    promises.push(
      fetchHerbicideMoisture({ ring: ring2, bbox, date, width, height }).then(img => {
        opticalFound = true;
        ndviMean = statsOf(img.ndvi, idx).mean !== null ? Number(((statsOf(img.ndvi, idx).mean * 2 - 1)).toFixed(3)) : null;
        saviMean = statsOf(img.savi, idx).mean !== null ? Number(((statsOf(img.savi, idx).mean * 2 - 1)).toFixed(3)) : null;
        ndwiMean = statsOf(img.ndwi, idx).mean !== null ? Number(((statsOf(img.ndwi, idx).mean * 2 - 1)).toFixed(3)) : null;
        ndreMean = statsOf(img.ndre, idx).mean !== null ? Number(((statsOf(img.ndre, idx).mean * 2 - 1)).toFixed(3)) : null;
      }).catch(() => {})
    );
    await Promise.all(promises);
    const source = sarFound && opticalFound ? 's1+s2' : sarFound ? 'sentinel-1' : 'sentinel-2';
    if (!sarFound && opticalFound) {
      if (ndwiMean !== null) { if (ndwiMean > 0.1) moistureLevel = 'humedo'; else if (ndwiMean > -0.1) moistureLevel = 'normal'; else moistureLevel = 'seco'; }
      transitability = 'solo_optico';
    }
    if (transitability === 'no_transitable') {
      recommendation = 'SAR: suelo saturado (VV > -10 dB). NO es seguro ingresar maquinaria.';
      if (ndwiMean !== null && ndwiMean < 0) recommendation += ' El NDWI óptico indica menos humedad en superficie, pero SAR confirma saturación del suelo.';
    } else if (transitability === 'marginal') {
      recommendation = 'SAR: suelo húmedo (VV -10 a -12 dB). Acceso marginal.';
      if (ndwiMean !== null && ndwiMean > 0.1) recommendation += ' NDWI también indica humedad alta. Considere espera.';
      else if (ndwiMean !== null && ndwiMean < -0.1) recommendation += ' NDWI indica superficie más seca, pero SAR detecta humedad subsuperficial.';
      else recommendation += ' Considere espera o maquinaria liviana.';
    } else if (transitability === 'transitable' && moistureLevel === 'seco') {
      recommendation = 'SAR: suelo seco (VV < -15 dB). Buena transitabilidad y absorción.';
    } else if (transitability === 'solo_optico') {
      if (ndwiMean !== null && ndwiMean > 0.1) recommendation = 'Óptico: humedad alta por NDWI. Puede dificultar absorción del herbicida.';
      else if (ndwiMean !== null && ndwiMean < -0.1) recommendation = 'Óptico: suelo seco por NDWI. Buena absorción estimada.';
      else recommendation = 'Óptico: condiciones normales por NDWI. Para transitabilidad real, use la comparación con S1.';
    } else if (moistureLevel !== 'desconocido') {
      recommendation = sarFound ? 'SAR: condiciones normales. Suelo apto para maquinaria.' : 'Condiciones de humedad normales.';
    }
    const quota = await commitPolygon(req, res, m);
    res.json({ source, vv: vvMean, vh: vhMean, sarRatio: ratioMean, ndvi: ndviMean, savi: saviMean, ndwi: ndwiMean, ndre: ndreMean, moistureLevel, transitability, recommendation, date, foundDate: sarFound && s1Date ? s1Date : date, quota });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/v2/herbicide-soil-typical — Fase 2b: condiciones típicas de un mes del año
app.post('/api/v2/herbicide-soil-typical', async (req, res) => {
  try {
    const { coordinates, month, maxCloudCoverage = 40 } = req.body || {};
    if (!Array.isArray(coordinates) || coordinates.length < 3) return badParams(res, 'Faltan coordenadas del polígono.');
    if (!month || month < 1 || month > 12) return badParams(res, 'Mes inválido (1-12).');
    const ring = coordinates;
    const bbox = bboxOf(ring);
    if (!bbox) return badParams(res, 'BBOX inválido.');
    const { width, height } = imageSize(bbox);
    const m = await meterEndpoints(req, res, ring);
    if (!m) return;
    const now = new Date();
    const year = now.getFullYear();
    const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
    const endDate = `${year}-${String(month).padStart(2, '0')}-${new Date(year, month, 0).getDate()}`;
    let foundDate = null;
    try {
      const data = await catalogSearch({ bbox, collections: ['sentinel-2-l2a'], datetime: `${startDate}T00:00:00Z/${endDate}T23:59:59Z`, limit: 50, filter: `eo:cloud_cover < ${maxCloudCoverage}` });
      if (data.features && data.features.length) {
        const dates = data.features.map(f => f.properties.datetime.split('T')[0]).sort();
        foundDate = dates[Math.floor(dates.length / 2)];
      }
    } catch (e) { /* noop */ }
    if (!foundDate) {
      const prevYear = year - 1;
      const sy2 = `${prevYear}-${String(month).padStart(2, '0')}-01`;
      const ey2 = `${prevYear}-${String(month).padStart(2, '0')}-${new Date(prevYear, month, 0).getDate()}`;
      try {
        const data2 = await catalogSearch({ bbox, collections: ['sentinel-2-l2a'], datetime: `${sy2}T00:00:00Z/${ey2}T23:59:59Z`, limit: 50, filter: `eo:cloud_cover < ${maxCloudCoverage}` });
        if (data2.features && data2.features.length) {
          const dates = data2.features.map(f => f.properties.datetime.split('T')[0]).sort();
          foundDate = dates[Math.floor(dates.length / 2)];
        }
      } catch (e2) { /* noop */ }
    }
    if (!foundDate) return res.json({ ndvi: null, savi: null, ndwi: null, ndre: null, moistureLevel: 'sin_datos', recommendation: 'No hay imágenes satelitales disponibles para este mes.', month, foundDate: null, quota: await commitPolygon(req, res, m) });
    const ring2 = toRing(ring);
    const idx = maskIndices(width, height, bbox, ring2);
    const img = await fetchHerbicideMoisture({ ring: ring2, bbox, date: foundDate, width, height });
    const ndviSt = statsOf(img.ndvi, idx);
    const saviSt = statsOf(img.savi, idx);
    const ndwiSt = statsOf(img.ndwi, idx);
    const ndreSt = statsOf(img.ndre, idx);
    const ndviMean = ndviSt.mean !== null ? Number(((ndviSt.mean * 2 - 1)).toFixed(3)) : null;
    const saviMean = saviSt.mean !== null ? Number(((saviSt.mean * 2 - 1)).toFixed(3)) : null;
    const ndwiMean = ndwiSt.mean !== null ? Number(((ndwiSt.mean * 2 - 1)).toFixed(3)) : null;
    const ndreMean = ndreSt.mean !== null ? Number(((ndreSt.mean * 2 - 1)).toFixed(3)) : null;
    let moistureLevel;
    if (ndwiMean !== null) {
      if (ndwiMean > 0.1) moistureLevel = 'humedo';
      else if (ndwiMean > -0.1) moistureLevel = 'normal';
      else moistureLevel = 'seco';
    } else moistureLevel = 'desconocido';
    let recommendation;
    if (moistureLevel === 'humedo') recommendation = 'Suelo húmedo: puede dificultar la absorción del herbicida. Considere esperar a condiciones más secas.';
    else if (moistureLevel === 'seco') recommendation = 'Suelo seco: buena absorción pero verifique que no haya estrés hídrico severo en la vegetación.';
    else recommendation = 'Condiciones de humedad normales: adecuadas para la aplicación de herbicida.';
    const quota = await commitPolygon(req, res, m);
    res.json({ ndvi: ndviMean, savi: saviMean, ndwi: ndwiMean, ndre: ndreMean, moistureLevel, recommendation, month, foundDate, quota });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/v2/herbicide-soil-compare — Fase 2c: S1 primario para transitabilidad, S2 fallback
app.post('/api/v2/herbicide-soil-compare', async (req, res) => {
  try {
    const { coordinates, months, maxCloudCoverage = 40 } = req.body || {};
    if (!Array.isArray(coordinates) || coordinates.length < 3) return badParams(res, 'Faltan coordenadas del polígono.');
    if (!Array.isArray(months) || !months.length) return badParams(res, 'Faltan los meses a comparar.');
    const ring = coordinates;
    const bbox = bboxOf(ring);
    if (!bbox) return badParams(res, 'BBOX inválido.');
    const { width, height } = imageSize(bbox);
    const m = await meterEndpoints(req, res, ring);
    if (!m) return;
    const now = new Date();
    const currentYear = now.getFullYear();
    const monthNames = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
    const results = [];
    for (const month of months) {
      if (month < 1 || month > 12) continue;
      let foundDate = null;
      let source = null;
      const s1Date = await findS1Date({ bbox, month, year: currentYear });
      if (s1Date) { foundDate = s1Date; source = 'sentinel-1'; }
      if (!foundDate) {
        const sy = `${currentYear}-${String(month).padStart(2, '0')}-01`;
        const ey = `${currentYear}-${String(month).padStart(2, '0')}-${new Date(currentYear, month, 0).getDate()}`;
        try {
          const data = await catalogSearch({ bbox, collections: ['sentinel-2-l2a'], datetime: `${sy}T00:00:00Z/${ey}T23:59:59Z`, limit: 50, filter: `eo:cloud_cover < ${maxCloudCoverage}` });
          if (data.features && data.features.length) { foundDate = data.features.map(f => f.properties.datetime.split('T')[0]).sort()[Math.floor(data.features.length / 2)]; source = 'sentinel-2'; }
        } catch (e) { /* noop */ }
      }
      if (!foundDate) {
        const py = currentYear - 1;
        const sy2 = `${py}-${String(month).padStart(2, '0')}-01`;
        const ey2 = `${py}-${String(month).padStart(2, '0')}-${new Date(py, month, 0).getDate()}`;
        try {
          const data2 = await catalogSearch({ bbox, collections: ['sentinel-2-l2a'], datetime: `${sy2}T00:00:00Z/${ey2}T23:59:59Z`, limit: 50, filter: `eo:cloud_cover < ${maxCloudCoverage}` });
          if (data2.features && data2.features.length) { foundDate = data2.features.map(f => f.properties.datetime.split('T')[0]).sort()[Math.floor(data2.features.length / 2)]; source = 'sentinel-2'; }
        } catch (e2) { /* noop */ }
      }
      if (!foundDate) { results.push({ month, label: monthNames[month - 1], source: null, vv: null, vh: null, sarRatio: null, ndvi: null, savi: null, ndwi: null, ndre: null, moistureLevel: 'sin_datos', transitability: 'desconocido', recommendation: 'Sin imágenes disponibles.', foundDate: null }); continue; }
      const ring2 = toRing(ring);
      const idx = maskIndices(width, height, bbox, ring2);
      let vvMean = null, vhMean = null, ratioMean = null, ndviMean = null, saviMean = null, ndwiMean = null, ndreMean = null;
      let moistureLevel, transitability, recommendation;
      if (source === 'sentinel-1') {
        const sar = await fetchS1Sar({ ring: ring2, bbox, date: foundDate, width, height });
        const vvSt = statsOf(sar.vv, idx);
        const vhSt = statsOf(sar.vh, idx);
        const rSt = statsOf(sar.ratio, idx);
        vvMean = vvSt.mean !== null ? Number(vvSt.mean.toFixed(2)) : null;
        vhMean = vhSt.mean !== null ? Number(vhSt.mean.toFixed(2)) : null;
        ratioMean = rSt.mean !== null ? Number(rSt.mean.toFixed(2)) : null;
        if (vvMean !== null) {
          if (vvMean > -10) moistureLevel = 'saturado';
          else if (vvMean > -12) moistureLevel = 'humedo';
          else if (vvMean > -15) moistureLevel = 'normal';
          else moistureLevel = 'seco';
        } else moistureLevel = 'desconocido';
        if (vvMean !== null) {
          if (vvMean > -10) transitability = 'no_transitable';
          else if (vvMean > -12) transitability = 'marginal';
          else transitability = 'transitable';
        } else transitability = 'desconocido';
        if (transitability === 'no_transitable') recommendation = 'SAR: suelo saturado (VV > -10 dB). NO es seguro ingresar maquinaria. Riesgo de compactación y encajamiento.';
        else if (transitability === 'marginal') recommendation = 'SAR: suelo húmedo (VV -10 a -12 dB). Acceso marginal. Considere espera o maquinaria liviana.';
        else if (moistureLevel === 'seco') recommendation = 'SAR: suelo seco (VV < -15 dB). Buena transitabilidad. Verifique que la vegetación no tenga estrés hídrico severo.';
        else recommendation = 'SAR: condiciones normales. Suelo apto para ingreso de maquinaria.';
      } else {
        const img = await fetchHerbicideMoisture({ ring: ring2, bbox, date: foundDate, width, height });
        const ndviSt = statsOf(img.ndvi, idx);
        const saviSt = statsOf(img.savi, idx);
        const ndwiSt = statsOf(img.ndwi, idx);
        const ndreSt = statsOf(img.ndre, idx);
        ndviMean = ndviSt.mean !== null ? Number(((ndviSt.mean * 2 - 1)).toFixed(3)) : null;
        saviMean = saviSt.mean !== null ? Number(((saviSt.mean * 2 - 1)).toFixed(3)) : null;
        ndwiMean = ndwiSt.mean !== null ? Number(((ndwiSt.mean * 2 - 1)).toFixed(3)) : null;
        ndreMean = ndreSt.mean !== null ? Number(((ndreSt.mean * 2 - 1)).toFixed(3)) : null;
        if (ndwiMean !== null) { if (ndwiMean > 0.1) moistureLevel = 'humedo'; else if (ndwiMean > -0.1) moistureLevel = 'normal'; else moistureLevel = 'seco'; }
        else moistureLevel = 'desconocido';
        transitability = 'solo_optico';
        recommendation = 'Óptico: humedad estimada por NDWI (no mide suelo directamente). Para transitabilidad real, se requiere Sentinel-1.';
      }
      results.push({ month, label: monthNames[month - 1], source, vv: vvMean, vh: vhMean, sarRatio: ratioMean, ndvi: ndviMean, savi: saviMean, ndwi: ndwiMean, ndre: ndreMean, moistureLevel, transitability, recommendation, foundDate });
    }
    const quota = await commitPolygon(req, res, m);
    res.json({ results, quota });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/v2/herbicide-effect — Fase 3: Seguimiento / efectividad (NDVI, SAVI, NDRE)
app.post('/api/v2/herbicide-effect', async (req, res) => {
  try {
    const { coordinates, dateBefore, dateAfter, maxCloudCoverage = 30 } = req.body || {};
    if (!Array.isArray(coordinates) || coordinates.length < 3) return badParams(res, 'Faltan coordenadas del polígono.');
    if (!dateBefore || !dateAfter) return badParams(res, 'Faltan las fechas antes/después.');
    const ring = coordinates;
    const bbox = bboxOf(ring);
    if (!bbox) return badParams(res, 'BBOX inválido.');
    const { width, height } = imageSize(bbox);
    const m = await meterEndpoints(req, res, ring);
    if (!m) return;
    const ring2 = toRing(ring);
    const idx = maskIndices(width, height, bbox, ring2);
    const img1 = await fetchHerbicideMoisture({ ring: ring2, bbox, date: dateBefore, width, height });
    const img2 = await fetchHerbicideMoisture({ ring: ring2, bbox, date: dateAfter, width, height });
    const ndviSt1 = statsOf(img1.ndvi, idx);
    const ndviSt2 = statsOf(img2.ndvi, idx);
    const saviSt1 = statsOf(img1.savi, idx);
    const saviSt2 = statsOf(img2.savi, idx);
    const ndreSt1 = statsOf(img1.ndre, idx);
    const ndreSt2 = statsOf(img2.ndre, idx);
    const ndviBefore = ndviSt1.mean !== null ? Number(((ndviSt1.mean * 2 - 1)).toFixed(3)) : null;
    const ndviAfter = ndviSt2.mean !== null ? Number(((ndviSt2.mean * 2 - 1)).toFixed(3)) : null;
    const saviBefore = saviSt1.mean !== null ? Number(((saviSt1.mean * 2 - 1)).toFixed(3)) : null;
    const saviAfter = saviSt2.mean !== null ? Number(((saviSt2.mean * 2 - 1)).toFixed(3)) : null;
    const ndreBefore = ndreSt1.mean !== null ? Number(((ndreSt1.mean * 2 - 1)).toFixed(3)) : null;
    const ndreAfter = ndreSt2.mean !== null ? Number(((ndreSt2.mean * 2 - 1)).toFixed(3)) : null;
    const delta = ndviBefore !== null && ndviAfter !== null ? Number((ndviAfter - ndviBefore).toFixed(3)) : null;
    const deltaSavi = saviBefore !== null && saviAfter !== null ? Number((saviAfter - saviBefore).toFixed(3)) : null;
    const deltaNdre = ndreBefore !== null && ndreAfter !== null ? Number((ndreAfter - ndreBefore).toFixed(3)) : null;
    let effectiveness;
    if (delta !== null) {
      if (delta < -0.15) effectiveness = 'efectivo';
      else if (delta < -0.05) effectiveness = 'parcial';
      else effectiveness = 'inefectivo';
    } else effectiveness = 'indefinido';
    let resistance = false;
    if (delta !== null && deltaSavi !== null && deltaNdre !== null) {
      const absDelta = Math.abs(delta);
      const absDeltaSavi = Math.abs(deltaSavi);
      const absDeltaNdre = Math.abs(deltaNdre);
      if (absDelta < 0.03 && absDeltaSavi < 0.03 && absDeltaNdre < 0.03) resistance = true;
    }
    const daysBetween = Math.round((new Date(dateAfter) - new Date(dateBefore)) / (1000 * 60 * 60 * 24));
    let t5Date = null, t15Date = null;
    if (dateBefore) {
      const d0 = new Date(dateBefore);
      const d5 = new Date(d0); d5.setDate(d5.getDate() + 5);
      const d15 = new Date(d0); d15.setDate(d15.getDate() + 15);
      t5Date = d5.toISOString().split('T')[0];
      t15Date = d15.toISOString().split('T')[0];
    }
    let advice;
    if (resistance) {
      advice = '⚠ Posible resistencia: NDVI, SAVI y NDRE muestran casi sin cambio (Δ < 0.03). Revise la dosificación, formulación del herbicida y timing de aplicación.';
    } else if (effectiveness === 'efectivo') {
      advice = 'Reducción significativa detectada en NDVI' + (deltaNdre !== null ? `, SAVI (Δ${deltaSavi > 0 ? '+' : ''}${deltaSavi}) y NDRE (Δ${deltaNdre > 0 ? '+' : ''}${deltaNdre})` : '') + '. El tratamiento fue efectivo.';
    } else if (effectiveness === 'parcial') {
      advice = 'Reducción moderada (NDVI Δ' + delta + '). Efecto parcial. ';
      if (daysBetween < 15) advice += 'Considere evaluación a T+15 días para ver efecto completo.';
      else advice += 'Considere una segunda aplicación.';
    } else if (effectiveness === 'inefectivo') {
      advice = 'Sin reducción significativa de NDVI (Δ' + delta + '). El tratamiento no fue efectivo. ';
      if (daysBetween < 7) advice += 'Es poco tiempo (<7 días). Evalúe a T+15.';
      else advice += 'Revise la dosificación, formulación o el momento de aplicación.';
    } else advice = 'No se pudo determinar la efectividad. Verifique la calidad de las imágenes.';
    const quota = await commitPolygon(req, res, m);
    res.json({ ndviBefore, ndviAfter, saviBefore, saviAfter, ndreBefore, ndreAfter, delta, deltaSavi, deltaNdre, effectiveness, resistance, daysBetween, t5Date, t15Date, advice, dateBefore, dateAfter, quota });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

if (require.main === module) {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Backend v2 listo en http://localhost:${PORT}`);
    console.log('🔑 CLIENT_ID:', process.env.CLIENT_ID ? 'cargado' : 'FALTA');
    console.log('🔐 CLIENT_SECRET:', process.env.CLIENT_SECRET ? 'cargado' : 'FALTA');
  });
}

module.exports = { monthKey, dayKey, usageOfMonth, polygonHash, meterPolygon, commitPolygon, db, admin, meteringEnabled, catalogSearch, fetchTrueColor, fetchTrueColorMasked, bboxOf, toRing, imageSize, maskIndices };
