require('dotenv').config();
console.log('🔑 CLIENT_ID cargado:', process.env.CLIENT_ID ? '✅ Sí' : '❌ No');
console.log('🔐 CLIENT_SECRET cargado:', process.env.CLIENT_SECRET ? '✅ Sí' : '❌ No');

const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors({
  origin: 'https://itpraxis.cl',
  methods: ['POST'],
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

const getAlternativeDates = (baseDate) => {
  const alternatives = [];
  const base = new Date(baseDate);

  for (let i = -7; i <= 7; i++) {
    if (i === 0) continue;

    const alternative = new Date(base);
    alternative.setDate(base.getDate() + i);

    const year = alternative.getFullYear();
    const month = String(alternative.getMonth() + 1).padStart(2, '0');
    const day = String(alternative.getDate()).padStart(2, '0');

    alternatives.push(`${year}-${month}-${day}`);
  }

  return alternatives;
};

app.post('/api/sentinel2', async (req, res) => {
  const { coordinates, date } = req.body;

//  if (!coordinates || !date) {
//    return res.status(400).json({
//      error: 'Faltan parámetros requeridos: coordinates y date'
//    });
//  }

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

    const tryGetImage = async (attemptDate) => {
      console.log('🔍 Verificando attemptDate:', attemptDate);
      // if (!attemptDate || typeof attemptDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(attemptDate)) {
      //    throw new Error(`Fecha inválida: ${attemptDate}`);
      // }

      console.log(`Intentando con fecha: ${attemptDate}`);

      const payload = {
        input: {
          bounds: {
            geometry: {
              type: "Polygon",
              coordinates: coordinates		// ✅ CORRECCIÓN FINAL
            }
          },
          data: [
            {
              dataFilter: {
                timeRange: {
				from: `${attemptDate}T00:00:00Z`, // ✅ CORRECCIÓN: Usar attemptDate
				to: `${attemptDate}T23:59:59Z` // ✅ CORRECCIÓN: Usar attemptDate
              },
              maxCloudCoverage: 100			// Original		80
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
            input: [{
                bands: ["B02", "B03", "B04"],
                // ✅ CAMBIO: Cambiar DN a REFLECTANCE
                units: "REFLECTANCE" 
            }],
            output: {
                bands: 3,
                sampleType: "AUTO"
            }
        };
    }
    
    function evaluatePixel(samples) {
        // Simple true-color visualization
        return [samples.B04, samples.B03, samples.B02];
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
		console.error(`❌ Error detallado de la API de Sentinel-Hub para ${attemptDate}:`, error); // ✅ AGREGAR ESTA LÍNEA
        throw new Error(`Error en imagen para ${attemptDate}: ${error}`);
      }

      const buffer = await imageResponse.arrayBuffer();

//      if (buffer.byteLength < 1000) {
//        throw new Error(`Imagen demasiado pequeña para ${attemptDate}`);
//      }

      const base64 = Buffer.from(buffer).toString('base64');
      return {
        url: `image/png;base64,${base64}`,
        usedDate: attemptDate
      };
    };

    let result;
    try {
      result = await tryGetImage(date);
      console.log(`✅ Éxito con fecha solicitada: ${date}`);
      return res.json(result);
    } catch (error) {
      console.warn(`⚠️ Falló con fecha solicitada: ${date} - ${error.message}`);
    }

    for (const alternativeDate of CHILE_DATES) {
      try {
        result = await tryGetImage(alternativeDate);
        console.log(`✅ Éxito con fecha alternativa (Chile): ${alternativeDate}`);
        return res.json({
          ...result,
          warning: `No se encontraron datos para ${date}. Usando datos de ${alternativeDate}.`
        });
      } catch (error) {
        console.warn(`⚠️ Falló con fecha alternativa (Chile): ${alternativeDate} - ${error.message}`);
      }
    }

    const nearbyDates = getAlternativeDates(date);
    for (const alternativeDate of nearbyDates) {
      try {
        result = await tryGetImage(alternativeDate);
        console.log(`✅ Éxito con fecha cercana: ${alternativeDate}`);
        return res.json({
          ...result,
          warning: `No se encontraron datos para ${date}. Usando datos de ${alternativeDate}.`
        });
      } catch (error) {
        console.warn(`⚠️ Falló con fecha cercana: ${alternativeDate} - ${error.message}`);
      }
    }

    return res.status(404).json({
      error: "No se encontraron datos de imagen para estas coordenadas en ninguna fecha disponible",
      suggestedDates: CHILE_DATES,
      request: { coordinates, date }
    });

  } catch (error) {
    console.error('❌ Error:', error.message);
    res.status(500).json({
      error: error.message,
      suggestion: "Verifica que las coordenadas estén en formato [longitud, latitud] y que el área esté en tierra firme"
    });
  }
});

app.listen(port, '0.0.0.0', () => {
  console.log(`✅ Backend listo en http://localhost:${port}`);
});

// NUEVO ENDPOINT: Verificar cobertura de Sentinel-2
app.post('/api/check-coverage', async (req, res) => {
  const { coordinates } = req.body;
  
  // Validación de entrada
  if (!coordinates) {
    return res.status(400).json({ 
      error: 'Faltan parámetros requeridos: coordinates' 
    });
  }

  try {
    // Obtener token de acceso (sin espacios en la URL)
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

    // ✅ CORRECCIÓN DEFINITIVA: Añadir "data:" con dos puntos
    const metadataPayload = {
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
              timeRange: {
                from: "2020-01-01T00:00:00Z",
                to: "2025-01-01T23:59:59Z"
              },
              maxCloudCoverage: 100
            },
            type: "sentinel-2-l2a"
          }
        ]
      },
      // ✅ CORRECCIÓN: format: "application/json" (no "image/png")
      output: {
        width: 50,
        height: 50,
        format: "application/json"
      },
      // ✅ Evalscript mínimo ES OBLIGATORIO
      evalscript: `
          // VERSION=3
          function setup() {
            return {
              input: ["B04", "B03", "B02"],
              output: {
                bands: 3,
                sampleType: "AUTO"
              }
            };
          }

          function evaluatePixel(sample) {
            const MAX_VAL = 3000;
            return [
              sample.B04 / MAX_VAL,
              sample.B03 / MAX_VAL,
              sample.B02 / MAX_VAL
            ];
          }
        `,
      // ✅ CORRECCIÓN: meta: { (con dos puntos)
      meta: {
        "availableDates": true
      }
    };

    // ✅ Sin espacios en la URL
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
    
    // Procesar las fechas disponibles
    let availableDates = [];
    if (metadata.metadata && metadata.metadata.availableDates) {
      availableDates = metadata.metadata.availableDates.map(date => date.split('T')[0]);
    }

    // Si no hay fechas disponibles, sugerir fechas cercanas
    if (availableDates.length === 0) {
      const today = new Date();
      const datesToSuggest = [];
      
      // Generar fechas en los últimos 6 meses
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

    // Ordenar fechas de más reciente a más antigua
    availableDates.sort((a, b) => new Date(b) - new Date(a));
    
    // Devolver las fechas disponibles
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

// NUEVO ENDPOINT: Verificar catálogo cobertura de Sentinel-2
app.post('/api/catalogo-coverage', async (req, res) => {
  const { coordinates } = req.body;

  // Validación de entrada
  if (!coordinates) {
    return res.status(400).json({
      error: 'Faltan parámetros requeridos: coordinates'
    });
  }

  try {
    // 1. Obtener token de acceso
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

    // 2. Construir la URL de la API de Catálogo
    const geometry = {
      type: "Polygon",
      coordinates: coordinates
    };
    const geometryString = JSON.stringify(geometry);
    const timeRange = "2020-01-01T00:00:00Z/2025-01-01T23:59:59Z";
    const collectionId = "sentinel-2-l2a";

    const catalogUrl = `https://services.sentinel-hub.com/api/v1/catalog/search?bbox=&datetime=${timeRange}&collections=${collectionId}&limit=100&query={"eo:cloud_cover": {"gte": 0, "lte": 100}}&intersects=${encodeURIComponent(geometryString)}`;
    
    // 3. Hacer la solicitud GET al endpoint de Catálogo
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

    // 4. Procesar las fechas disponibles
    const availableDates = catalogData.features
      .map(feature => feature.properties.datetime.split('T')[0])
      .filter((value, index, self) => self.indexOf(value) === index) // Eliminar duplicados
      .sort((a, b) => new Date(b) - new Date(a)); // Ordenar de más reciente a más antigua

    if (availableDates.length === 0) {
      return res.json({
        hasCoverage: false,
        message: "No hay datos de imagen disponibles para este área en el periodo de tiempo especificado."
      });
    }

    // Devolver las fechas disponibles
    return res.json({
      hasCoverage: true,
      totalDates: availableDates.length,
      availableDates: availableDates.slice(0, 30), // Devolver solo las 30 más recientes
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

// NUEVO ENDPOINT DE PRUEBA:
app.get('/api/sentinel-test', async (req, res) => {
  const testBbox = [13.0, 45.0, 14.0, 46.0];
  const testDate = '2024-03-25';

  console.log('--- Iniciando prueba de API simple ---');

  try {
    // 1. Obtener el token de acceso
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

    // 2. Construir el payload con bbox
    const payload = {
      input: {
        bounds: {
          bbox: testBbox,
          properties: {
            crs: "http://www.opengis.net/def/crs/OGC/1.3/CRS84"
          }
        },
        data: [
          {
            dataFilter: {
              timeRange: {
                from: `${testDate}T00:00:00Z`,
                to: `${testDate}T23:59:59Z`
              }
            },
            type: "sentinel-2-l2a"
          }
        ]
      },
      output: {
        width: 512,
        height: 512,
        responses: [
          {
            identifier: "default",
            format: {
              type: "image/jpeg"
            }
          }
        ]
      },
      evalscript: `
        //VERSION=3
        function setup() {
          return {
            input: [{
              bands: ["B04", "B03", "B02"],
              units: "REFLECTANCE"
            }],
            output: {
              bands: 3,
              sampleType: "AUTO"
            }
          };
        }
        function evaluatePixel(samples) {
          return [samples.B04, samples.B03, samples.B02];
        }
      `
    };

    // 3. Enviar la solicitud a la API
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
      console.error('❌ Error detallado de la API de Sentinel-Hub:', error);
      throw new Error(`Error en la solicitud de prueba: ${error}`);
    }

    const buffer = await imageResponse.arrayBuffer();
    // const base64 = Buffer.from(buffer).toString('base64'); // This line is not needed for the GET endpoint

    console.log(`✅ Prueba exitosa: Imagen de ${buffer.byteLength} bytes recibida.`);
    console.log('--- Prueba finalizada con éxito ---');

    // CONVERSIÓN NECESARIA: Convertir ArrayBuffer a Buffer antes de enviar la respuesta
    const nodeBuffer = Buffer.from(buffer);

    // Devolver la imagen para su visualización en el navegador
    res.set('Content-Type', 'image/jpeg');
    res.send(nodeBuffer); // ✅ Cambio de res.end a res.send para mayor compatibilidad
    

  } catch (error) {
    console.error('❌ Error en la prueba de API:', error.message);
    res.status(500).json({
      error: `Error en la prueba de API: ${error.message}`,
      suggestion: 'Verifica la conexión o contacta a soporte de Sentinel-Hub.'
    });
  }
});