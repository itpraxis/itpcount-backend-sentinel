// server.js
require('dotenv').config();
console.log('🔑 CLIENT_ID cargado:', process.env.CLIENT_ID ? '✅ Sí' : '❌ No');
console.log('🔐 CLIENT_SECRET cargado:', process.env.CLIENT_SECRET ? '✅ Sí' : '❌ No');

const express = require('express');
const cors = require('cors');
const app = express();

// ✅ CORS corregido
app.use(cors({
  origin: 'https://itpraxis.cl',
  methods: ['POST'],
  allowedHeaders: ['Content-Type']
}));

app.use(express.json());

const port = process.env.PORT || 3001;

app.post('/api/sentinel2', async (req, res) => {
  const { coordinates, date } = req.body;

  try {
    // ✅ URLs sin espacios
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

		// Función para ajuste de contraste no lineal (mejor para valores bajos)
		function applyContrast(value, gamma = 1.8) {
		  return Math.pow(value, gamma);
		}

		function evaluatePixel(sample) {
		  // Valores mínimos y máximos típicos para Sentinel-2 L2A
		  const MIN_VAL = 0;
		  const MAX_VAL = 3000;
		  
		  // Calcular valores normalizados
		  let r = (sample.B04 - MIN_VAL) / (MAX_VAL - MIN_VAL);
		  let g = (sample.B03 - MIN_VAL) / (MAX_VAL - MIN_VAL);
		  let b = (sample.B02 - MIN_VAL) / (MAX_VAL - MIN_VAL);
		  
		  // Aplicar ajuste de contraste no lineal
		  r = applyContrast(r, 1.5);
		  g = applyContrast(g, 1.5);
		  b = applyContrast(b, 1.5);
		  
		  // Asegurar que los valores estén en rango [0, 1]
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
    const base64 = Buffer.from(buffer).toString('base64');
    const url = `data:image/png;base64,${base64}`;

    res.json({ url });

  } catch (error) {
    console.error('❌ Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.listen(port, '0.0.0.0', () => {
  console.log(`✅ Backend listo en http://localhost:${port}`);
});