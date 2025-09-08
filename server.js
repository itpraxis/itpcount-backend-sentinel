require('dotenv').config();
console.log('🔑 CLIENT_ID cargado:', process.env.CLIENT_ID ? '✅ Sí' : '❌ No');
console.log('🔐 CLIENT_SECRET cargado:', process.env.CLIENT_SECRET ? '✅ Sí' : '❌ No');

const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors({
    origin: 'https://itpraxis.cl',
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
    let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
    const polygonCoords = coordinates[0];
    polygonCoords.forEach(coord => {
        const [lon, lat] = coord;
        minLon = Math.min(minLon, lon);
        minLat = Math.min(minLat, lat);
        maxLon = Math.max(maxLon, lon);
        maxLat = Math.max(maxLat, lat);
    });
    return [minLon, minLat, maxLon, maxLat];
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

/**
 * Consulta el catálogo de Sentinel para obtener fechas disponibles.
 * @param {array} bbox - El bounding box del área.
 * @param {string} date - La fecha solicitada.
 * @returns {array} Una lista de fechas disponibles ordenadas por proximidad a la fecha solicitada.
 */
const getAvailableDates = async (bbox, date) => {
    try {
        const accessToken = await getAccessToken();
        const bboxString = bbox.join(',');
        const timeRange = "2020-01-01T00:00:00Z/2025-01-01T23:59:59Z"; // Rango amplio
        const collectionId = "sentinel-2-l2a";
        const catalogUrl = `https://services.sentinel-hub.com/api/v1/catalog/search?bbox=${bboxString}&datetime=${timeRange}&collections=${collectionId}&limit=100&query={"eo:cloud_cover": {"lte": 100}}`;
        const catalogResponse = await fetch(catalogUrl, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${accessToken}`
            }
        });

        if (!catalogResponse.ok) {
            const error = await catalogResponse.text();
            throw new Error(`Error al obtener datos del Catálogo: ${error}`);
        }
        const catalogData = await catalogResponse.json();
        const availableDates = catalogData.features
            .map(feature => feature.properties.datetime.split('T')[0])
            .filter((value, index, self) => self.indexOf(value) === index)
            .sort((a, b) => {
                const dateA = new Date(a);
                const dateB = new Date(b);
                const requestedDate = new Date(date);
                return Math.abs(dateA - requestedDate) - Math.abs(dateB - requestedDate);
            });
        return availableDates;
    } catch (error) {
        console.error('❌ Error en getAvailableDates:', error.message);
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
    
    let bbox = geometry;
    if (geometryType === 'Polygon') {
        bbox = polygonToBbox(geometry);
    }
    
    // Obtener la fecha más cercana del catálogo
    const availableDates = await getAvailableDates(bbox, date);
    if (availableDates.length === 0) {
        throw new Error("No se encontraron fechas disponibles en el catálogo para esta ubicación.");
    }
    
    const attemptDate = availableDates[0];

    try {
        const payload = {
            input: {
                bounds: geometryType === 'Polygon' ? { geometry: { type: "Polygon", coordinates: geometry } } : { bbox: geometry },
                data: [
                    {
                        dataFilter: {
                            timeRange: { from: `${attemptDate}T00:00:00Z`, to: `${attemptDate}T23:59:59Z` },
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
                downsampling: "NEAREST"
            },
            evalscript: `
                //VERSION=3
                function setup() {
                  return {
                    input: [{ bands: ["B04", "B03", "B02"], units: "REFLECTANCE" }],
                    output: { bands: 3, sampleType: "AUTO" }
                  };
                }
                function evaluatePixel(samples) {
                  return [2.5 * samples.B04, 2.5 * samples.B03, 2.5 * samples.B02];
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
            throw new Error(`Error en la imagen para ${attemptDate}: ${error}`);
        }
        
        const buffer = await imageResponse.arrayBuffer();
        const base64 = Buffer.from(buffer).toString('base64');
        const result = { url: `image/png;base64,${base64}`, usedDate: attemptDate };
        if (attemptDate !== date) {
            result.warning = `No se encontraron datos para la fecha solicitada (${date}). Se utilizó la fecha más cercana disponible: ${attemptDate}.`;
        }
        return result;

    } catch (error) {
        console.warn(`⚠️ Falló con la fecha: ${attemptDate} - ${error.message}`);
        throw new Error("No se pudo obtener la imagen con la fecha disponible. Intente con otro rango de fechas.");
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
        const availableDates = await getAvailableDates(bbox, req.body.date);
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
        const availableDates = await getAvailableDates(bbox, req.body.date);
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
// ENDPOINT DE PRUEBA
// ==============================================

app.get('/api/sentinel-test', async (req, res) => {
    const testBbox = [13.0, 45.0, 14.0, 46.0];
    const testDate = '2024-03-25';
    console.log('--- Iniciando prueba de API simple ---');
    try {
        const accessToken = await getAccessToken();
        const payload = {
            input: {
                bounds: { bbox: testBbox, properties: { crs: "http://www.opengis.net/def/crs/OGC/1.3/CRS84" } },
                data: [{ dataFilter: { timeRange: { from: `${testDate}T00:00:00Z`, to: `${testDate}T23:59:59Z` } }, type: "sentinel-2-l2a" }]
            },
            output: {
                width: 512,
                height: 512,
                responses: [{ identifier: "default", format: { type: "image/jpeg" } }]
            },
            evalscript: `//VERSION=3\nfunction setup() { return { input: [{ bands: ["B04", "B03", "B02"], units: "REFLECTANCE" }], output: { bands: 3, sampleType: "AUTO" } }; }\nfunction evaluatePixel(samples) { return [samples.B04, samples.B03, samples.B02]; }`
        };
        const imageResponse = await fetch('https://services.sentinel-hub.com/api/v1/process', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${accessToken}` },
            body: JSON.stringify(payload)
        });
        if (!imageResponse.ok) {
            const error = await imageResponse.text();
            console.error('❌ Error detallado de la API de Sentinel-Hub:', error);
            throw new Error(`Error en la solicitud de prueba: ${error}`);
        }
        const buffer = await imageResponse.arrayBuffer();
        const nodeBuffer = Buffer.from(buffer);
        console.log(`✅ Prueba exitosa: Imagen de ${nodeBuffer.byteLength} bytes recibida.`);
        console.log('--- Prueba finalizada con éxito ---');
        res.set('Content-Type', 'image/jpeg');
        res.send(nodeBuffer);
    } catch (error) {
        console.error('❌ Error en la prueba de API:', error.message);
        res.status(500).json({ error: `Error en la prueba de API: ${error.message}`, suggestion: 'Verifica la conexión o contacta a soporte de Sentinel-Hub.' });
    }
});

app.listen(port, '0.0.0.0', () => {
    console.log(`✅ Backend listo en http://localhost:${port}`);
});