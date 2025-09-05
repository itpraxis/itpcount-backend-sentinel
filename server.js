// server.js (versión definitiva - corregida y optimizada)
require('dotenv').config();
console.log('🔑 CLIENT_ID cargado:', process.env.CLIENT_ID ? '✅ Sí' : '❌ No');
console.log('🔐 CLIENT_SECRET cargado:', process.env.CLIENT_SECRET ? '✅ Sí' : '❌ No');

const express = require('express');
const cors = require('cors');
const app = express();

// ✅ Configuración CORS mejorada (sin espacios al final)
app.use(cors({
  origin: 'https://itpraxis.cl',
  methods: ['POST'],
  allowedHeaders: ['Content-Type'],
  credentials: true
}));

app.use(express.json());

const port = process.env.PORT || 3001;

// ✅ Fechas alternativas para Chile (ordenadas por probabilidad de éxito)
const CHILE_DATES = [
  '2023-01-15',   // Verano chileno (máxima probabilidad)
  '2023-09-15',   // Primavera
  '2022-12-01',   // Primera semana de verano
  '2023-03-15',   // Otoño
  '2022-10-10',   // Primavera
  '2023-06-21'    // Invierno (menor probabilidad)
];

// ✅ Función para obtener fechas alternativas cercanas
const getAlternativeDates = (baseDate) => {
  const alternatives = [];
  const base = new Date(baseDate);
  
  // Agregar 7 días hacia adelante y atrás
  for (let i = -7; i <= 7; i++) {
    if (i === 0) continue; // Saltar la fecha original
    
    const alternative = new Date(base);
    alternative.setDate(base.getDate() + i);
    
    // Formato YYYY-MM-DD
    const year = alternative.getFullYear();
    const month = String(alternative.getMonth() + 1).padStart(2, '0');
    const day = String(alternative.getDate()).padStart(2, '0');
    
    alternatives.push(`${year}-${month}-${day}`);
  }
  
  return alternatives;
};

app.post('/api/sentinel2', async (req, res) => {
  const { coordinates, date } = req.body;

  // ✅ Validación de entrada
  if (!coordinates || !date) {
    return res.status(400).json({ 
      error: 'Faltan parámetros requeridos: coordinates y date' 
    });
  }

  try {
    // ✅ Obtener token de acceso (sin espacios en la URL)
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
    console.log('✅ access_token obtenido');

    // ✅ Función para intentar obtener imagen
    const tryGetImage = async (attemptDate) => {
      console.log(`Intentando con fecha: ${attemptDate}`);
      
      const payload = {
        input: {
          bounds: {
            geometry: {
              type: "Polygon",
              coordinates: [coordinates]
            }
          },
          // ✅ CORRECCIÓN DEFINITIVA: data: [ (dos puntos obligatorios)
           [
            {
              dataFilter: {
                timeRange: {
                  from: `${attemptDate}T00:00:00Z`,
                  to: `${attemptDate}T23:59:59Z`
                },
                maxCloudCoverage: 80
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
        `
      };

      // ✅ Sin espacios en la URL
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
        throw new Error(`Error en imagen para ${attemptDate}: ${error}`);
      }

      const buffer = await imageResponse.arrayBuffer();
      
      // ✅ Verificación de tamaño de imagen
      if (buffer.byteLength < 1000) {
        throw new Error(`Imagen demasiado pequeña para ${attemptDate}`);
      }

      const base64 = Buffer.from(buffer).toString('base64');
      return {
        url: `image/png;base64,${base64}`,
        usedDate: attemptDate
      };
    };

    // ✅ Intentar con la fecha solicitada
    let result;
    try {
      result = await tryGetImage(date);
      console.log(`✅ Éxito con fecha solicitada: ${date}`);
      return res.json(result);
    } catch (error) {
      console.warn(`⚠️ Falló con fecha solicitada: ${date} - ${error.message}`);
    }

    // ✅ Intentar con fechas alternativas específicas para Chile
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

    // ✅ Intentar con fechas cercanas (±7 días)
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

    // ✅ Si todo falla, devolver error detallado
    return res.status(404).json({ 
      error: "No se encontraron datos de imagen para estas coordenadas en ninguna fecha disponible",
      suggestedDates: CHILE_DATES,
      request: { coordinates, date }
    });

  } catch (error) {
    console.error('❌ Error:', error.message);
    res.status(500).json({ 
      error: error.message,
      suggestion: "Verifica que las coordenadas estén en formato [longitud, latitud] con 4 decimales y que el área esté en tierra firme"
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

    // ✅ CORRECCIÓN DEFINITIVA:  [ (dos puntos obligatorios)
    const metadataPayload = {
      input: {
        bounds: {
          geometry: {
            type: "Polygon",
            coordinates: [coordinates]
          }
        },
         [
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
      // ✅ Mantener output mínimo
      output: {
        width: 512,
        height: 512,
        format: "image/png"
      },
      // ✅ Evalscript mínimo ES OBLIGATORIO
      evalscript: `
        // VERSION=3
        function setup() {
          return {
            input: ["B04"],
            output: { bands: 1 }
          };
        }
        function evaluatePixel(sample) {
          return [1];
        }
      `,
      // ✅ metadata (no meta)
      meta {
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
      suggestion: "Verifica que las coordenadas estén en formato [longitud, latitud] con 4 decimales y que el área esté en tierra firme"
    });
  }
});