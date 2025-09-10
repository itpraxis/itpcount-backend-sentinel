// server.js (versión corregida - obtención de NDVI promedio)
require('dotenv').config();
console.log('🔑 CLIENT_ID cargado:', process.env.CLIENT_ID ? '✅ Sí' : '❌ No');
console.log('🔐 CLIENT_SECRET cargado:', process.env.CLIENT_SECRET ? '✅ Sí' : '❌ No');

const express = require('express');
const cors = require('cors');
const app = express();

// ✅ Configuración CORS mejorada (sin espacios al final)
app.use(cors({
  origin: ['https://itpraxis.cl', 'https://www.itpraxis.cl'],
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
            width: 512,
            height: 512,
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
        bbox: geometryType === 'Polygon' ? polygonToBbox(geometry) : geometry
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
                width: 512,
                height: 512,
                format: "image/png"
            },
            evalscript: `//VERSION=3
			function setup() {
			  return {
				input: [{ bands: ["B08", "B04", "dataMask"], units: "REFLECTANCE" }],
				output: { bands: 1, sampleType: "UINT8" }  // ⬅️ CAMBIADO DE FLOAT32 A UINT8
			  };
			}
			function evaluatePixel(samples) {
			  if (samples.dataMask === 0) {
				return [0];  // ⬅️ Cambiado de NaN a 0 para UINT8
			  }
			  
			  const nir = samples.B08;
			  const red = samples.B04;
			  const ndvi = (nir - red) / (nir + red);
			  
			  // Clasificación correcta de vegetación con umbral realista
			  if (ndvi > 0.3) {
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

app.listen(port, '0.0.0.0', () => {
    console.log(`✅ Backend listo en http://localhost:${port}`);
});