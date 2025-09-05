// server.js (versión con fallback automático)
require('dotenv').config();
console.log('🔑 CLIENT_ID cargado:', process.env.CLIENT_ID ? '✅ Sí' : '❌ No');
console.log('🔐 CLIENT_SECRET cargado:', process.env.CLIENT_SECRET ? '✅ Sí' : '❌ No');

const express = require('express');
const cors = require('cors');
const app = express();

// ✅ Configuración CORS mejorada
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
    // ✅ URLs corregidas (sin espacios)
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
           [
            {
              dataFilter: {
                timeRange: {
                  from: `${attemptDate}T00:00:00Z`,
                  to: `${attemptDate}T23:59:59Z`
                },
                maxCloudCoverage: 20
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

          // Ajuste de contraste para valores muy bajos (especial para Chile)
          function evaluatePixel(sample) {
            // Valores típicos para Sentinel-2 L2A en zonas forestales chilenas
            const MIN_VAL = 0;
            const MAX_VAL = 2500;
            
            // Calcular valores normalizados
            let r = (sample.B04 - MIN_VAL) / (MAX_VAL - MIN_VAL);
            let g = (sample.B03 - MIN_VAL) / (MAX_VAL - MIN_VAL);
            let b = (sample.B02 - MIN_VAL) / (MAX_VAL - MIN_VAL);
            
            // Ajuste no lineal para mejorar contraste en valores bajos
            const gamma = 1.5;
            r = Math.pow(r, gamma);
            g = Math.pow(g, gamma);
            b = Math.pow(b, gamma);
            
            // Asegurar valores en rango [0, 1]
            return [
              Math.max(0, Math.min(r, 1)),
              Math.max(0, Math.min(g, 1)),
              Math.max(0, Math.min(b, 1))
            ];
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
        throw new Error(`Error en imagen para ${attemptDate}: ${error}`);
      }

      const buffer = await imageResponse.arrayBuffer();
      
      // ✅ Verificación de tamaño de imagen
      if (buffer.byteLength < 1000) {
        throw new Error(`Imagen demasiado pequeña para ${attemptDate}`);
      }

      const base64 = Buffer.from(buffer).toString('base64');
      return {
        url: `data:image/png;base64,${base64}`,
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
      suggestion: "Verifica que las coordenadas estén en formato [longitud, latitud] y que estén dentro de la cobertura de Sentinel-2"
    });
  }
});

app.listen(port, '0.0.0.0', () => {
  console.log(`✅ Backend listo en http://localhost:${port}`);
});