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
async function catalogSearch({ bbox, collections, datetime, limit = 100, filter }) {
  const payload = { bbox, collections, datetime, limit };
  if (filter) payload.filter = filter;
  const r = await fetch(CATALOG_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${await getToken()}` },
    body: JSON.stringify(payload)
  });
  const text = await r.text();
  if (!r.ok) throw new Error('Catálogo: ' + text.slice(0, 300));
  return JSON.parse(text);
}

// ============================================================
// EVALUACIÓN ÓPTICA (NDVI + nubes SCL, un grupo DN)
// ============================================================
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

async function fetchOptical({ ring, bbox, date, width, height, maxCloud = 100 }) {
  const payload = {
    input: {
      bounds: { geometry: { type: 'Polygon', coordinates: [ring] } },
      data: [{ type: 'sentinel-2-l2a', dataFilter: { timeRange: { from: `${date}T00:00:00Z`, to: `${date}T23:59:59Z` }, maxCloudCoverage: maxCloud } }]
    },
    output: {
      width, height,
      responses: [{ identifier: 'res', format: { type: 'image/tiff' } }]
    },
    evalscript: OPTICAL_EVAL
  };
  const buf = await shFetch(payload);
  const { bands } = await parseTiff(buf);
  if (bands.length < 2) throw new Error('Respuesta óptica incompleta (bands=' + bands.length + ')');
  return { ndvi: bands[0].values, cloud: bands[1].values, width, height };
}

async function fetchTrueColor({ ring, bbox, date, width, height }) {
  const payload = {
    input: {
      bounds: { geometry: { type: 'Polygon', coordinates: [ring] } },
      data: [{ type: 'sentinel-2-l2a', dataFilter: { timeRange: { from: `${date}T00:00:00Z`, to: `${date}T23:59:59Z` }, maxCloudCoverage: 100 }, mosaicking: 'SCENE' }]
    },
    output: { width, height, bands: 3, format: 'image/png', crs: CRS },
    evalscript: `//VERSION=3
function setup() { return { input: ["B02","B03","B04"], output: { bands: 3, sampleType: "UINT8" } }; }
function evaluatePixel(sample) { return [2.5 * sample.B04 * 255, 2.5 * sample.B03 * 255, 2.5 * sample.B02 * 255]; }`
  };
  const buf = await shFetch(payload);
  return 'data:image/png;base64,' + buf.toString('base64');
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
  for (const f of data.features) {
    if (f.id.includes('1SDV') || f.id.includes('1SDH')) {
      return { date: f.properties.datetime.split('T')[0], id: f.id, pol: f.id.includes('1SDV') ? 'DV' : 'DH' };
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
  return { rvi: bands[0].values, width, height };
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
  if (v < 0.75) return [163, 217, 119];      // escasa
  if (v < 0.8) return [76, 175, 80];         // moderada
  return [20, 83, 45];                       // bosque denso
};
const colorRvi = (v) => {
  if (v < 0.15) return [37, 99, 235];
  if (v < 0.3) return [194, 178, 128];
  if (v < 0.5) return [163, 217, 119];
  if (v < 0.6) return [76, 175, 80];
  return [20, 83, 45];
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
  { id: 'sparse', label: 'Vegetación escasa', from: 0.68, to: 0.75, color: '#a3d977' },
  { id: 'moderate', label: 'Vegetación moderada', from: 0.75, to: 0.8, color: '#4caf50' },
  { id: 'dense', label: 'Bosque / vegetación densa', from: 0.8, to: Infinity, color: '#14532d' }
];
const RVI_CLASSES = [
  { id: 'water', label: 'Agua / sin vegetación', from: -Infinity, to: 0.15, color: '#2563eb' },
  { id: 'bare', label: 'Suelo desnudo', from: 0.15, to: 0.3, color: '#c2b280' },
  { id: 'grass', label: 'Vegetación escasa', from: 0.3, to: 0.5, color: '#a3d977' },
  { id: 'shrub', label: 'Vegetación moderada', from: 0.5, to: 0.6, color: '#4caf50' },
  { id: 'forest', label: 'Bosque / vegetación densa', from: 0.6, to: Infinity, color: '#14532d' }
];

// ============================================================
// RUTAS
// ============================================================
app.get('/', (req, res) => res.json({ name: 'ITP-EarthWatch API v2', status: 'ok' }));
app.get('/healthz', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));
app.post('/api/prueba', (req, res) => res.json({ ok: true, received: Object.keys(req.body || {}) }));

function badParams(res, msg) { return res.status(400).json({ error: msg }); }

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
    const data = await catalogSearch({
      bbox,
      collections: ['sentinel-2-l2a'],
      datetime: `${start.toISOString().split('T')[0]}T00:00:00Z/${now.toISOString().split('T')[0]}T23:59:59Z`,
      limit: 100,
      filter: `eo:cloud_cover < ${maxCloud}`
    });
    const seen = new Set();
    const dates = [];
    for (const f of data.features) {
      const d = f.properties.datetime.split('T')[0];
      if (seen.has(d)) continue;
      seen.add(d);
      dates.push({ date: d, cloudCover: Math.round(f.properties['eo:cloud_cover'] * 10) / 10 });
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
    const out = [];
    for (const d of dates) {
      try {
        const { ndvi, cloud } = await fetchOptical({ ring, bbox, date: d.date || d, width: size, height: size });
        const mask = maskIndices(size, size, bbox, ring);
        const cp = cloudPctOf(cloud, mask);
        out.push({ date: d.date || d, sceneCloud: d.cloudCover ?? null, polygonCloud: cp.cloudPct });
      } catch (e) {
        out.push({ date: d.date || d, sceneCloud: d.cloudCover ?? null, polygonCloud: null, error: e.message });
      }
    }
    res.json({ dates: out });
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
    const { width, height } = imageSize(bbox, 512);

    if (mode === 'truecolor') {
      const image = await fetchTrueColor({ ring, bbox, date, width, height });
      return res.json({ image, usedDate: date, bbox, width, height, mode });
    }

    // ---- NDVI (con o sin composite server-side) ----
    if (!composite || composite <= 0) {
      const { ndvi, cloud } = await fetchOptical({ ring, bbox, date, width, height });
      const mask = maskIndices(width, height, bbox, ring);
      const cp = cloudPctOf(cloud, mask);
      const st = statsOf(ndvi, mask);
      const hist = histogramOf(ndvi, mask, 60);
      const otsu = otsuFromHist(hist.counts, hist.total);
      const areaPx = areaPerPixel(bbox, width, height);
      const cls = classAreas(ndvi, mask, OPTICAL_CLASSES.map(c => ({ ...c })), areaPx);
      const image = toPng(ndvi, width, height, colorNdvi, mask);
      return res.json({
        image, usedDate: date, bbox, width, height, mode: 'ndvi',
        stats: { mean: st.mean, otsu },
        histogram: hist, areaPerPixel: areaPx, cloudPct: cp.cloudPct, classes: cls.classes, areaHa: cls.areaHa
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
        const { ndvi, cloud } = await fetchOptical({ ring, bbox, date: p.date, width, height });
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
    const cls = classAreas(median, mask, OPTICAL_CLASSES.map(c => ({ ...c })), areaPx);
    const image = toPng(median, width, height, colorNdvi, mask);
    const bestCloud = used.reduce((m, u) => (u.polygonCloud === null ? m : Math.min(m, u.polygonCloud)), 100);
    res.json({
      image, usedDate: date, usedDates: used, bbox, width, height, mode: 'ndvi', composite: true,
      stats: { mean: st.mean, otsu },
      histogram: hist, areaPerPixel: areaPx, cloudPct: bestCloud, classes: cls.classes, areaHa: cls.areaHa
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 4) Estadísticas radar (RVI + backscatter dB)
app.post('/api/v2/radar-stats', async (req, res) => {
  try {
    const ring = toRing(req.body.coordinates);
    const date = req.body.date;
    const bbox = bboxOf(ring);
    if (!ring || !bbox) return badParams(res, 'Parámetro coordinates inválido.');
    const { width, height } = imageSize(bbox, 512);
    let d = date;
    let pol = 'DV';
    let auto = false;
    if (!d) {
      const found = await findRadarDate(bbox);
      if (!found) return res.status(404).json({ error: 'No se encontraron escenas radar dual-pol en el área.' });
      d = found.date; pol = found.pol; auto = true;
    }
    let { rvi } = await fetchRvi({ ring, bbox, date: d, width, height, polarization: pol });
    const mask = maskIndices(width, height, bbox, ring);
    let st = statsOf(rvi, mask);
    if (st.n === 0 && !auto) {
      const near = await findRadarDateNear(bbox, d);
      if (near) {
        d = near.date;
        ({ rvi } = await fetchRvi({ ring, bbox, date: d, width, height, polarization: pol }));
        st = statsOf(rvi, mask);
      }
    }
    if (st.n === 0) return res.status(404).json({ error: 'No hay escenas radar válidas cerca de la fecha indicada.' });
    const hist = histogramOf(rvi, mask, 60);
    const otsu = otsuFromHist(hist.counts, hist.total);
    const areaPx = areaPerPixel(bbox, width, height);
    const cls = classAreas(rvi, mask, RVI_CLASSES.map(c => ({ ...c })), areaPx);
    const image = toPng(rvi, width, height, colorRvi, mask);
    let vvDb = null, vhDb = null;
    try {
      const db = await fetchBackscatterDb({ ring, bbox, date: d, width, height, polarization: pol });
      const svv = statsOf(db.vv, mask), svh = statsOf(db.vh, mask);
      vvDb = svv.mean; vhDb = svh.mean;
    } catch (e) { /* dB opcional */ }
    res.json({
      image, usedDate: d, polarization: pol, bbox, width, height,
      stats: { rviMean: st.mean, vvDb, vhDb, otsu },
      histogram: hist, areaPerPixel: areaPx, classes: cls.classes, areaHa: cls.areaHa
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
    const { width, height } = imageSize(bbox, 512);
    const mask = maskIndices(width, height, bbox, ring);

    const [o1, o2] = await Promise.all([
      fetchOptical({ ring, bbox, date: date1, width, height }),
      fetchOptical({ ring, bbox, date: date2, width, height })
    ]);
    const r1 = await findRadarDate(bbox);
    let radar = null;
    if (r1) {
      const r2 = await findRadarDateNear(bbox, date2);
      const pol = r1.pol;
      const [rad1, rad2] = await Promise.all([
        fetchRvi({ ring, bbox, date: r1.date, width, height, polarization: pol }),
        fetchRvi({ ring, bbox, date: (r2 || r1).date, width, height, polarization: pol })
      ]);
      radar = { rvi1: rad1.rvi, rvi2: rad2.rvi, date1: r1.date, date2: (r2 || r1).date, pol };
    }

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
    res.json({
      optical: { date1, date2, dNdviMean: mean(dNdvi), image: imgN },
      radar: radar ? { date1: radar.date1, date2: radar.date2, polarization: radar.pol, dRviMean: mean(dRvi), image: imgR } : null,
      agreement: {
        bothDecrease: agree.bothDecrease, bothIncrease: agree.bothIncrease, mixed: agree.mixed,
        validPixels: agree.valid, agreementPct
      },
      bbox, width, height
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
  for (const f of data.features) if (f.id.includes('1SDV') || f.id.includes('1SDH')) return { date: f.properties.datetime.split('T')[0], id: f.id };
  return null;
}

// 6) Serie temporal NDVI
app.post('/api/v2/ndvi-timeseries', async (req, res) => {
  try {
    const ring = toRing(req.body.coordinates);
    const maxDates = Math.min(Number(req.body.maxDates || 20), 30);
    const maxSceneCloud = Number(req.body.maxSceneCloud || 40);
    const bbox = bboxOf(ring);
    if (!ring || !bbox) return badParams(res, 'Parámetro coordinates inválido.');
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
        const { ndvi, cloud } = await fetchOptical({ ring, bbox, date: p.date, width: W, height: H });
        const cp = cloudPctOf(cloud, mask);
        const st = statsOf(ndvi, mask);
        series.push({ date: p.date, sceneCloud: Math.round(p.cloud * 10) / 10, polygonCloud: cp.cloudPct, ndviMean: st.mean });
      } catch (e) {
        series.push({ date: p.date, sceneCloud: p.cloud, polygonCloud: null, ndviMean: null, error: e.message });
      }
    }
    res.json({ series });
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
  const forestId = n - 1;
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
    if (i !== forestId) { lost += matrix[forestId][i]; gained += matrix[i][forestId]; }
  }
  const forest1 = toHa(cnt1[forestId]), forest2 = toHa(cnt2[forestId]);
  const codes = new Uint8Array(c1.length).fill(255);
  for (let k = 0; k < mask.length; k++) {
    const p = mask[k];
    const a = c1[p], b = c2[p];
    if (a === 255 || b === 255) continue;
    if (a === forestId && b !== forestId) codes[p] = 1;
    else if (a !== forestId && b === forestId) codes[p] = 2;
    else if (a !== b) codes[p] = 3;
    else codes[p] = 4;
  }
  return {
    rows,
    forest: {
      ha1: Math.round(forest1 * 100) / 100,
      ha2: Math.round(forest2 * 100) / 100,
      delta: Math.round((forest2 - forest1) * 100) / 100,
      deltaPct: forest1 ? Math.round(((forest2 - forest1) / forest1) * 1000) / 10 : null,
      lost: Math.round(toHa(lost) * 100) / 100,
      gained: Math.round(toHa(gained) * 100) / 100,
      net: Math.round(toHa(gained - lost) * 100) / 100
    },
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

// 8) Comparar superficies por categoría entre dos fechas
app.post('/api/v2/compare', async (req, res) => {
  try {
    const ring = toRing(req.body.coordinates);
    const date1 = req.body.date1, date2 = req.body.date2;
    const bbox = bboxOf(ring);
    if (!ring || !bbox || !date1 || !date2) return badParams(res, 'Faltan coordinates, date1 o date2.');
    const { width, height } = imageSize(bbox, 512);
    const mask = maskIndices(width, height, bbox, ring);
    const areaPx = areaPerPixel(bbox, width, height);

    const [o1, o2] = await Promise.all([
      fetchOptical({ ring, bbox, date: date1, width, height }),
      fetchOptical({ ring, bbox, date: date2, width, height })
    ]);
    const cls = OPTICAL_CLASSES.map(c => ({ ...c }));
    const c1 = classifyMasked(o1.ndvi, mask, cls);
    const c2 = classifyMasked(o2.ndvi, mask, cls);
    const cp1 = cloudPctOf(o1.cloud, mask), cp2 = cloudPctOf(o2.cloud, mask);
    const comp = compareCategories(c1, c2, mask, cls, areaPx);

    // Radar comparativo (si hay escenas cerca de ambas fechas)
    let radar = null;
    try {
      const r1 = await findRadarDateNear(bbox, date1);
      const r2 = await findRadarDateNear(bbox, date2);
      if (r1 && r2 && r1.date !== r2.date) {
        const [ra1, ra2] = await Promise.all([
          fetchRvi({ ring, bbox, date: r1.date, width, height, polarization: 'DV' }),
          fetchRvi({ ring, bbox, date: r2.date, width, height, polarization: 'DV' })
        ]);
        const rcls = RVI_CLASSES.map(c => ({ ...c }));
        const rc1 = classifyMasked(ra1.rvi, mask, rcls);
        const rc2 = classifyMasked(ra2.rvi, mask, rcls);
        const rcomp = compareCategories(rc1, rc2, mask, rcls, areaPx);
        radar = {
          date1: r1.date, date2: r2.date, polarization: 'DV',
          forest: rcomp.forest, classes: rcomp.rows,
          agreementPct: rcomp.agreementPct, changedPct: rcomp.changedPct,
          image1: toPng(rc1, width, height, colorClass(rcls), mask),
          image2: toPng(rc2, width, height, colorClass(rcls), mask),
          changeImage: toPng(rcomp.codes, width, height, colorChangeMap, mask)
        };
      }
    } catch (e) { /* radar opcional */ }

    res.json({
      optical: {
        date1, date2,
        cloudPct1: cp1.cloudPct, cloudPct2: cp2.cloudPct,
        forest: comp.forest,
        classes: comp.rows,
        agreementPct: comp.agreementPct, changedPct: comp.changedPct,
        areaPerPixel: areaPx,
        image1: toPng(c1, width, height, colorClass(cls), mask),
        image2: toPng(c2, width, height, colorClass(cls), mask),
        changeImage: toPng(comp.codes, width, height, colorChangeMap, mask)
      },
      radar,
      bbox, width, height
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Backend v2 listo en http://localhost:${PORT}`);
  console.log('🔑 CLIENT_ID:', process.env.CLIENT_ID ? 'cargado' : 'FALTA');
  console.log('🔐 CLIENT_SECRET:', process.env.CLIENT_SECRET ? 'cargado' : 'FALTA');
});
