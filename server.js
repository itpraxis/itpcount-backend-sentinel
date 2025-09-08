require('dotenv').config();
console.log('🔑 CLIENT_ID cargado:', process.env.CLIENT_ID ? '✅ Sí' : '❌ No');
console.log('🔐 CLIENT_SECRET cargado:', process.env.CLIENT_SECRET ? '✅ Sí' : '❌ No');

const express = require('express');
const cors = require('cors');
const app = express();

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
    // ✅ Validación mejorada para asegurar que el formato es correcto
    if (!coordinates || coordinates.length === 0 || !Array.isArray(coordinates[0])) {
        return null;
    }
    const polygonCoords = coordinates[0];
    if (!Array.isArray(polygonCoords)) {
        return null; // Retorna null si el primer elemento no es un array de coordenadas
    }
    let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
    polygonCoords.forEach(coord => {
        // ✅ Asegura que cada 'coord' es un array de al menos 2 elementos
        if (Array.isArray(coord) && coord.length >= 2) {
            const [lon, lat] = coord;
            minLon = Math.min(minLon, lon);
            minLat = Math.min(minLat, lat);
            maxLon = Math.max(maxLon, lon);
            maxLat = Math.max(maxLat, lat);
        }
    });
    // Si no se procesó ninguna coordenada válida, retorna null
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

// Función auxiliar para obtener fechas disponibles del catálogo (se agrega el parámetro de nubosidad)
// Función auxiliar para obtener fechas disponibles del catálogo (se agrega el parámetro de nubosidad)
const getAvailableDates = async (bbox, maxCloudCoverage) => {
    try {
        const accessToken = await getAccessToken();
        const catalogUrl = 'https://services.sentinel-hub.com/api/v1/catalog/1.0.0/search';
        
        // Se construye el cuerpo de la solicitud con el filtro en formato CQL2-JSON
        const payload = {
            "bbox": bbox,
            "datetime": "2020-01-01T00:00:00Z/2025-01-01T23:59:59Z",
            "collections": ["sentinel-2-l2a"],
            "limit": 100
        };

        console.log('Enviando payload al catálogo:', JSON.stringify(payload));
        
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
    const attemptDates = [date]; // Ya no se reintenta, el frontend ya envió una fecha válida
    for (const attemptDate of attemptDates) {
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
            return result;
        } catch (error) {
            console.warn(`⚠️ Falló con la fecha: ${attemptDate} - ${error.message}`);
        }
    }
    throw new Error("No se encontraron datos de imagen para estas coordenadas en ninguna de las fechas intentadas.");
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

app.post('/api/get-valid-dates', async (req, res) => {
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

// Nuevo endpoint para obtener fechas disponibles
app.post('/api/get-valid-dates2', async (req, res) => {
    const { coordinates } = req.body;
    if (!coordinates) {
        return res.status(400).json({ error: 'Faltan parámetros requeridos: coordinates' });
    }
    const bbox = polygonToBbox(coordinates);
    if (!bbox) {
        return res.status(400).json({ error: 'Formato de coordenadas de polígono inválido.' });
    }
    try {
        // Intento 1: Buscar fechas con baja nubosidad (<= 10%)
        let availableDates = await getAvailableDates(bbox, 10);
        if (availableDates.length === 0) {
            // Intento 2: Si no se encuentran, buscar con alta nubosidad (<= 100%)
            availableDates = await getAvailableDates(bbox, 100);
        }

        if (availableDates.length === 0) {
            return res.json({ hasCoverage: false, message: "No se encontraron imágenes para esta ubicación en el rango de fechas." });
        }
        res.json({
            hasCoverage: true,
            totalDates: availableDates.length,
            availableDates: availableDates.slice(0, 30), // Retornar las 30 más recientes
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
        
        // ✅ Se construye el cuerpo de la solicitud como un objeto JSON
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
            method: 'POST', // ✅ Se cambia el método a POST
            headers: {
                'Content-Type': 'application/json', // ✅ Se cambia el Content-Type a application/json
                'Authorization': `Bearer ${accessToken}`
            },
            body: JSON.stringify(payload) // ✅ Se envía el payload en el cuerpo de la solicitud
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