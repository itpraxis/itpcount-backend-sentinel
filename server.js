// server.js (versión con monitoreo de Processing Units - PU y envío a Google Sheet)
require('dotenv').config();
console.log('🔑 xCLIENT_ID cargado:', process.env.CLIENT_ID ? '✅ Sí' : '❌ No');
console.log('🔐 xCLIENT_SECRET cargado:', process.env.CLIENT_SECRET ? '✅ Sí' : '❌ No');
const express = require('express');
const cors = require('cors');
const app = express();
// ✅ CORRECCIÓN 1: Middleware CORS al inicio ABSOLUTO
app.use(cors({
  origin: ['https://itpraxis.cl', 'https://www.itpraxis.cl'],
  credentials: true
}));
// ✅ CORRECCIÓN 2: Middleware de logging global (ANTES de express.json)
app.use((req, res, next) => {
  console.warn(`📥 Nueva solicitud entrante: ${req.method} ${req.originalUrl}`);
  next();
});
// ✅ CORRECCIÓN 3: Aumentar límite de JSON y manejar errores de parsing
app.use(express.json({ limit: '10mb' }));
// Manejo de errores de parsing de JSON
app.use((error, req, res, next) => {
  if (error instanceof SyntaxError && error.status === 400 && 'body' in error) {
    console.error('❌ Error al parsear el cuerpo de la solicitud:', error.message);
    return res.status(400).json({ error: 'Cuerpo de la solicitud inválido o demasiado grande.' });
  }
  next();
});
const port = process.env.PORT || 10000;
/*  */
// ==============================================
// ✅ NUEVA FUNCIÓN: Calcula y envía el consumo de PU a Google Sheets
// ==============================================
/**
 * Calcula y envía el consumo estimado de Processing Units (PU) para una solicitud al Process API.
 * @param {number} width - Ancho de la imagen solicitada (en píxeles).
 * @param {number} height - Alto de la imagen solicitada (en píxeles).
 * @param {number} bands - Número de bandas solicitadas.
 * @param {string} endpointName - Nombre del endpoint para identificar el uso en logs (ej: "NDVI", "TrueColor").
 */
async function logProcessingUnits(width, height, bands, endpointName = "Process API") {
    const pu = Math.ceil((width * height * bands) / (512 * 512));
    const logData = {
        endpointName,
        width,
        height,
        bands,
        pu,
        timestamp: new Date().toISOString()
    };
    // 1. Imprimir en consola (siempre visible en Render)
    console.log('📊 [PU Estimadas]', logData);
	/*
    // 2. Enviar a Google Sheet
    const SHEET_URL = 'https://script.google.com/macros/s/AKfycbxCgdiQmDnpis92rS7iIK0H_F_PwJ0SY9Y3NnueRgbtb0yKMvC9IGHIXpubgJUc4IieqA/exec';
    try {
        const response = await fetch(SHEET_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(logData)
        });
        // 3. Log del resultado de la solicitud
        if (response.ok) {
            console.log('✅ Log enviado correctamente a Google Sheet');
        } else {
            console.error('❌ Error al enviar a Google Sheet:', response.status, await response.text());
        }
    } catch (err) {
        console.error('⚠️ Excepción al enviar a Google Sheet:', err.message);
    }
	*/
}
// Función auxiliar para convertir polígono a bbox
const polygonToBbox = (coordinates) => {
    if (!coordinates || coordinates.length === 0 || !Array.isArray(coordinates[0])) {
        return null;
    }
    const polygonCoords = coordinates[0];
    if (!Array.isArray(polygonCoords)) {
        return null;
    }
    let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
    polygonCoords.forEach(coord => {
        if (Array.isArray(coord) && coord.length >= 2) {
            const [lon, lat] = coord;
            minLon = Math.min(minLon, lon);
            minLat = Math.min(minLat, lat);
            maxLon = Math.max(maxLon, lon);
            maxLat = Math.max(maxLat, lat);
        }
    });
    if (minLon === Infinity) {
        return null;
    }
    return [minLon, minLat, maxLon, maxLat];
};

// LÓGICA DE DETERMINACIÓN DE POLARIZACIÓN (FINAL Y ROBUSTA)
const determinePolarization = (id) => {
     // 1. DUAL (Clasificación RGB) - Buscar 1SDV o 1SDH
     if (id.includes('1SDV')) {
        return { primary: 'DV', mode: 'IW', bands: 3 }; 
    }
    if (id.includes('1SDH')) {
        return { primary: 'DH', mode: 'IW', bands: 3 }; 
    }
    // 2. SIMPLE (Visualización Escala de Grises) - Buscar 1SSV o 1SSH
    if (id.includes('1SSV')) {
        return { primary: 'VV', mode: 'IW', bands: 1 };
    }
    if (id.includes('1SSH')) {
        return { primary: 'HH', mode: 'IW', bands: 1 };
    }
    // 3. Fallback 
    return { primary: 'VV', mode: 'IW', bands: 1 }; 
};

// Función auxiliar para obtener fechas cercanas
const getNearbyDates = (baseDate, days) => {
    const dates = [];
    const d = new Date(baseDate);
    for (let i = 0; i <= days; i++) {
        const checkDate = new Date(d);
        checkDate.setDate(d.getDate() - i);
        const dateString = checkDate.toISOString().split('T')[0];
        if (dateString !== baseDate) {
            dates.push(dateString);
        }
    }
    return dates;
};
// ==============================================
// LÓGICA REUTILIZABLE
// ==============================================
/**
 * Obtiene el token de acceso de Sentinel-Hub.
 * @returns {string} El token de acceso.
 * @throws {Error} Si no se puede obtener el token.
 */
