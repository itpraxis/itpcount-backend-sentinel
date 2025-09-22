// server.js (versión corregida - obtención de NDVI promedio)
require('dotenv').config();
console.log('🔑 CLIENT_ID cargado:', process.env.CLIENT_ID ? '✅ Sí' : '❌ No');
console.log('🔐 CLIENT_SECRET cargado:', process.env.CLIENT_SECRET ? '✅ Sí' : '❌ No');

const express = require('express');
const cors = require('cors');
const app = express();

// ✅ Configuración CORS mejorada (sin espacios al final)
app.use(cors({
  origin: ['https://itpraxis.cl', 'https://www.itpraxis.cl'], // ✅ ESPACIOS ELIMINADOS
  methods: ['POST', 'GET'],
  allowedHeaders: ['Content-Type'],
  credentials: true
}));

app.use(express.json());

const port = process.env.PORT || 3001;

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
 * ✅ NUEVA: Calcula el área aproximada de un polígono a partir de su bounding box.
 * @param {array} bbox - [minLon, minLat, maxLon, maxLat]
 * @returns {number} Área en metros cuadrados.
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

    return Math.abs(area);
}

/**
 * ✅ NUEVA: Calcula el tamaño óptimo de la imagen en píxeles.
 * @param {number} areaInSquareMeters - Área del polígono en metros cuadrados.
 * @param {number} resolutionInMeters - Resolución deseada en metros por píxel.
 * @returns {number} Tamaño en píxeles (ancho y alto).
 */
