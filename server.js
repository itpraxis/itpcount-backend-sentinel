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

const CHILE_DATES = [
  '2024-03-25',
  '2023-09-15',
  '2022-12-01',
  '2023-03-15',
  '2022-10-10',
  '2023-06-21'
];

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
// LÓGICA REUTILIZABLE PARA LLAMAR A LA API DE SENTINEL
// ==============================================
const tryGetImage = async (accessToken, payload, attemptDate, geometryType) => {
  console.log(`🔍 Intentando con fecha: ${attemptDate} y tipo: ${geometryType}`);
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
  return { url: `image/png;base64,${base64}`, usedDate: attemptDate };
};

// ==============================================
// ENDPOINTS DE IMÁGENES
// ==============================================

app.post('/api/sentinel2', async (req, res) => {
  const { coordinates, date } = req.body;

  if (!coordinates || !date) {
    return res.status(400).json({
      error: 'Faltan parámetros requeridos: coordinates y date'
    });
  }

  try {
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
    const accessToken = tokenData.access_token;
    console.log('✅ access_token obtenido');

    // Generar fechas para reintentos
    const attemptDates = [date, ...getNearbyDates(date, 7)];
    let result;

    for (const attemptDate of attemptDates) {
      try {
        const payload = {
          input: {
            bounds: {
              geometry: {
                type: "Polygon",
                coordinates: coordinates
              }
            },
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
                input: [{ bands: ["B02", "B03", "B04"], units: "REFLECTANCE" }],
                output: { bands: 3, sampleType: "AUTO" }
              };
            }
            function evaluatePixel(samples) {
              return [samples.B04, samples.B03, samples.B02];
            }
          `
        };
        result = await tryGetImage(accessToken, payload, attemptDate, 'Polygon');
        console.log(`✅ Éxito con la fecha: ${attemptDate}`);
        if (attemptDate !== date) {
          result.warning = `No se encontraron datos para la fecha solicitada (${date}). Se utilizó la fecha ${attemptDate}.`;
        }
        return res.json(result);
      } catch (error) {
        console.warn(`⚠️ Falló con la fecha: ${attemptDate} - ${error.message}`);
      }
    }

    return res.status(404).json({
      error: "No se encontraron datos de imagen para estas coordenadas en ninguna de las fechas intentadas.",
      suggestedDates: CHILE_DATES,
      request: { coordinates, date }
    });

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

  try {
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
    const accessToken = tokenData.access_token;

    const attemptDates = [date, ...getNearbyDates(date, 7)];
    let result;

    for (const attemptDate of attemptDates) {
      try {
        const payload = {
          input: {
            bounds: {
              geometry: {
                type: "Polygon",
                coordinates: coordinates
              }
            },
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
                input: [{ bands: ["B02", "B03", "B04"], units: "REFLECTANCE" }],
                output: { bands: 3, sampleType: "AUTO" }
              };
            }
            function evaluatePixel(samples) {
              return [samples.B04, samples.B03, samples.B02];
            }
          `
        };
        result = await tryGetImage(accessToken, payload, attemptDate, 'Polygon');
        console.log(`✅ Éxito con la fecha: ${attemptDate}`);
        if (attemptDate !== date) {
          result.warning = `No se encontraron datos para la fecha solicitada (${date}). Se utilizó la fecha ${attemptDate}.`;
        }
        return res.json(result);
      } catch (error) {
        console.warn(`⚠️ Falló con la fecha: ${attemptDate} - ${error.message}`);
      }
    }

    return res.status(404).json({
      error: "No se encontraron datos de imagen para estas coordenadas en ninguna de las fechas intentadas.",
      suggestion: "Verifica que las coordenadas del polígono sean válidas y que el área esté en tierra firme"
    });

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
    const accessToken = tokenData.access_token;
    console.log('✅ Token obtenido');

    const attemptDates = [date, ...getNearbyDates(date, 7)];
    let result;

    for (const attemptDate of attemptDates) {
      try {
        const payload = {
          input: {
            bounds: {
              bbox: bbox,
              properties: {
                crs: "http://www.opengis.net/def/crs/OGC/1.3/CRS84"
              }
            },
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
                input: [{ bands: ["B02", "B03", "B04"], units: "REFLECTANCE" }],
                output: { bands: 3, sampleType: "AUTO" }
              };
            }
            function evaluatePixel(samples) {
              return [samples.B04, samples.B03, samples.B02];
            }
          `
        };
        result = await tryGetImage(accessToken, payload, attemptDate, 'bbox');
        console.log(`✅ Éxito con la fecha: ${attemptDate}`);
        if (attemptDate !== date) {
          result.warning = `No se encontraron datos para la fecha solicitada (${date}). Se utilizó la fecha ${attemptDate}.`;
        }
        return res.json(result);
      } catch (error) {
        console.warn(`⚠️ Falló con la fecha: ${attemptDate} - ${error.message}`);
      }
    }

    return res.status(404).json({
      error: "No se encontraron datos de imagen para estas coordenadas en ninguna de las fechas intentadas.",
      suggestion: "Verifica que las coordenadas del polígono sean válidas y que el área esté en tierra firme."
    });

  } catch (error) {
    console.error('❌ Error general:', error.message);
    res.status(500).json({
      error: error.message,
      suggestion: "Verifica que las coordenadas del polígono sean válidas y que el área esté en tierra firme."
    });
  }
});

// ==============================================
// ENDPOINTS DE METADATOS
// ==============================================

app.post('/api/check-coverage', async (req, res) => {
  const { coordinates } = req.body;
  
  if (!coordinates) {
    return res.status(400).json({  
      error: 'Faltan parámetros requeridos: coordinates'  
    });
  }

  // ✅ NUEVO: Convertir polígono a bbox
  const bbox = polygonToBbox(coordinates);
  if (!bbox) {
    return res.status(400).json({ error: 'Formato de coordenadas de polígono inválido.' });
  }

  try {
    const tokenResponse = await fetch('https://services.sentinel-hub.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=client_credentials&client_id=${process.env.CLIENT_ID}&client_secret=${process.env.CLIENT_SECRET}`
    });

    if (!tokenResponse.ok) {
      const error = await tokenResponse.text();
      throw new Error(`Error al obtener token: ${error}`);
    }

    const tokenData = await tokenResponse.json();
    const accessToken = tokenData.access_token;
    console.log('✅ access_token obtenido para verificar cobertura');

    const metadataPayload = {
      input: {
        bounds: {
          bbox: bbox, // ✅ NUEVO: Usar bbox en lugar de geometry
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
      evalscript: `
          // VERSION=3
          function setup() {
            return {
              input: ["B04", "B03", "B02"],
              output: { bands: 3, sampleType: "AUTO" }
            };
          }
          function evaluatePixel(sample) {
            const MAX_VAL = 3000;
            return [sample.B04 / MAX_VAL, sample.B03 / MAX_VAL, sample.B02 / MAX_VAL];
          }
        `,
      meta: {
        "availableDates": true
      }
    };

    const metadataResponse = await fetch('https://services.sentinel-hub.com/api/v1/process', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${accessToken}` },
      body: JSON.stringify(metadataPayload)
    });

    if (!metadataResponse.ok) {
      const error = await metadataResponse.text();
      throw new Error(`Error al obtener metadatos: ${error}`);
    }

    const metadata = await metadataResponse.json();
    
    let availableDates = [];
    if (metadata.metadata && metadata.metadata.availableDates) {
      availableDates = metadata.metadata.availableDates.map(date => date.split('T')[0]);
    }

    if (availableDates.length === 0) {
      const today = new Date();
      const datesToSuggest = [];
      
      for (let i = 0; i < 180; i++) {
        const date = new Date(today);
        date.setDate(today.getDate() - i);
        const dateString = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
        datesToSuggest.push(dateString);
      }
      
      return res.json({
        hasCoverage: false,
        message: "No hay datos disponibles para este área en las últimas 12 semanas",
        suggestedDates: datesToSuggest.slice(0, 10)
      });
    }

    availableDates.sort((a, b) => new Date(b) - new Date(a));
    
    return res.json({
      hasCoverage: true,
      totalDates: availableDates.length,
      availableDates: availableDates.slice(0, 30),
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

app.post('/api/catalogo-coverage', async (req, res) => {
  const { coordinates } = req.body;

  if (!coordinates) {
    return res.status(400).json({
      error: 'Faltan parámetros requeridos: coordinates'
    });
  }

  // ✅ NUEVO: Convertir polígono a bbox
  const bbox = polygonToBbox(coordinates);
  if (!bbox) {
    return res.status(400).json({ error: 'Formato de coordenadas de polígono inválido.' });
  }

  try {
    const tokenResponse = await fetch('https://services.sentinel-hub.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=client_credentials&client_id=${process.env.CLIENT_ID}&client_secret=${process.env.CLIENT_SECRET}`
    });

    if (!tokenResponse.ok) {
      const error = await tokenResponse.text();
      throw new Error(`Error al obtener token: ${error}`);
    }

    const tokenData = await tokenResponse.json();
    const accessToken = tokenData.access_token;
    console.log('✅ access_token obtenido para verificar cobertura');
    
    // ✅ NUEVO: usar bbox en la URL de catálogo
    const bboxString = bbox.join(',');
    const timeRange = "2020-01-01T00:00:00Z/2025-01-01T23:59:59Z";
    const collectionId = "sentinel-2-l2a";

    const catalogUrl = `https://services.sentinel-hub.com/api/v1/catalog/search?bbox=${bboxString}&datetime=${timeRange}&collections=${collectionId}&limit=100&query={"eo:cloud_cover": {"gte": 0, "lte": 100}}`;
    
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
      .sort((a, b) => new Date(b) - new Date(a));

    if (availableDates.length === 0) {
      return res.json({
        hasCoverage: false,
        message: "No hay datos de imagen disponibles para este área en el periodo de tiempo especificado."
      });
    }

    return res.json({
      hasCoverage: true,
      totalDates: availableDates.length,
      availableDates: availableDates.slice(0, 30),
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

// Endpoint de prueba (sin cambios)
app.get('/api/sentinel-test', async (req, res) => {
  const testBbox = [13.0, 45.0, 14.0, 46.0];
  const testDate = '2024-03-25';

  console.log('--- Iniciando prueba de API simple ---');

  try {
    const tokenResponse = await fetch('https://services.sentinel-hub.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=client_credentials&client_id=${process.env.CLIENT_ID}&client_secret=${process.env.CLIENT_SECRET}`
    });

    if (!tokenResponse.ok) {
      const error = await tokenResponse.text();
      throw new Error(`Error al obtener token de prueba: ${error}`);
    }

    const tokenData = await tokenResponse.json();
    const accessToken = tokenData.access_token;
    console.log('✅ Token de prueba obtenido');

    const payload = {
      input: {
        bounds: {
          bbox: testBbox,
          properties: { crs: "http://www.opengis.net/def/crs/OGC/1.3/CRS84" }
        },
        data: [{
          dataFilter: { timeRange: { from: `${testDate}T00:00:00Z`, to: `${testDate}T23:59:59Z` } },
          type: "sentinel-2-l2a"
        }]
      },
      output: {
        width: 512,
        height: 512,
        responses: [{ identifier: "default", format: { type: "image/jpeg" } }]
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
            return [samples.B04, samples.B03, samples.B02];
          }
        `
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
    res.status(500).json({
      error: `Error en la prueba de API: ${error.message}`,
      suggestion: 'Verifica la conexión o contacta a soporte de Sentinel-Hub.'
    });
  }
});


app.listen(port, '0.0.0.0', () => {
  console.log(`✅ Backend listo en http://localhost:${port}`);
});