const getAccessToken = async () => {
    const body = new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: process.env.CLIENT_ID,
        client_secret: process.env.CLIENT_SECRET
    });
    const tokenResponse = await fetch('https://services.sentinel-hub.com/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString()
    });
    if (!tokenResponse.ok) {
        const error = await tokenResponse.text();
        throw new Error(`Error al obtener token: ${error}`);
    }
    const tokenData = await tokenResponse.json();
    return tokenData.access_token;
};
const getAvailableDates = async (bbox, maxCloudCoverage) => {
    try {
        const accessToken = await getAccessToken();
        const catalogUrl = 'https://services.sentinel-hub.com/api/v1/catalog/1.0.0/search';
        const now = new Date();
        const oneYearAgo = new Date();
        oneYearAgo.setFullYear(now.getFullYear() - 1);
        const startDate = oneYearAgo.toISOString().split('T')[0];
        const endDate = now.toISOString().split('T')[0];
        const payload = {
            "bbox": bbox,
            "datetime": `${startDate}T00:00:00Z/${endDate}T23:59:59Z`,
            "collections": ["sentinel-2-l2a"],
            "limit": 100,
            "filter": `eo:cloud_cover < ${maxCloudCoverage}`
        };
        console.log('Sending payload to catalog:', JSON.stringify(payload));
        const catalogResponse = await fetch(catalogUrl, {
            method: 'POST', 
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${accessToken}`
            },
            body: JSON.stringify(payload)
        });
        if (!catalogResponse.ok) {
            const error = await catalogResponse.text();
            throw new Error(`Error getting data from Catalog: ${error}`);
        }
        const catalogData = await catalogResponse.json();
        const availableDates = catalogData.features
            .map(feature => ({
                date: feature.properties.datetime.split('T')[0],
                cloudCover: feature.properties['eo:cloud_cover']
            }))
            .filter((value, index, self) => 
                self.findIndex(f => f.date === value.date) === index
            )
            .sort((a, b) => new Date(b.date) - new Date(a.date));
        return availableDates;
    } catch (error) {
        console.error('❌ Error in getAvailableDates:', error.message);
        return [];
    }
};
/**
 * Consulta el catálogo de Sentinel-1 para obtener fechas disponibles
 * en una región durante los últimos 12 meses.
 * @param {object} options.geometry Coordenadas GeoJSON del polígono.
 * @returns {Array<string>} Lista de fechas únicas en formato 'YYYY-MM-DD', ordenadas descendentemente.
 */
const getSentinel1Dates = async ({ geometry }) => {
    const accessToken = await getAccessToken();
    const bbox = polygonToBbox(geometry);
    if (!bbox) {
        throw new Error('No se pudo calcular el bounding box del polígono para buscar fechas S1.');
    }
    const today = new Date();
    const eighteenMonthsAgo = new Date();
    eighteenMonthsAgo.setMonth(today.getMonth() - 12);
    const datetimeRange = `${eighteenMonthsAgo.toISOString()}/${today.toISOString()}`;
    const catalogUrl = 'https://services.sentinel-hub.com/api/v1/catalog/1.0.0/search';
    // 🚩 CLAVE DE LA CORRECCIÓN: Definimos el payload base que se usará en TODAS las solicitudes POST.
    const basePayload = {
        "bbox": bbox,
        "datetime": datetimeRange,
        "collections": ["sentinel-1-grd"],
        "limit": 100 
    };
    let allFeatures = [];
    let nextUrl = catalogUrl;
    // 🚩 Usamos el payload base para la primera llamada.
    let payload = basePayload; 
    // Iteramos para manejar la paginación
    while (nextUrl) {
        // 🚩 Si nextUrl no es el catalogUrl base, debemos usar el endpoint base
        //    y añadir el token de paginación al cuerpo del POST.
        if (nextUrl !== catalogUrl) {
            // El API del Catálogo requiere que usemos el endpoint base para el POST,
            // y que el token de la URL 'next' se envíe en el cuerpo como 'next'.
            // 1. Extraemos el token 'next' de la URL de paginación
            const urlParams = new URLSearchParams(new URL(nextUrl).search);
            const nextToken = urlParams.get('next');
            // 2. Usamos el payload base y le añadimos la clave 'next' para la paginación
            payload = { 
                ...basePayload, // Mantiene 'collections', 'datetime', y 'bbox'
                "next": nextToken 
            };
            // 3. Reseteamos nextUrl a catalogUrl para que el fetch use el endpoint base
            nextUrl = catalogUrl;
        }
        const response = await fetch(nextUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${accessToken}`
            },
            body: JSON.stringify(payload)
        });
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Error en consulta al catálogo de S1: ${errorText}`);
        }
        const data = await response.json();
        allFeatures.push(...data.features);
        // Manejo de paginación (busca el link 'next')
        const nextLink = data.links.find(link => link.rel === 'next');
        if (nextLink) {
            nextUrl = nextLink.href; // La URL completa con el token 'next'
            // NO se resetea 'payload' aquí, se reconstruye al inicio del ciclo 'while'
        } else {
            nextUrl = null;
        }
        // Limitamos el total de tiles procesados
        if (allFeatures.length >= 500) break;
    }
    // Extraemos y filtramos las fechas únicas
    const uniqueDates = new Set();
    allFeatures.forEach(feature => {
        const datePart = feature.properties.datetime.split('T')[0];
        uniqueDates.add(datePart);
    });
    const sortedDates = Array.from(uniqueDates).sort().reverse();
    return sortedDates;
};
/**
 * ✅ NUEVA: Calcula el área aproximada de un polígono a partir de su bounding box y su relación de aspecto.
 * @param {array} bbox - [minLon, minLat, maxLon, maxLat]
 * @returns {object} Objeto con el área y la relación de aspecto: { area, aspectRatio }
 */
function calculatePolygonArea(bbox) {
    const [minLon, minLat, maxLon, maxLat] = bbox;
    // Aproximación usando la fórmula del área de un rectángulo en la superficie de la Tierra.
    // La precisión es suficiente para nuestro propósito de escalar la imagen.
    const earthRadius = 6371000; // Radio de la Tierra en metros
    const lat1Rad = minLat * Math.PI / 180;
    const lat2Rad = maxLat * Math.PI / 180;
    const deltaLat = (maxLat - minLat) * Math.PI / 180;
    const deltaLon = (maxLon - minLon) * Math.PI / 180;
    // Área = (R^2) * Δλ * (sin(φ2) - sin(φ1))
    const area = Math.pow(earthRadius, 2) * deltaLon * (Math.sin(lat2Rad) - Math.sin(lat1Rad));
    // Calcular la relación de aspecto (ancho/altura)
    const aspectRatio = deltaLon / deltaLat;
    return {
        area: Math.abs(area),
        aspectRatio: aspectRatio
    };
}
/**
 * ✅ MODIFICADA: Calcula el tamaño óptimo de la imagen en píxeles, manteniendo la relación de aspecto del polígono.
 * @param {number} areaInSquareMeters - Área del polígono en metros cuadrados.
 * @param {number} resolutionInMeters - Resolución deseada en metros por píxel.
 * @param {number} aspectRatio - Relación de aspecto del polígono (ancho/altura).
 * @returns {object} Objeto con las dimensiones en píxeles: { width, height }
 */
function calculateOptimalImageSize(areaInSquareMeters, resolutionInMeters, aspectRatio = 1) {
    // Calcular la longitud del lado de un cuadrado con el mismo área
    const sideLengthInMeters = Math.sqrt(areaInSquareMeters);
    // Calcular el número de píxeles necesarios para cubrir ese lado
    let baseSizeInPixels = Math.round(sideLengthInMeters / resolutionInMeters);
    // Asegurar que el tamaño mínimo sea 128 píxeles y máximo 2048
    baseSizeInPixels = Math.max(128, Math.min(2048, baseSizeInPixels));
    // Calcular width y height basado en la relación de aspecto
    let width, height;
    if (aspectRatio > 1) {
        // El polígono es más ancho que alto
        width = Math.round(baseSizeInPixels * Math.sqrt(aspectRatio));
        height = Math.round(width / aspectRatio);
    } else {
        // El polígono es más alto que ancho o es cuadrado
        height = Math.round(baseSizeInPixels * Math.sqrt(1 / aspectRatio));
        width = Math.round(height * aspectRatio);
    }
    return {
        width: Math.max(128, Math.min(2048, width)),
        height: Math.max(128, Math.min(2048, height))
    };
}
/**
 * Intenta obtener una imagen de Sentinel-Hub con reintentos.
 * @param {object} params - Parámetros de la solicitud.
 * @param {array} params.geometry - Coordenadas del polígono o bbox.
 * @param {string} params.date - Fecha inicial.
 * @param {string} params.geometryType - 'Polygon' o 'bbox'.
 * @returns {object} Un objeto con la URL de la imagen y la fecha utilizada.
 * @throws {Error} Si no se encuentra una imagen después de todos los reintentos.
 */
const fetchSentinelImage = async ({ geometry, date, geometryType = 'Polygon' }) => {
    const accessToken = await getAccessToken();
    // ✅ NUEVO: Calcular el bbox y el área para determinar el tamaño óptimo
    const bbox = geometryType === 'Polygon' ? polygonToBbox(geometry) : geometry;
    if (!bbox) {
        throw new Error('No se pudo calcular el bounding box.');
    }
    const areaResult = calculatePolygonArea(bbox);
    const areaInSquareMeters = areaResult.area;
    const aspectRatio = areaResult.aspectRatio;
    const sizeInPixels = calculateOptimalImageSize(areaInSquareMeters, 10, aspectRatio); // 10m de resolución
    const width = sizeInPixels.width;
    const height = sizeInPixels.height;
    // 🔹 REGISTRO DE PU
    // logProcessingUnits(width, height, 1, "NDVI");
    const payload = {
        input: {
            bounds: geometryType === 'Polygon' ? { geometry: { type: "Polygon", coordinates: geometry } } : { bbox: geometry },
            data: [
                {
                    dataFilter: {
                        timeRange: { from: `${date}T00:00:00Z`, to: `${date}T23:59:59Z` },
                        maxCloudCoverage: 100
                    },
                    type: "sentinel-2-l2a"
                }
            ]
        },
        output: {
            width: width, // ✅ Tamaño adaptativo
            height: height, // ✅ Tamaño adaptativo
            format: "image/png",
            upsampling: "NEAREST",
            downsampling: "NEAREST",
            bands: 1,
            sampleType: "UINT8", // ⬅️ CORRECCIÓN: Cambiado de AUTO a UINT8 para imágenes
            // ✅ CORRECCIÓN CLAVE: Forzar proyección WGS84
            crs: "http://www.opengis.net/def/crs/OGC/1.3/CRS84"			
        },
        evalscript: `
            //VERSION=3
            function setup() {
                return {
                    input: [{ bands: ["B08", "B04"], units: "REFLECTANCE" }],
                    output: { bands: 1 }
                };
            }
            function evaluatePixel(samples) {
                const nir = samples.B08;
                const red = samples.B04;
                const ndvi = (nir - red) / (nir + red);
                const normalizedNdvi = (ndvi + 1) / 2;
                return [normalizedNdvi];
            }
        `
    };
    const imageResponse = await fetch('https://services.sentinel-hub.com/api/v1/process', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${accessToken}`
        },
        body: JSON.stringify(payload)
    });
    if (!imageResponse.ok) {
        const error = await imageResponse.text();
        console.error('❌ Error de la API de Sentinel-Hub:', error);
        throw new Error(`Error en la imagen para ${date}: ${error}`);
    }
    const buffer = await imageResponse.arrayBuffer();
    const base64 = Buffer.from(buffer).toString('base64');
    return {
        url: `data:image/png;base64,${base64}`,
        usedDate: date,
        bbox: bbox, // ✅ Usamos el bbox calculado
		width: width,   // <-- Añade esta línea
		height: height   // <-- Añade esta línea		
    };
};
/**
 * Intenta obtener una imagen de Sentinel-Hub con reintentos.
 * @param {object} params - Parámetros de la solicitud.
 * @param {array} params.geometry - Coordenadas del polígono o bbox.
 * @param {string} params.date - Fecha inicial.
 * @param {string} params.geometryType - 'Polygon' o 'bbox'.
 * @returns {object} Un objeto con la URL de la imagen y la fecha utilizada.
 * @throws {Error} Si no se encuentra una imagen después de todos los reintentos.
 */