function calculateOptimalImageSize(areaInSquareMeters, resolutionInMeters) {
    // Calcular la longitud del lado de un cuadrado con el mismo área
    const sideLengthInMeters = Math.sqrt(areaInSquareMeters);

    // Calcular el número de píxeles necesarios para cubrir ese lado
    let sizeInPixels = Math.round(sideLengthInMeters / resolutionInMeters);

    // 🆕 AJUSTE CLAVE: Reducir el tamaño mínimo de 256 a 128 píxeles
    // Esto permite que polígonos muy pequeños se soliciten con una resolución más adecuada
    sizeInPixels = Math.max(128, Math.min(2048, sizeInPixels));

    return sizeInPixels;
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
    const areaInSquareMeters = calculatePolygonArea(bbox);
    const sizeInPixels = calculateOptimalImageSize(areaInSquareMeters, 10); // 10m de resolución

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
            width: sizeInPixels, // ✅ Tamaño adaptativo
            height: sizeInPixels, // ✅ Tamaño adaptativo
            format: "image/png",
            upsampling: "NEAREST",
            downsampling: "NEAREST",
            bands: 1,
            sampleType: "UINT8" // ⬅️ CORRECCIÓN: Cambiado de AUTO a UINT8 para imágenes
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
        bbox: bbox // ✅ Usamos el bbox calculado
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
    
    // ✅ NUEVO: Calcular el bbox y el área para determinar el tamaño óptimo
    const bbox = geometryType === 'Polygon' ? polygonToBbox(geometry) : geometry;
    if (!bbox) {
        throw new Error('No se pudo calcular el bounding box.');
    }
    const areaInSquareMeters = calculatePolygonArea(bbox);
    const sizeInPixels = calculateOptimalImageSize(areaInSquareMeters, 10); // 10m de resolución

    const payload = {
        input: {
            bounds: geometryType === 'Polygon' 
                ? { geometry: { type: "Polygon", coordinates: geometry } } 
                : { bbox: geometry },
            data: [  // ⚠️ ¡No olvides "data:"!
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
            width: sizeInPixels, // ✅ Tamaño adaptativo
            height: sizeInPixels, // ✅ Tamaño adaptativo
            format: "image/png",
            upsampling: "BICUBIC",
            downsampling: "BICUBIC",
            bands: 3,
            sampleType: "UINT8",
            renderingHints: {
                gamma: 0.8 // Ajusta entre 0.7 y 1.2
            }
        },
        evalscript: `
//VERSION=3

function setup() {
  return {
    input: [{ bands: ["B04", "B03", "B02"], units: "REFLECTANCE" }],
    output: { bands: 3, sampleType: "UINT8" }
  };
}

// Ajuste automático de contraste usando percentiles
// Estos valores (0.02 y 0.25) son un buen punto de partida, pero puedes ajustarlos
const minVal = 0.02; // Percentil bajo (2%)
const maxVal = 0.25; // Percentil alto (98%)

function evaluatePixel(samples) {
  let val = [samples.B04, samples.B03, samples.B02];
  let imgVals = val.map(v => 255 * (v - minVal) / (maxVal - minVal));
  imgVals = imgVals.map(v => Math.max(0, Math.min(255, v)));
  return imgVals;
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
        bbox: bbox // ✅ Usamos el bbox calculado
    };
};


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
        const areaInSquareMeters = calculatePolygonArea(bbox);
        const sizeInPixels = calculateOptimalImageSize(areaInSquareMeters, 10); // 10m de resolución

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
                width: sizeInPixels, // ✅ Tamaño adaptativo
                height: sizeInPixels, // ✅ Tamaño adaptativo
                format: "image/png"
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
    const { coordinates } = req.body;
    if (!coordinates) {
        return res.status(400).json({ error: 'Faltan parámetros requeridos: coordinates' });
    }
    const bbox = polygonToBbox(coordinates);
    if (!bbox) {
        return res.status(400).json({ error: 'Formato de coordenadas de polígono inválido.' });
    }
    try {
        let availableDates = await getAvailableDates(bbox, 70);
        if (availableDates.length === 0) {
            availableDates = await getAvailableDates(bbox, 100);
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
            evalscript: `// VERSION=3\nfunction setup() { return { input: ["B04"], output: { bands: 1 } }; }\nfunction evaluatePixel(sample) { return [1]; }`,
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
    const areaInSquareMeters = calculatePolygonArea(bbox);

    // ✅ NUEVO: Definir la resolución objetivo en metros por píxel
    // Sentinel-2 L2A tiene una resolución nativa de 10m para las bandas RGB.
    const targetResolutionInMeters = 10;

    // ✅ NUEVO: Calcular el tamaño de la imagen en píxeles basado en el área y la resolución
    const sizeInPixels = calculateOptimalImageSize(areaInSquareMeters, targetResolutionInMeters);

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
            width: sizeInPixels,
            height: sizeInPixels,
            format: "image/png",
            upsampling: "BICUBIC", // Mejor para ampliar
            downsampling: "BICUBIC", // Mejor para reducir
            bands: 4, // 3 bandas de color + 1 de máscara (alpha)
            sampleType: "UINT8"
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
        bbox: bbox
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
        const areaInSquareMeters = calculatePolygonArea(bbox);
        const sizeInPixels = calculateOptimalImageSize(areaInSquareMeters, 10); // 10m de resolución

        // ✅ NUEVO: Definir el payload principal
        const mainPayload = {
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
                            orbitDirection: "ASCENDING"
                        },
                        type: "sentinel-1-grd"
                    }
                ]
            },
            output: {
                width: sizeInPixels,
                height: sizeInPixels,
                format: "image/tiff", // ✅ Correcto para datos FLOAT32
                sampleType: "FLOAT32"
            },
            evalscript: `//VERSION=3
function setup() {
  return {
    input: [{ bands: ["VH", "dataMask"], units: "LINEAR_POWER" }], // ✅ Correcto para Sentinel-1
    output: { bands: 1, sampleType: "FLOAT32" }
  };
}
function evaluatePixel(samples) {
  if (samples.dataMask === 0) {
    return [0]; // Fondo/No datos
  }
  const vh_linear = samples.VH;
  const vh_db = 10 * Math.log10(vh_linear);
  return [vh_db];
}`
        };

        // ✅ NUEVO: Definir un payload de respaldo (fallback) con un evalscript radicalmente diferente
        // Esto "reseteará" el estado interno de la API si hay un bug.
        const fallbackPayload = {
            ...mainPayload,
            evalscript: `//VERSION=3 - FALLBACK REQUEST - VH_BAND_ONLY
function setup() {
  return {
    input: [{ bands: ["VH"], units: "LINEAR_POWER" }],
    output: { bands: 1, sampleType: "FLOAT32" }
  };
}
function evaluatePixel(samples) {
  const vh_linear = samples.VH;
  if (vh_linear <= 0) {
    return [0];
  }
  return [10 * Math.log10(vh_linear)];
}`
        };

        // ✅ NUEVO: Intentar primero con el payload principal
        let response = await fetch('https://services.sentinel-hub.com/api/v1/process', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${accessToken}`
            },
            body: JSON.stringify(mainPayload)
        });

        // ✅ NUEVO: Si falla, intentar con el payload de respaldo
        if (!response.ok) {
            console.warn('⚠️ La primera solicitud a Sentinel-1 falló. Intentando con payload de respaldo...');
            response = await fetch('https://services.sentinel-hub.com/api/v1/process', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${accessToken}`
                },
                body: JSON.stringify(fallbackPayload)
            });
        }

        // Si aún falla, lanzar el error
        if (!response.ok) {
            const error = await response.text();
            throw new Error(`Error en la API de Sentinel-Hub: ${error}`);
        }

        const buffer = await response.arrayBuffer();
        const float32Array = new Float32Array(buffer);
        
        let sum = 0;
        let count = 0;
        
        for (let i = 0; i < float32Array.length; i++) {
            const value = float32Array[i];
            if (!isNaN(value) && value !== 0) {
                sum += value;
                count++;
            }
        }
        
        const avgBiomassProxy = count > 0 ? sum / count : null;
        
        return {
            avgBiomassProxy: avgBiomassProxy,
            totalPixels: float32Array.length,
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


app.listen(port, '0.0.0.0', () => {
    console.log(`✅ Backend listo en http://localhost:${port}`);
});

