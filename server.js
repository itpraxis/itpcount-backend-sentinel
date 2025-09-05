// server.js
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

    const payload = {
      input: {
        bounds: {
          geometry: {
            type: "Polygon",
            coordinates: [coordinates]
          }
        },
        data: [
          {
            dataFilter: {
              timeRange: {
                from: `${date}T00:00:00Z`,
                to: `${date}T23:59:59Z`
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
      throw new Error(`Error en imagen: ${error}`);
    }

    const buffer = await imageResponse.arrayBuffer();
    
    // ✅ Verificación de tamaño de imagen
    if (buffer.byteLength < 1000) {
      console.warn("⚠️ Advertencia: Tamaño de imagen muy pequeño, probablemente sin datos");
      return res.status(404).json({ 
        error: "No hay datos de imagen disponibles para estas coordenadas/fecha. Prueba con fechas alternativas (ej: 2023-01-15, 2023-09-15)" 
      });
    }

    const base64 = Buffer.from(buffer).toString('base64');
    const url = `data:image/png;base64,${base64}`;

    res.json({ url });

  } catch (error) {
    console.error('❌ Error:', error.message);
    res.status(500).json({ 
      error: error.message,
      suggestion: "Verifica que las coordenadas estén en formato [longitud, latitud] y prueba con fechas alternativas"
    });
  }
});

app.listen(port, '0.0.0.0', () => {
  console.log(`✅ Backend listo en http://localhost:${port}`);
});