const fetchSentinelImageTC = async ({ geometry, date, geometryType = 'Polygon' }) => {
    const accessToken = await getAccessToken();
    // Calcular el bbox y el área para determinar el tamaño óptimo
    const bbox = geometryType === 'Polygon' ? polygonToBbox(geometry) : geometry;
    if (!bbox) {
        throw new Error('No se pudo calcular el bounding box.');
    }
    const areaResult = calculatePolygonArea(bbox);
    const areaInSquareMeters = areaResult.area;
    const aspectRatio = areaResult.aspectRatio;
    const sizeInPixels = calculateOptimalImageSize(areaInSquareMeters, 10, aspectRatio); // 10m de resolución
    const width = sizeInPixels.width;
    const height = sizeInPixels.height;
    // 🔹 REGISTRO DE PU
    // logProcessingUnits(width, height, 3, "TrueColor");
    const payload = {
        input: {
            bounds: geometryType === 'Polygon'
                ? { geometry: { type: "Polygon", coordinates: geometry } }
                : { bbox: geometry },
            data: [
                {
                    type: "sentinel-2-l2a",
                    dataFilter: {
                        timeRange: { from: `${date}T00:00:00Z`, to: `${date}T23:59:59Z` },
                        maxCloudCoverage: 20
                    },
                    mosaicking: "SCENE"
                }
            ]
        },
        output: {
            width: width,
            height: height,
            // ✅ CORRECCIÓN CLAVE: Forzar proyección WGS84
            crs: "http://www.opengis.net/def/crs/OGC/1.3/CRS84"			
        },
        evalscript: `//VERSION=3
function setup() {
  return {
    input: ["B02", "B03", "B04"],
    output: { bands: 3, sampleType: "UINT8" }
  };
}
function evaluatePixel(sample) {
  return [2.5 * sample.B04 * 255, 2.5 * sample.B03 * 255, 2.5 * sample.B02 * 255];
}
`
    };
    const imageResponse = await fetch('https://services.sentinel-hub.com/api/v1/process', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${accessToken}`
        },
        body: JSON.stringify(payload)
    });
    if (!imageResponse.ok) {
        const error = await imageResponse.text();
        console.error('❌ Error en la API de Sentinel-Hub:', error);
        throw new Error(`Error en la imagen para ${date}: ${error}`);
    }
    const buffer = await imageResponse.arrayBuffer();
    const base64 = Buffer.from(buffer).toString('base64');
    return {
        url: `data:image/png;base64,${base64}`,
        usedDate: date,
        bbox: bbox,
		width: width,   // <-- Añade esta línea
		height: height   // <-- Añade esta línea				
    };
};
// ==============================================
// FUNCIÓN AUXILIAR: Genera el evalscript para clasificación RGB
// ==============================================
// /**
//  * Genera el evalscript apropiado (RGB para clasificación o Monobanda para visualización).
//  * @param {string} polarization La polarización a usar ('DV', 'DH', 'VV', 'HH', etc.)
//  * @returns {string} El evalscript correspondiente.
//  */
const getClassificationEvalscript = (polarization) => {
    // Rango de contraste definitivo para garantizar VISIBILIDAD
    const min_db_visible = -80; 
    const max_db = 5; 
    if (polarization === 'DV' || polarization === 'DH') {
        // --- Script DUAL (RGB para clasificación) ---
        return `//VERSION=3
function setup() {
  return {
    input: [{ bands: ["VV", "VH", "dataMask"], units: "LINEAR_POWER" }],
    output: { bands: 3, sampleType: "UINT8", format: "image/png" }
  };
}
function evaluatePixel(samples) {
  let vv = samples.VV;
  let vh = samples.VH;
  let dm = samples.dataMask;
  if (vv <= 0 || vh <= 0 || dm === 0) {
    return [0, 0, 0];
  }
  let vv_db = 10 * Math.log10(vv);
  let vh_db = 10 * Math.log10(vh);
  const min_db = ${min_db_visible}; 
  const normalize = (value) => Math.max(0, Math.min(1, (value - min_db) / (${max_db} - min_db)));
  let vv_norm = normalize(vv_db);
  let vh_norm = normalize(vh_db);
  let ratio_db = vv_db - vh_db;
  let ratio_norm = Math.max(0, Math.min(1, ratio_db / 20)); 
  let r = vv_norm * 255;
  let g = vh_norm * 255;
  let b = ratio_norm * 255;
  return [r, g, b];
}`;
    } else {
        // --- Script SIMPLE (Monobanda, con -80 dB para visibilidad y SIN dataMask) ---
        const band = polarization === 'VV' || polarization === 'VH' ? polarization : 'VV';
        return `//VERSION=3
function setup() {
    return {
        input: [{ bands: ["${band}"], units: "LINEAR_POWER" }],
        output: { bands: 1, sampleType: "UINT8", format: "image/png" }
    };
}
function evaluatePixel(samples) {
    const linearValue = samples.${band};
    if (linearValue <= 0) { 
        return [0];
    }
    const dbValue = 10 * Math.log10(linearValue);
    const minDb = ${min_db_visible}; 
    const maxDb = ${max_db};
    let mappedValue = (dbValue - minDb) / (maxDb - minDb) * 255;
    mappedValue = Math.max(0, Math.min(255, mappedValue));
    return [mappedValue];
}`;
    }
};
// ==============================================
// FUNCIÓN PRINCIPAL MODIFICADA (fetchSentinel1Radar) Gemini
// ==============================================
const fetchSentinel1Radar = async ({ geometry, date }) => {
    // Declaración de variables clave fuera del try para corrección de alcance (scope)
    let foundDate;
    let tileId;
    let pol;
    let finalPolarization;
    const accessToken = await getAccessToken();
    const bbox = polygonToBbox(geometry);
    if (!bbox) {
        throw new Error('No se pudo calcular el bounding box del polígono.');
    }
    try {
        const areaResult = calculatePolygonArea(bbox);
        const areaInSquareMeters = areaResult.area;
        const aspectRatio = areaResult.aspectRatio;
        const sizeInPixels = calculateOptimalImageSize(areaInSquareMeters, 10, aspectRatio);
        const width = sizeInPixels.width;
        const height = sizeInPixels.height;
        // CLAVE: CÓDIGO DEL CATÁLOGO REINSERTADO
        const fromDate = new Date(date);
        const toDate = new Date(date);
        // fromDate.setDate(fromDate.getDate() - 30);
        // toDate.setDate(toDate.getDate() + 7);
        fromDate.setDate(fromDate.getDate() - 0);
        toDate.setDate(toDate.getDate() + 0);
        const catalogUrl = 'https://services.sentinel-hub.com/api/v1/catalog/1.0.0/search';
        const catalogPayload = {
            "bbox": bbox,
            "datetime": `${fromDate.toISOString().split('T')[0]}T00:00:00Z/${toDate.toISOString().split('T')[0]}T23:59:59Z`,
            "collections": ["sentinel-1-grd"],
            "limit": 10
            // "limit": 1
        };
        // FIN CÓDIGO DEL CATÁLOGO
        const catalogResponse = await fetch(catalogUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${accessToken}`
            },
            body: JSON.stringify(catalogPayload)
        });
        if (!catalogResponse.ok) {
            const errorText = await catalogResponse.text();
            throw new Error(`Error en consulta al catálogo: ${errorText}`);
        }
        const catalogData = await catalogResponse.json();
        if (catalogData.features.length === 0) {
            throw new Error("No se encontraron datos de Sentinel-1 para esta ubicación.");
        }
        const feature = catalogData.features[0];
        foundDate = feature.properties.datetime.split('T')[0];
        tileId = feature.id;

        pol = determinePolarization(tileId);
        finalPolarization = pol.primary;
        // 🔹 REGISTRO DE PU
        // logProcessingUnits(width, height, pol.bands, `Sentinel1Radar (${pol.primary})`);
        const tryRequest = async () => {
            const evalscript = getClassificationEvalscript(finalPolarization); 
            const outputBands = pol.bands;
            const payload = {
                input: {
                    bounds: {
                        geometry: {
                            type: "Polygon",
                            coordinates: geometry
                        }
                    },
                    data: [{
                        dataFilter: {
                            timeRange: {
                                from: `${foundDate}T00:00:00Z`,
                                to: `${foundDate}T23:59:59Z`
                            },
                            polarization: finalPolarization, 
                            instrumentMode: pol.mode
                        },
                        processing: {
                            mosaicking: "ORBIT"
                        },
                        type: "sentinel-1-grd"
                    }]
                },
                output: {
                    width: width,
                    height: height,
                    format: "image/png",
                    sampleType: "UINT8",
                    bands: outputBands ,
					// ✅ CORRECCIÓN CLAVE: Forzar proyección WGS84
					crs: "http://www.opengis.net/def/crs/OGC/1.3/CRS84"
                },
                evalscript: evalscript
            };
            const imageResponse = await fetch('https://services.sentinel-hub.com/api/v1/process', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${accessToken}`
                },
                body: JSON.stringify(payload)
            });
            if (!imageResponse.ok) {
                const errorText = await imageResponse.text();
                throw new Error(`Solicitud con polarización ${finalPolarization} falló: ${errorText}`);
            }
            return imageResponse;
        };
        const response = await tryRequest();
        const buffer = await response.arrayBuffer();
        const base64 = Buffer.from(buffer).toString('base64');
        const classificationStatus = pol.bands === 3 ? "Clasificación RGB (Dual)" : "Escala de Grises (Simple)";
        return {
            url: `data:image/png;base64,${base64}`,
            usedDate: foundDate,
            polarization: finalPolarization,
            sourceTile: tileId,
            status: classificationStatus,
			bbox: bbox,
			width: width,     // <-- Añadido
			height: height    // <-- Añadido
        };
    } catch (error) {
        console.error('❌ Error en la imagen Sentinel-1 (Final):', error.message);
        throw error;
    }
};
// ==============================================
// FUNCIÓN AUXILIAR: Genera el evalscript para CLASIFICACIÓN 5-CLASES
// ==============================================
/**
 * Genera el evalscript para la clasificación de 5 clases de cobertura Sentinel-1 (VV/VH).
 * Clases: 1=Agua, 2=Suelo/Urbano, 3=Vegetación Baja, 4=Bosque, 5=Vegetación Densa.
 * @returns {string} El evalscript correspondiente.
 */
// ==============================================
// FUNCIÓN AUXILIAR: Evalscript para CLASIFICACIÓN 5-CLASES (CORREGIDO)
// ==============================================
/**
 * Genera el evalscript para la clasificación de 5 clases de cobertura Sentinel-1 (VV/VH).
 * Clases: 1=Agua, 2=Suelo/Urbano, 3=Vegetación Baja, 4=Bosque, 5=Vegetación Densa.
 * La salida se escala por 50 para asegurar visibilidad en UINT8.
 */
const getClassification5ClassesEvalscript = () => {
    // Usamos el modo Dual (VH y VV) ya que es necesario para la clasificación estructural.
    return `//VERSION=3
function setup() {
  return {
    input: [{ bands: ["VV", "VH", "dataMask"], units: "LINEAR_POWER" }],
    // Salida de 1 banda, UINT8 para la clase (0-5)
    output: { bands: 1, sampleType: "UINT8", format: "image/png" }
  };
}
function evaluatePixel(samples) {
  let vv = samples.VV;
  let vh = samples.VH;
  let dm = samples.dataMask;
  if (dm === 0) {
    return [0]; // CLASE 0: Sin Datos / Área No Válida
  }
  // Verificar si hay valores inválidos antes de log10
  if (vv <= 0 || vh <= 0) {
      return [0];
  }
  // Convertir a Decibelios
  let vv_db = 10 * Math.log10(vv);
  let vh_db = 10 * Math.log10(vh);
  // --- CLASIFICACIÓN SECUENCIAL (Cascada) ---
  let classification_class = 2; // Valor por defecto: Suelo Desnudo / Urbano (Clase 2)
  // 1. CLASE 1: Agua Tranquila
  if (vv_db < -20.0 && vh_db < -25.0) {
      classification_class = 1;
  }
  // 2. CLASE 5: Vegetación Densa
  else if (vh_db > -15.0) {
      classification_class = 5; 
  }
  // 3. CLASE 4: Bosque
  else if (vh_db > -18.0) {
      classification_class = 4;
  }
  // 4. CLASE 3: Vegetación Baja
  else if (vv_db < -14.0 && vh_db > -22.0) {
      classification_class = 3; 
  }
  // 5. CLASE 2: Suelo Desnudo / Urbano (Else block)
  else {
      classification_class = 2;
  }
  // 🚨 CORRECCIÓN CLAVE: Multiplicar por 50 para hacer la imagen VISIBLE.
  // La clase 5 será 250, y la clase 1 será 50.
  return [classification_class * 50]; 
}`;
};


/**
 * Genera el evalscript para la clasificación de 5 clases de cobertura Sentinel-1 (VV/VH).
 * Clases: 1=Agua Tranquila, 2=Suelo/Urbano, 3=Vegetación Baja, 4=Bosque, 5=Vegetación Densa.
 * La salida se escala por 50 para hacerla VISIBLE en UINT8.
 */
const getClassification5ClassesEvalscript2 = () => {
    // Usamos el modo Dual (VH y VV) ya que es necesario para la clasificación estructural.
    return `//VERSION=3
function setup() {
  return {
    input: [{ bands: ["VV", "VH", "dataMask"], units: "LINEAR_POWER" }],
    // Salida de 1 banda, UINT8 para la clase (0-5)
    output: { bands: 1, sampleType: "UINT8", format: "image/png" }
  };
}
function evaluatePixel(samples) {
  let vv = samples.VV;
  let vh = samples.VH;
  let dm = samples.dataMask;
  if (dm === 0) {
    return [0]; // CLASE 0: Sin Datos / Área No Válida
  }
  // Verificar si hay valores inválidos antes de log10
  if (vv <= 0 || vh <= 0) { 
    return [0];
  }
  // Convertir a Decibelios
  let vv_db = 10 * Math.log10(vv);
  let vh_db = 10 * Math.log10(vh);

  // --- CLASIFICACIÓN SECUENCIAL (Cascada) - AJUSTADA ---
  let classification_class = 2; // Valor por defecto: Suelo Desnudo / Urbano (Clase 2)

  // 1. CLASE 1: Agua Tranquila (MUY BAJA retrodispersión)
  //   - Umbral muy bajo para evitar falsos positivos
  if (vv_db < -22.0 && vh_db < -27.0) {
      classification_class = 1;
  }
  // 2. CLASE 5: Vegetación Densa (ALTA retrodispersión y alto ratio VV/VH)
  //   - Este es el cambio clave: ahora requiere VH > -12.0 y un ratio mayor
  else if (vh_db > -12.0 && (vv_db - vh_db) > 0.5) {
      classification_class = 5; 
  }
  // 3. CLASE 4: Bosque (ALTA retrodispersión pero con ratio menor)
  //   - Se mantiene similar, pero con un umbral ligeramente más alto para VH
  else if (vh_db > -16.0 && (vv_db - vh_db) > 0.0) {
      classification_class = 4;
  }
  // 4. CLASE 3: Vegetación Baja (RETRODISPERSIÓN MODERADA)
  //   - Este es otro cambio clave: ampliamos el rango para capturar más vegetación baja
  else if (vh_db > -20.0 && vv_db < -14.0) {
      classification_class = 3; 
  }
  // 5. CLASE 2: Suelo Desnudo / Urbano (RESTO)
  //   - Ya está como default, no necesitamos un else
  // else {
  //     classification_class = 2;
  // }

  // 🚨 CORRECCIÓN CLAVE: Multiplicar por 50 para hacer la imagen VISIBLE.
  // La clase 5 será 250, y la clase 1 será 50.
  return [classification_class * 50]; 
}`;
};




// ==============================================
// FUNCIÓN PRINCIPAL para CLASIFICACIÓN 5-CLASES
// ==============================================
/**
 * Obtiene la imagen de clasificación de 5 clases para Sentinel-1.
 * (Copia de fetchSentinel1Radar pero usando el nuevo evalscript y forzando salida de 1 banda).
 */
const fetchSentinel1Classification = async ({ geometry, date }) => {
    // Declaración de variables clave (Reutiliza tu lógica)
    let foundDate;
    let tileId;
    let pol;
    const accessToken = await getAccessToken();
    const bbox = polygonToBbox(geometry);
    if (!bbox) {
        throw new Error('No se pudo calcular el bounding box del polígono.');
    }
    try {
        const areaResult = calculatePolygonArea(bbox);
        const areaInSquareMeters = areaResult.area;
        const aspectRatio = areaResult.aspectRatio;
        const sizeInPixels = calculateOptimalImageSize(areaInSquareMeters, 10, aspectRatio);
        const width = sizeInPixels.width;
        const height = sizeInPixels.height;
        // 🔹 REGISTRO DE PU
        // logProcessingUnits(width, height, 1, "Sentinel1-Classification-5Clases");
        // Búsqueda en el Catálogo (Mismo proceso que el original)
        const fromDate = new Date(date);
        const toDate = new Date(date);
        fromDate.setDate(fromDate.getDate() - 0); // Buscar solo en la fecha
        toDate.setDate(toDate.getDate() + 0);
        const catalogUrl = 'https://services.sentinel-hub.com/api/v1/catalog/1.0.0/search';
        const catalogPayload = {
            "bbox": bbox,
            "datetime": `${fromDate.toISOString().split('T')[0]}T00:00:00Z/${toDate.toISOString().split('T')[0]}T23:59:59Z`,
            "collections": ["sentinel-1-grd"],
            "limit": 10
        };
        const catalogResponse = await fetch(catalogUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${accessToken}`
            },
            body: JSON.stringify(catalogPayload)
        });
        if (!catalogResponse.ok) {
            const errorText = await catalogResponse.text();
            throw new Error(`Error en consulta al catálogo: ${errorText}`);
        }
        const catalogData = await catalogResponse.json();
        if (catalogData.features.length === 0) {
            throw new Error("No se encontraron datos de Sentinel-1 para esta ubicación.");
        }
        const feature = catalogData.features[0];
        foundDate = feature.properties.datetime.split('T')[0];
        tileId = feature.id;
        // Determinación de Polarización (usamos la lógica original pero solo para obtener la fecha/tile)
        const determinePolarization = (id) => {
            if (id.includes('1SDV')) return { primary: 'DV', mode: 'IW', bands: 3 };
            if (id.includes('1SDH')) return { primary: 'DH', mode: 'IW', bands: 3 };
            if (id.includes('1SSV')) return { primary: 'VV', mode: 'IW', bands: 1 };
            if (id.includes('1SSH')) return { primary: 'HH', mode: 'IW', bands: 1 };
            return { primary: 'VV', mode: 'IW', bands: 1 };
        };
        pol = determinePolarization(tileId);
        // Usamos Dual Pol para la clasificación, independientemente de lo que determine el tile:
        const finalPolarization = pol.primary.includes('D') ? pol.primary : 'DV'; // Forzamos a DV/DH
        const tryRequest = async () => {
            // 🚨 CAMBIO CLAVE: Usamos el nuevo Evalscript.
            const evalscript = getClassification5ClassesEvalscript2(); 
            const outputBands = 1; // 🚨 CLAVE: Siempre 1 banda para clasificación.
            const payload = {
                input: {
                    bounds: {
                        geometry: {
                            type: "Polygon",
                            coordinates: geometry
                        }
                    },
                    data: [{
                        dataFilter: {
                            timeRange: {
                                from: `${foundDate}T00:00:00Z`,
                                to: `${foundDate}T23:59:59Z`
                            },
                            // Aseguramos la polarización Dual para el evalscript de 5 clases.
                            polarization: 'DV', 
                            instrumentMode: pol.mode
                        },
                        processing: {
                            mosaicking: "ORBIT"
                        },
                        type: "sentinel-1-grd"
                    }]
                },
                output: {
                    width: width,
                    height: height,
                    format: "image/png",
                    sampleType: "UINT8",
                    bands: outputBands,
					// ✅ CORRECCIÓN CLAVE: Forzar proyección WGS84
					crs: "http://www.opengis.net/def/crs/OGC/1.3/CRS84"
                },
                evalscript: evalscript
            };
            const imageResponse = await fetch('https://services.sentinel-hub.com/api/v1/process', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${accessToken}`
                },
                body: JSON.stringify(payload)
            });
            if (!imageResponse.ok) {
                const errorText = await imageResponse.text();
                throw new Error(`Solicitud de clasificación 5-Clases falló: ${errorText}`);
            }
            return imageResponse;
        };
        const response = await tryRequest();
        const buffer = await response.arrayBuffer();
        const base64 = Buffer.from(buffer).toString('base64');
        // El frontend deberá usar esta información para mapear 1->Agua, 2->Suelo, etc.
        const classificationStatus = "Clasificación 5-Clases (Agua, Suelo, Veg. Baja, Bosque, Veg. Densa)";
        return {
            url: `data:image/png;base64,${base64}`,
            usedDate: foundDate,
            polarization: finalPolarization,
            sourceTile: tileId,
            status: classificationStatus,
            bbox: bbox,
			width: width,     // <-- Añadido
			height: height    // <-- Añadido			
        };
    } catch (error) {
        console.error('❌ Error en la imagen Sentinel-1 (Clasificación 5-Clases):', error.message);
        throw error;
    }
};
// ==============================================
// ✅ NUEVO ENDPOINT: /api/sentinel1classification
// ==============================================
app.post('/api/sentinel1classification', async (req, res) => {
    const { coordinates, date } = req.body;
    if (!coordinates || !date) {
        return res.status(400).json({ error: 'Faltan parámetros: coordinates y date' });
    }
    try {
        const result = await fetchSentinel1Classification({ geometry: coordinates, date: date });
        res.json(result);
    } catch (error) {
        console.error('❌ Error en el endpoint /api/sentinel1classification:', error.message);
        res.status(500).json({ error: error.message });
    }
});


// ==============================================
// ✅ NUEVO ENDPOINT: /api/sentinel1vhimage - Imagen de VH en escala de grises
// ==============================================
/**
 * Obtiene una imagen en escala de grises de la banda VH de Sentinel-1.
 * @param {object} params - Parámetros de la solicitud.
 * @param {array} params.geometry - Coordenadas del polígono.
 * @param {string} params.date - Fecha de la imagen.
 * @returns {object} Un objeto con la URL de la imagen PNG y metadatos.
 */
const fetchSentinel1VHImage = async ({ geometry, date }) => {
    const accessToken = await getAccessToken();
    const bbox = polygonToBbox(geometry);
    if (!bbox) {
        throw new Error('No se pudo calcular el bounding box del polígono.');
    }

    // === PASO 1: Consultar catálogo (igual que en classification) ===
    const fromDate = new Date(date);
    const toDate = new Date(date);
    const catalogUrl = 'https://services.sentinel-hub.com/api/v1/catalog/1.0.0/search';
    const catalogPayload = {
        "bbox": bbox,
        "datetime": `${fromDate.toISOString().split('T')[0]}T00:00:00Z/${toDate.toISOString().split('T')[0]}T23:59:59Z`,
        "collections": ["sentinel-1-grd"],
        "limit": 10
    };

    const catalogResponse = await fetch(catalogUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${accessToken}` },
        body: JSON.stringify(catalogPayload)
    });

    if (!catalogResponse.ok) {
        const errorText = await catalogResponse.text();
        throw new Error(`Error en catálogo S1: ${errorText}`);
    }

    const catalogData = await catalogResponse.json();
    if (catalogData.features.length === 0) {
        throw new Error("No hay datos de Sentinel-1 disponibles en la fecha solicitada.");
    }

    const feature = catalogData.features[0];
    const foundDate = feature.properties.datetime.split('T')[0];
    const tileId = feature.id;
    const pol = determinePolarization(tileId);

    // === Validar que la escena tenga VH ===
    if (!pol.primary.includes('D')) {
        throw new Error("La escena disponible no contiene la banda VH (solo polarización simple).");
    }

    // === Calcular tamaño óptimo ===
    const areaResult = calculatePolygonArea(bbox);
    const sizeInPixels = calculateOptimalImageSize(areaResult.area, 10, areaResult.aspectRatio);
    const { width, height } = sizeInPixels;

    // === Payload: usar polarización DUAL (DV/DH), pero evalscript solo usa VH ===
    const payload = {
        input: {
            bounds: { geometry: { type: "Polygon", coordinates: geometry } },
            data: [{
                type: "sentinel-1-grd",
                dataFilter: {
                    timeRange: { from: `${foundDate}T00:00:00Z`, to: `${foundDate}T23:59:59Z` },
                    polarization: pol.primary, // Ej: "DV"
                    instrumentMode: "IW"
                },
                processing: { mosaicking: "ORBIT" }
            }]
        },
        output: {
            width,
            height,
            format: "image/png",
            sampleType: "UINT8",
            crs: "http://www.opengis.net/def/crs/OGC/1.3/CRS84"
        },
        evalscript: `
//VERSION=3
function setup() {
    return {
        input: [{ bands: ["VH", "dataMask"], units: "LINEAR_POWER" }],
        output: { bands: 1, sampleType: "UINT8" }
    };
}
function evaluatePixel(samples) {
    if (samples.dataMask === 0 || samples.VH <= 0) {
        return [0];
    }
    const vh_db = 10 * Math.log10(samples.VH);
    // Rango ajustado a tus datos reales
    const minDb = -28.0;
    const maxDb = -10.0;
    let normalized = (vh_db - minDb) / (maxDb - minDb);
    normalized = Math.max(0, Math.min(1, normalized));
    return [normalized * 255];
}`
    };

    const imageResponse = await fetch('https://services.sentinel-hub.com/api/v1/process', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${accessToken}` },
        body: JSON.stringify(payload)
    });

    if (!imageResponse.ok) {
        const error = await imageResponse.text();
        throw new Error(`Error en Process API: ${error}`);
    }

    const buffer = await imageResponse.arrayBuffer();
    const base64 = Buffer.from(buffer).toString('base64');

    return {
        url: `data:image/png;base64,${base64}`,
        usedDate: foundDate,
        bbox,
        width,
        height
    };
};

// Endpoint para el frontend
app.post('/api/sentinel1vhimage', async (req, res) => {
    const { coordinates, date } = req.body;
    if (!coordinates || !date) {
        return res.status(400).json({ error: 'Faltan parámetros: coordinates y date' });
    }
    try {
        const result = await fetchSentinel1VHImage({ geometry: coordinates, date: date });
        res.json(result);
    } catch (error) {
        console.error('❌ Error en el endpoint /api/sentinel1vhimage:', error.message);
        res.status(500).json({ error: error.message });
    }
});


// ==============================================
// ✅ NUEVO ENDPOINT: /api/sentinel1vhaverage - Valor promedio de VH en dB
// ==============================================
/**
 * Obtiene el valor promedio de la retrodispersión de la banda VH de Sentinel-1 en dB.
 * @param {object} params - Parámetros de la solicitud.
 * @param {array} params.geometry - Coordenadas del polígono.
 * @param {string} params.date - Fecha de la imagen.
 * @returns {object} Un objeto con el promedio en dB y estadísticas.
 */
const fetchSentinel1VHAverage = async ({ geometry, date }) => {
    const accessToken = await getAccessToken();
    const bbox = polygonToBbox(geometry);
    if (!bbox) {
        throw new Error('No se pudo calcular el bounding box del polígono.');
    }
    try {
        const areaResult = calculatePolygonArea(bbox);
        const areaInSquareMeters = areaResult.area;
        const aspectRatio = areaResult.aspectRatio;
        const sizeInPixels = calculateOptimalImageSize(areaInSquareMeters, 10, aspectRatio);
        const width = sizeInPixels.width;
        const height = sizeInPixels.height;

        // Búsqueda en el Catálogo
        const fromDate = new Date(date);
        const toDate = new Date(date);
        // ✅ CORREGIDO: URL sin espacios
        const catalogUrl = 'https://services.sentinel-hub.com/api/v1/catalog/1.0.0/search';
        const catalogPayload = {
            "bbox": bbox,
            "datetime": `${fromDate.toISOString().split('T')[0]}T00:00:00Z/${toDate.toISOString().split('T')[0]}T23:59:59Z`,
            "collections": ["sentinel-1-grd"],
            "limit": 10
        };
        const catalogResponse = await fetch(catalogUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${accessToken}`
            },
            body: JSON.stringify(catalogPayload)
        });
        if (!catalogResponse.ok) {
            const errorText = await catalogResponse.text();
            throw new Error(`Error en consulta al catálogo: ${errorText}`);
        }
        const catalogData = await catalogResponse.json();
        if (catalogData.features.length === 0) {
            throw new Error("No se encontraron datos de Sentinel-1 para esta ubicación.");
        }
        const feature = catalogData.features[0];
        const foundDate = feature.properties.datetime.split('T')[0];
        const tileId = feature.id;
        const pol = determinePolarization(tileId);

        // ✅ Validación crítica: asegurar que la escena tiene VH
        if (!pol.primary.includes('D')) {
            throw new Error(`La escena disponible (${tileId}) no contiene la banda VH (solo polarización simple: ${pol.primary}).`);
        }

        // Evalscript para datos en bruto (TIFF, FLOAT32)
		const evalscript = `//VERSION=3
		function setup() {
			return {
				input: [{ bands: ["VH", "dataMask"], units: "LINEAR_POWER" }]
				// ⬅️ ¡NO incluyas "output" aquí!
			};
		}
		function evaluatePixel(samples) {
			if (samples.dataMask === 0 || samples.VH <= 0) {
				return [NaN];
			}
			return [10 * Math.log10(samples.VH)];
		}`;

        const payload = {
            input: {
                bounds: {
                    geometry: {
                        type: "Polygon",
                        coordinates: geometry
                    }
                },
                data: [{
                    dataFilter: {
                        timeRange: {
                            from: `${foundDate}T00:00:00Z`,
                            to: `${foundDate}T23:59:59Z`
                        },
                        polarization: pol.primary, // ✅ DV o DH → VH disponible
                        instrumentMode: pol.mode
                    },
                    processing: {
                        mosaicking: "ORBIT"
                    },
                    type: "sentinel-1-grd"
                }]
            },
			output: {
				width: width,
				height: height,
				bands: 1,
				format: "image/tiff",
				sampleType: "FLOAT32",
				crs: "http://www.opengis.net/def/crs/OGC/1.3/CRS84"
			},
            evalscript: evalscript
        };

		// 🔍 DEBUG: Verificar payload antes de enviar
		console.log('🔍 [DEBUG] Payload enviado a Sentinel Hub Process API:');
		console.log('   - output.format:', payload.output.format);
		console.log('   - output.sampleType:', payload.output.sampleType);
		console.log('   - dataFilter.polarization:', payload.input.data[0].dataFilter.polarization);
		console.log('   - evalscript preview:', evalscript.substring(0, 100) + '...');

		console.log('🔍 [DEBUG] Payload.output real:', JSON.stringify(payload.output));
		
		const tiffResponse = await fetch('https://services.sentinel-hub.com/api/v1/process', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${accessToken}`
			},
			body: JSON.stringify(payload)
		});

		if (!tiffResponse.ok) {
			const errorText = await tiffResponse.text();
			throw new Error(`Error al obtener datos en bruto para cálculo del promedio: ${errorText}`);
		}

		// ✅ NUEVA VALIDACIÓN: asegurar que la respuesta es un TIFF
		const contentType = tiffResponse.headers.get('content-type');
		if (!contentType || !contentType.includes('image/tiff')) {
			const errorText = await tiffResponse.text();
			console.error('❌ Respuesta inesperada (no es TIFF):', errorText);
			throw new Error(`La respuesta no es un TIFF válido. Content-Type: ${contentType}. Detalle: ${errorText}`);
		}

		const tiffBuffer = await tiffResponse.arrayBuffer();
		// ✅ Validar que la longitud sea múltiplo de 4
		if (tiffBuffer.byteLength % 4 !== 0) {
			throw new Error(`Buffer de TIFF inválido: longitud (${tiffBuffer.byteLength}) no es múltiplo de 4.`);
		}

		const float32Array = new Float32Array(tiffBuffer);
		
        let sum = 0;
        let count = 0;
        for (let i = 0; i < float32Array.length; i++) {
            const value = float32Array[i];
            if (!isNaN(value)) {
                sum += value;
                count++;
            }
        }
        const avgVhDb = count > 0 ? sum / count : null;

        return {
            avgVhDb: avgVhDb,
            totalPixels: float32Array.length,
            validPixels: count,
            usedDate: foundDate
        };
    } catch (error) {
        console.error('❌ Error en fetchSentinel1VHAverage:', error.message);
        throw error;
    }
};

// Endpoint para el frontend
app.post('/api/sentinel1vhaverage', async (req, res) => {
    const { coordinates, date } = req.body;
    if (!coordinates || !date) {
        return res.status(400).json({ error: 'Faltan parámetros: coordinates y date' });
    }
    try {
        const result = await fetchSentinel1VHAverage({ geometry: coordinates, date: date });
        res.json(result);
    } catch (error) {
        console.error('❌ Error en el endpoint /api/sentinel1vhaverage:', error.message);
        res.status(500).json({ error: error.message });
    }
});


/**
 * ✅ FUNCIÓN CORREGIDA: Obtiene el valor promedio de NDVI y porcentaje de cobertura vegetal
 * @param {object} params - Parámetros de la solicitud.
 * @param {array} params.geometry - Coordenadas del polígono.
 * @param {string} params.date - Fecha de la imagen.
 * @returns {object} Objeto con NDVI promedio y porcentaje de cobertura
 * @throws {Error} Si no se puede obtener el valor.
 */
const getNdviAverage2 = async ({ geometry, date }) => {
    const accessToken = await getAccessToken();
    try {
        // ✅ NUEVO: Calcular el bbox y el área para determinar el tamaño óptimo
        const bbox = polygonToBbox(geometry);
        if (!bbox) {
            throw new Error('No se pudo calcular el bounding box.');
        }
        const areaResult = calculatePolygonArea(bbox);
        const areaInSquareMeters = areaResult.area;
        const aspectRatio = areaResult.aspectRatio;
        const sizeInPixels = calculateOptimalImageSize(areaInSquareMeters, 10, aspectRatio); // 10m de resolución
        const width = sizeInPixels.width;
        const height = sizeInPixels.height;
        // 🔹 REGISTRO DE PU
        // logProcessingUnits(width, height, 1, "NDVI-Average");
        const payload = {
            input: {
                bounds: {
                    geometry: {
                        type: "Polygon",
                        coordinates: geometry
                    }
                },
                data: [
                    {
                        dataFilter: {
                            timeRange: {
                                from: `${date}T00:00:00Z`,
                                to: `${date}T23:59:59Z`
                            },
                            maxCloudCoverage: 100
                        },
                        type: "sentinel-2-l2a"
                    }
                ]
            },
            output: {
                width: width, // ✅ Tamaño adaptativo
                height: height, // ✅ Tamaño adaptativo
                format: "image/png",
				// ✅ CORRECCIÓN CLAVE: Forzar proyección WGS84
				crs: "http://www.opengis.net/def/crs/OGC/1.3/CRS84"
            },
            evalscript: `//VERSION=3
function setup() {
  return {
    input: [{ bands: ["B08", "B04", "dataMask"], units: "REFLECTANCE" }],
    output: { bands: 1, sampleType: "UINT8" }
  };
}
function evaluatePixel(samples) {
  if (samples.dataMask === 0) {
    return [0]; // Fondo/No datos
  }
  const nir = samples.B08;
  const red = samples.B04;
  const ndvi = (nir - red) / (nir + red);
  // Umbral ajustado para bosque templado (> 0.4)
  if (ndvi > 0.4) {
    return [255]; // Vegetación significativa
  } else {
    return [0]; // No vegetación o vegetación mínima
  }
}`
        };
        const response = await fetch('https://services.sentinel-hub.com/api/v1/process', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${accessToken}`
            },
            body: JSON.stringify(payload)
        });
        if (!response.ok) {
            const error = await response.text();
            throw new Error(`Error en la API de Sentinel-Hub: ${error}`);
        }
        const buffer = await response.arrayBuffer();
        const imageData = new Uint8Array(buffer);
        let sum = 0;
        let count = 0;
        let vegetationPixels = 0;
        let totalPixels = 0;
        for (let i = 0; i < imageData.length; i += 4) {
            const value = imageData[i];
            if (value !== 0) { // Pixel válido (no fondo)
                totalPixels++;
                // Calcular NDVI real para el promedio
                const normalizedValue = value / 255.0;
                const ndvi = (normalizedValue * 2) - 1;
                sum += ndvi;
                count++;
                // Contar píxeles con vegetación significativa
                if (value === 255) {
                    vegetationPixels++;
                }
            }
        }
        const avgNdvi = count > 0 ? sum / count : null;
        const vegetationPercentage = totalPixels > 0 ? (vegetationPixels / totalPixels) * 100 : 0;
        return {
            avgNdvi: avgNdvi,
            vegetationPercentage: vegetationPercentage,
            vegetationPixels: vegetationPixels,
            totalPixels: totalPixels
        };
    } catch (error) {
        console.error('❌ Error en getNdviAverage2:', error.message);
        throw error;
    }
};
// ==============================================
// ENDPOINTS DE IMÁGENES CON LÓGICA DE REINTENTO
// ==============================================
app.post('/api/sentinel2', async (req, res) => {
    const { coordinates, date } = req.body;
    if (!coordinates || !date) {
        return res.status(400).json({ error: 'Faltan parámetros: coordinates y date' });
    }
    try {
        const result = await fetchSentinelImage({ geometry: coordinates, date, geometryType: 'Polygon' });
        res.json(result);
    } catch (error) {
        console.error('❌ Error general:', error.message);
        res.status(500).json({
            error: error.message,
            suggestion: "Verifica que las coordenadas del polígono sean válidas y que el área esté en tierra firme"
        });
    }
});
app.post('/api/get-valid-dates1', async (req, res) => {
    // Coordenadas de prueba para Londres
    const testBbox = [-0.161, 51.488, 0.057, 51.52];
    try {
        let availableDates = await getAvailableDates(testBbox, 90);
        if (availableDates.length === 0) {
            availableDates = await getAvailableDates(testBbox, 100);
        }
        if (availableDates.length === 0) {
            return res.json({ hasCoverage: false, message: "No se encontraron imágenes para esta ubicación en el rango de fechas." });
        }
        res.json({
            hasCoverage: true,
            totalDates: availableDates.length,
            availableDates: availableDates.slice(0, 30),
            message: `Se encontraron ${availableDates.length} fechas con datos disponibles`
        });
    } catch (error) {
        console.error('❌ Error al verificar cobertura:', error.message);
        res.status(500).json({ error: error.message, suggestion: "Verifica que las coordenadas sean válidas y el área esté en tierra firme." });
    }
});
app.post('/api/get-valid-dates', async (req, res) => {
	console.log('🔑 /api/get-valid-dates');
	console.error('🕒 Inicio de solicitud /get-valid-dates');
    const { coordinates } = req.body;
    if (!coordinates) {
        return res.status(400).json({ error: 'Faltan parámetros requeridos: coordinates' });
    }
    const bbox = polygonToBbox(coordinates);
    if (!bbox) {
        return res.status(400).json({ error: 'Formato de coordenadas de polígono inválido.' });
    }
    try {
		const start = Date.now();
        let availableDates = await getAvailableDates(bbox, 50);
        if (availableDates.length === 0) {
            availableDates = await getAvailableDates(bbox, 100);
        }
        if (availableDates.length === 0) {
            return res.json({ hasCoverage: false, message: "No se encontraron imágenes para esta ubicación en el rango de fechas." });
        }
        const duration = Date.now() - start;
		console.error(`✅ /get-valid-dates completado en ${duration}ms. Fechas encontradas: ${availableDates.length}`);
        res.json({
            hasCoverage: true,
            totalDates: availableDates.length,
            availableDates: availableDates.slice(0, 90),
            message: `Se encontraron ${availableDates.length} fechas con datos disponibles`
        });
    } catch (error) {
        console.error('❌ Error al verificar cobertura:', error.message);
        res.status(500).json({ error: error.message, suggestion: "Verifica que las coordenadas sean válidas y el área esté en tierra firme." });
    }
});
// =============================================
// ✅ NUEVO ENDPOINT: /api/get-valid-dates-s1 (Sentinel-1)
// =============================================
app.post('/api/get-valid-dates-s1', async (req, res) => {
    // El frontend enviará las coordenadas del polígono
	console.log('🔑 /api/get-valid-dates-s1');
	console.warn('🕒 Inicio de solicitud /get-valid-dates-s1');
    const { coordinates } = req.body; 
    if (!coordinates) {
        return res.status(400).json({ error: 'Faltan parámetros: coordinates.' });
    }
    try {
		const start = Date.now();
        const dates = await getSentinel1Dates({ geometry: coordinates });
        const duration = Date.now() - start;
		console.warn(`✅ /get-valid-dates-s1 completado en ${duration}ms. Fechas encontradas: ${dates.length}`);
        res.json({ dates });
    } catch (error) {
        console.error('❌ Error en el endpoint /api/get-valid-dates-s1:', error.message);
        res.status(500).json({ error: error.message });
    }
});
app.post('/api/sentinel2simple', async (req, res) => {
    const { coordinates, date } = req.body;
    if (!coordinates || !date) {
        return res.status(400).json({ error: 'Faltan parámetros: coordinates y date' });
    }
    try {
        const result = await fetchSentinelImage({ geometry: coordinates, date, geometryType: 'Polygon' });
        res.json(result);
    } catch (error) {
        console.error('❌ Error general:', error.message);
        res.status(500).json({
            error: error.message,
            suggestion: "Verifica que las coordenadas del polígono sean válidas y que el área esté en tierra firme"
        });
    }
});
app.post('/api/sentinel2simple2', async (req, res) => {
    const { coordinates, date } = req.body;
    const bbox = polygonToBbox(coordinates);
    if (!bbox) {
        return res.status(400).json({ error: 'Formato de coordenadas de polígono inválido.' });
    }
    console.log(`✅ Polígono convertido a bbox: [${bbox.join(', ')}]`);
    try {
        const result = await fetchSentinelImage({ geometry: bbox, date, geometryType: 'bbox' });
        res.json(result);
    } catch (error) {
        console.error('❌ Error general:', error.message);
        res.status(500).json({
            error: error.message,
            suggestion: "Verifica que las coordenadas del polígono sean válidas y que el área esté en tierra firme."
        });
    }
});
// ==============================================
// ✅ NUEVO ENDPOINT PARA OBTENER LOS PROMEDIOS DE NDVI
// ==============================================
app.post('/api/get-ndvi-averages', async (req, res) => {
    const { coordinates, dates } = req.body;
    if (!coordinates || !dates || dates.length < 2) {
        return res.status(400).json({ error: 'Faltan parámetros: coordinates y al menos dos fechas en dates.' });
    }
    try {
        const [avg1, avg2] = await Promise.all([
            getNdviAverage2({ geometry: coordinates, date: dates[0] }),
            getNdviAverage2({ geometry: coordinates, date: dates[1] })
        ]);
        res.json({
            date1: dates[0],
            avgNdvi1: avg1,
            date2: dates[1],
            avgNdvi2: avg2
        });
    } catch (error) {
        console.error('❌ Error en el endpoint /get-ndvi-averages:', error.message);
        res.status(500).json({ error: error.message });
    }
});
// ==============================================
// ENDPOINTS DE METADATOS CON BBOX
// ==============================================
app.post('/api/check-coverage', async (req, res) => {
    const { coordinates } = req.body;
    if (!coordinates) {
        return res.status(400).json({ error: 'Faltan parámetros requeridos: coordinates' });
    }
    const bbox = polygonToBbox(coordinates);
    if (!bbox) {
        return res.status(400).json({ error: 'Formato de coordenadas de polígono inválido.' });
    }
    try {
        const accessToken = await getAccessToken();
        const metadataPayload = {
            input: {
                bounds: {
                    bbox: bbox,
                    properties: { crs: "http://www.opengis.net/def/crs/OGC/1.3/CRS84" }
                },
                data: [{
                    dataFilter: {
                        timeRange: { from: "2020-01-01T00:00:00Z", to: "2025-01-01T23:59:59Z" },
                        maxCloudCoverage: 100
                    },
                    type: "sentinel-2-l2a"
                }]
            },
            output: {
                width: 50,
                height: 50,
                format: "application/json"
            },
            evalscript: `// VERSION=3
function setup() { return { input: ["B04"], output: { bands: 1 } }; }
function evaluatePixel(sample) { return [1]; }`,
            meta: { "availableDates": true }
        };
        const metadataResponse = await fetch('https://services.sentinel-hub.com/api/v1/process', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${accessToken}`
            },
            body: JSON.stringify(metadataPayload)
        });
        if (!metadataResponse.ok) {
            const error = await metadataResponse.text();
            throw new Error(`Error al obtener metadatos: ${error}`);
        }
        const metadata = await metadataResponse.json();
        const availableDates = metadata.metadata && metadata.metadata.availableDates ?
            metadata.metadata.availableDates.map(date => date.split('T')[0]).sort((a, b) => new Date(b) - new Date(a)) :
            [];
        if (availableDates.length === 0) {
            return res.json({ hasCoverage: false, message: "No hay datos disponibles para este área en el periodo de tiempo especificado." });
        }
        res.json({
            hasCoverage: true,
            totalDates: availableDates.length,
            availableDates: availableDates.slice(0, 30),
            message: `Se encontraron ${availableDates.length} fechas con datos disponibles`
        });
    } catch (error) {
        console.error('❌ Error al verificar cobertura:', error.message);
        res.status(500).json({ error: error.message, suggestion: "Verifica que las coordenadas sean válidas y el área esté en tierra firme." });
    }
});
app.post('/api/catalogo-coverage', async (req, res) => {
    const { coordinates } = req.body;
    if (!coordinates) {
        return res.status(400).json({ error: 'Faltan parámetros requeridos: coordinates' });
    }
    const bbox = polygonToBbox(coordinates);
    if (!bbox) {
        return res.status(400).json({ error: 'Formato de coordenadas de polígono inválido.' });
    }
    try {
        const accessToken = await getAccessToken();
        const catalogUrl = 'https://services.sentinel-hub.com/api/v1/catalog/1.0.0/search';
        const payload = {
            "bbox": bbox,
            "datetime": "2020-01-01T00:00:00Z/2025-01-01T23:59:59Z",
            "collections": ["sentinel-2-l2a"],
            "limit": 100,
            "filter": {
                "op": "<=",
                "field": "eo:cloud_cover",
                "value": 100
            }
        };
        const catalogResponse = await fetch(catalogUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${accessToken}`
            },
            body: JSON.stringify(payload)
        });
        if (!catalogResponse.ok) {
            const error = await catalogResponse.text();
            throw new Error(`Error al obtener datos del Catálogo: ${error}`);
        }
        const catalogData = await catalogResponse.json();
        const availableDates = catalogData.features
            .map(feature => feature.properties.datetime.split('T')[0])
            .filter((value, index, self) => self.indexOf(value) === index)
            .sort((a, b) => new Date(b) - new Date(a));
        if (availableDates.length === 0) {
            return res.json({ hasCoverage: false, message: "No hay datos de imagen disponibles para este área en el periodo de tiempo especificado." });
        }
        res.json({
            hasCoverage: true,
            totalDates: availableDates.length,
            availableDates: availableDates,
            message: `Se encontraron ${availableDates.length} fechas con datos disponibles`
        });
    } catch (error) {
        console.error('❌ Error al verificar cobertura:', error.message);
        res.status(500).json({
            error: error.message,
            suggestion: "Verifica que las coordenadas estén en formato [longitud, latitud] y que el área esté en tierra firme"
        });
    }
});
// ==============================================
// ✅ NUEVO ENDPOINT PARA PRUEBAS (POSTMAN)
// ==============================================
app.post('/api/test-ndvi', async (req, res) => {
    const { coordinates, date } = req.body;
    if (!coordinates || !date) {
        return res.status(400).json({ error: 'Faltan parámetros: coordinates y date.' });
    }
    try {
        const ndviAverage = await getNdviAverage2({ geometry: coordinates, date });
        res.json({
            date: date,
            avgNdvi: ndviAverage,
            message: "NDVI average retrieved successfully."
        });
    } catch (error) {
        console.error('❌ Error en el endpoint /test-ndvi:', error.message);
        res.status(500).json({
            error: error.message,
            suggestion: "Verifica que las coordenadas y la fecha sean correctas."
        });
    }
});
app.post('/api/sentinel2truecolor', async (req, res) => {
    const { coordinates, date } = req.body;
    if (!coordinates || !date) {
        return res.status(400).json({ error: 'Faltan parámetros: coordinates y date' });
    }
    try {
        const result = await fetchSentinelImageTC({ geometry: coordinates, date, geometryType: 'Polygon' });
        res.json(result);
    } catch (error) {
        console.error('❌ Error en /sentinel2truecolor:', error.message);
        res.status(500).json({
            error: error.message,
            suggestion: "Verifica que las coordenadas del polígono sean válidas y que el área esté en tierra firme"
        });
    }
});
// ==============================================
// ✅ NUEVO ENDPOINT: /api/sentinel2highlight - Highlight Optimized Natural Color (MEJORADO)
// ==============================================
/**
 * Obtiene una imagen Sentinel-2 con visualización "Highlight Optimized Natural Color".
 * @param {object} params - Parámetros de la solicitud.
 * @param {array} params.geometry - Coordenadas del polígono.
 * @param {string} params.date - Fecha de la imagen.
 * @param {array} params.bbox - Bounding box del polígono [minLon, minLat, maxLon, maxLat].
 * @returns {object} Un objeto con la URL de la imagen, la fecha utilizada y el bbox.
 */
const fetchSentinelImageHighlight = async ({ geometry, date, bbox }) => {
    const accessToken = await getAccessToken();
    // ✅ NUEVO: Calcular el área aproximada del polígono en metros cuadrados
    const areaResult = calculatePolygonArea(bbox);
    const areaInSquareMeters = areaResult.area;
    const aspectRatio = areaResult.aspectRatio;
    const sizeInPixels = calculateOptimalImageSize(areaInSquareMeters, 10, aspectRatio);
    const width = sizeInPixels.width;
    const height = sizeInPixels.height;
    // 🔹 REGISTRO DE PU
    // logProcessingUnits(width, height, 4, "Highlight");
    const payload = {
        input: {
            bounds: {
                geometry: {
                    type: "Polygon",
                    coordinates: geometry
                }
            },
            data: [
                {
                    type: "sentinel-2-l2a",
                    dataFilter: {
                        timeRange: {
                            from: `${date}T00:00:00Z`,
                            to: `${date}T23:59:59Z`
                        },
                        maxCloudCoverage: 20
                    },
                    mosaicking: "SCENE"
                }
            ]
        },
        output: {
            width: width,
            height: height,
            format: "image/png",
            upsampling: "BICUBIC", // Mejor para ampliar
            downsampling: "BICUBIC", // Mejor para reducir
            bands: 4, // 3 bandas de color + 1 de máscara (alpha)
            sampleType: "UINT8",
            // ✅ CORRECCIÓN CLAVE: Forzar proyección WGS84
            crs: "http://www.opengis.net/def/crs/OGC/1.3/CRS84"
        },
        evalscript: `
//VERSION=3
function setup() {
    return {
        input: [{
            bands: [
                "B04", // Red
                "B03", // Green
                "B02", // Blue
                "dataMask" // Para máscara de datos
            ],
            units: "REFLECTANCE"
        }],
        output: {
            bands: 4, // 3 bandas de color + 1 de máscara (alpha)
            sampleType: "UINT8"
        }
    };
}
// Función para aplicar el ajuste de rango dinámico (DRA) a un canal
function evaluatePixel(sample) {
    // Valores para el ajuste de rango dinámico (DRA) - Estos son valores típicos para EO Browser
    let minVal = 0.0;
    let maxVal = 0.4; // Este es el valor clave que controla el brillo. 0.4 es un buen punto de partida.
    // Aplicar DRA a cada canal
    let red = (sample.B04 - minVal) / (maxVal - minVal);
    let green = (sample.B03 - minVal) / (maxVal - minVal);
    let blue = (sample.B02 - minVal) / (maxVal - minVal);
    // Recortar valores fuera del rango [0, 1]
    red = Math.max(0, Math.min(1, red));
    green = Math.max(0, Math.min(1, green));
    blue = Math.max(0, Math.min(1, blue));
    // Devolver el color RGB y la máscara de datos (para transparencia)
    return [red * 255, green * 255, blue * 255, sample.dataMask * 255];
}
        `
    };
    const imageResponse = await fetch('https://services.sentinel-hub.com/api/v1/process', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${accessToken}`
        },
        body: JSON.stringify(payload)
    });
    if (!imageResponse.ok) {
        const error = await imageResponse.text();
        console.error('❌ Error en la API de Sentinel-Hub (Highlight):', error);
        throw new Error(`Error en la imagen Highlight para ${date}: ${error}`);
    }
    const buffer = await imageResponse.arrayBuffer();
    const base64 = Buffer.from(buffer).toString('base64');
    return {
        url: `data:image/png;base64,${base64}`,
        usedDate: date,
        bbox: bbox,
		width: width,   // <-- Añade esta línea
		height: height   // <-- Añade esta línea		
    };
};
// Endpoint para el frontend
app.post('/api/sentinel2highlight', async (req, res) => {
    const { coordinates, date } = req.body;
    if (!coordinates || !date) {
        return res.status(400).json({ error: 'Faltan parámetros: coordinates y date' });
    }
    try {
        // Calcular el bbox del polígono
        const bbox = polygonToBbox(coordinates);
        if (!bbox) {
            throw new Error('No se pudo calcular el bounding box del polígono.');
        }
        const result = await fetchSentinelImageHighlight({
            geometry: coordinates,
            date: date,
            bbox: bbox // ✅ Pasamos el bbox para el cálculo del área
        });
        res.json(result);
    } catch (error) {
        console.error('❌ Error en /sentinel2highlight:', error.message);
        res.status(500).json({
            error: error.message,
            suggestion: "Verifica que las coordenadas del polígono sean válidas y que el área esté en tierra firme"
        });
    }
});
// ==============================================
// ✅ FUNCIÓN CORREGIDA FINAL: Obtiene el valor de retrodispersión promedio de Sentinel-1
// ==============================================
/**
 * Obtiene el valor de retrodispersión promedio de Sentinel-1 (banda VH)
 * para una fecha y geometría específicas.
 * @param {object} params - Parámetros de la solicitud.
 * @param {array} params.geometry - Coordenadas del polígono.
 * @param {string} params.date - Fecha de la imagen.
 * @returns {object} Objeto con el promedio de retrodispersión.
 * @throws {Error} Si no se puede obtener el valor.
 */
const getSentinel1Biomass = async ({ geometry, date }) => {
    const accessToken = await getAccessToken();
    try {
        const bbox = polygonToBbox(geometry);
        if (!bbox) {
            throw new Error('No se pudo calcular el bounding box.');
        }
        const areaResult = calculatePolygonArea(bbox);
        const areaInSquareMeters = areaResult.area;
        const aspectRatio = areaResult.aspectRatio;
        const sizeInPixels = calculateOptimalImageSize(areaInSquareMeters, 10, aspectRatio); // 10m de resolución
        const width = sizeInPixels.width;
        const height = sizeInPixels.height;
        // 🔹 REGISTRO DE PU
        // logProcessingUnits(width, height, 1, "S1-Biomass-Average");
        const payload = {
            input: {
                bounds: {
                    geometry: {
                        type: "Polygon",
                        coordinates: geometry
                    }
                },
                data: [
                    {
                        dataFilter: {
                            timeRange: {
                                from: `${date}T00:00:00Z`,
                                to: `${date}T23:59:59Z`
                            },
                            polarization: "VH",
                            orbitDirection: "DESCENDING"    // ASCENDING
                        },
                        type: "sentinel-1-grd"
                    }
                ]
            },
            output: {
                width: width,
                height: height,
                format: "image/tiff",
                sampleType: "UINT16", // ✅ CAMBIO A UINT16
				// ✅ CORRECCIÓN CLAVE: Forzar proyección WGS84
				crs: "http://www.opengis.net/def/crs/OGC/1.3/CRS84"
            },
            evalscript: `//VERSION=3
function setup() {
  return {
    input: [{ bands: ["VH", "dataMask"], units: "LINEAR_POWER" }],
    output: { bands: 1, sampleType: "UINT16" }
  };
}
function evaluatePixel(samples) {
  if (samples.dataMask === 0) {
    return [0];
  }
  const vh_linear = samples.VH;
  const vh_db = 10 * Math.log10(vh_linear);
  const minDb = -20;
  const maxDb = 5;
  const mappedValue = Math.round((vh_db - minDb) / (maxDb - minDb) * 65535);
  return [mappedValue];
}`
        };
        const response = await fetch('https://services.sentinel-hub.com/api/v1/process', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${accessToken}`
            },
            body: JSON.stringify(payload)
        });
        if (!response.ok) {
            const error = await response.text();
            throw new Error(`Error en la API de Sentinel-Hub: ${error}`);
        }
        const buffer = await response.arrayBuffer();
        const uint16Array = new Uint16Array(buffer); // ✅ CAMBIO A Uint16Array
        let sum = 0;
        let count = 0;
        const minDb = -20;
        const maxDb = 5;
        for (let i = 0; i < uint16Array.length; i++) {
            const value = uint16Array[i];
            if (value > 0) { // ✅ Verificamos que no sea el valor de fondo
                // Desescalamos el valor de regreso a decibelios
                const deScaledValue = (value / 65535) * (maxDb - minDb) + minDb;
                sum += deScaledValue;
                count++;
            }
        }
        const avgBiomassProxy = count > 0 ? sum / count : null;
        return {
            avgBiomassProxy: avgBiomassProxy,
            totalPixels: uint16Array.length,
            validPixels: count
        };
    } catch (error) {
        console.error('❌ Error en getSentinel1Biomass:', error.message);
        throw error;
    }
};
// ==============================================
// ✅ ENDPOINT FINAL: /api/get-s1-averages
// ==============================================
app.post('/api/get-s1-averages', async (req, res) => {
    const { coordinates, dates } = req.body;
    if (!coordinates || !dates || dates.length < 2) {
        return res.status(400).json({ error: 'Faltan parámetros: coordinates y al menos dos fechas en dates.' });
    }
    try {
        const [avg1, avg2] = await Promise.all([
            getSentinel1Biomass({ geometry: coordinates, date: dates[0] }),
            getSentinel1Biomass({ geometry: coordinates, date: dates[1] })
        ]);
        res.json({
            date1: dates[0],
            avgBiomass1: avg1,
            date2: dates[1],
            avgBiomass2: avg2
        });
    } catch (error) {
        console.error('❌ Error en el endpoint /get-s1-averages:', error.message);
        res.status(500).json({ error: error.message });
    }
});
// ==============================================
// ✅ NUEVO ENDPOINT: /api/sentinel1radar
// ==============================================
app.post('/api/sentinel1radar', async (req, res) => {
    const { coordinates, date } = req.body;
    if (!coordinates || !date) {
        return res.status(400).json({ error: 'Faltan parámetros: coordinates y date' });
    }
    try {
        const result = await fetchSentinel1Radar({ geometry: coordinates, date: date });
        res.json(result);
    } catch (error) {
        console.error('❌ Error en /sentinel1radar:', error.message);
        res.status(500).json({ error: error.message });
    }
});
/*  */
// Al final del archivo, justo antes de app.listen, agregamos un manejador global de errores
// para asegurar que incluso en fallos internos se respeten los headers CORS (aunque ya están
// cubiertos por el middleware inicial, esto evita que Express responda con HTML sin CORS).
app.use((err, req, res, next) => {
  console.error('❌ Error no capturado:', err);
  res.status(500).json({ error: 'Error interno del servidor' });
});
app.listen(port, '0.0.0.0', () => {
    console.log(`✅ Backend listo en http://localhost:${port}`);
    console.log(`📦 Versión del código: sentinel1vhaverage-v2 (con image/tiff y pol.primary)`);
});

/*  */