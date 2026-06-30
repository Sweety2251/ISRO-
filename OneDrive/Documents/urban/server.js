/**
 * COMBINED SERVER — weather/geocoding + ML model + MongoDB persistence + serves the React frontend
 * One single deployable Node.js app. Run with: node server.js
 *
 * Requires: npm install express cors axios ml-random-forest mongoose
 * Env vars: MONGODB_URI (optional, defaults to local mongo), PORT (optional)
 */

require('dotenv').config();
console.log('DEBUG MONGODB_URI loaded:', process.env.MONGODB_URI ? 'YES' : 'NO (falling back to localhost)');

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');
const mongoose = require('mongoose');
const { RandomForestRegression } = require('ml-random-forest');
const { SearchHistory, WeatherLog, Prediction } = require('./models');

const app = express();
app.use(cors());
app.use(express.json());

// ===========================================================================
// PART 0 — MONGODB CONNECTION
// ===========================================================================
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/heatstress';

mongoose.connect(MONGODB_URI)
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => console.error('❌ MongoDB connection error:', err.message));

// ===========================================================================
// PART 1 — WEATHER + GEOCODING (was server.js)
// ===========================================================================
const cache = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000;

function classifyTemp(temp) {
  if (temp >= 50) return { label: "DANGER", color: "#FF3131", emoji: "🔴" };
  if (temp >= 45) return { label: "HOT", color: "#FF8C00", emoji: "🟠" };
  if (temp >= 40) return { label: "WARM", color: "#FFD700", emoji: "🟡" };
  return { label: "COOL", color: "#00D26A", emoji: "🟢" };
}

app.get('/api/search', async (req, res) => {
  const { q } = req.query;
  if (!q) return res.status(400).json({ error: "Missing query" });

  try {
    const geoResponse = await axios.get(`https://nominatim.openstreetmap.org/search`, {
      params: { q, format: 'json', polygon_geojson: 1, limit: 1, addressdetails: 1 },
      headers: { 'User-Agent': 'ISRO_Thermal_Scanner_v3' },
      timeout: 8000
    });

    if (!geoResponse.data || geoResponse.data.length === 0) {
      return res.status(404).json({ error: "Location not found" });
    }

    const loc = geoResponse.data[0];
    const lat = parseFloat(loc.lat);
    const lon = parseFloat(loc.lon);

    const cacheKey = `${lat.toFixed(3)},${lon.toFixed(3)}`;
    const cached = cache.get(cacheKey);
    let weather;

    if (cached && (Date.now() - cached.timestamp < CACHE_TTL_MS)) {
      weather = cached.weather;
    } else {
      const weatherResponse = await axios.get('https://api.open-meteo.com/v1/forecast', {
        params: {
          latitude: lat,
          longitude: lon,
          current: 'temperature_2m,relative_humidity_2m,wind_speed_10m,apparent_temperature',
          timezone: 'auto'
        },
        timeout: 8000
      });

      if (!weatherResponse.data || !weatherResponse.data.current) {
        throw new Error('Weather provider returned no current data');
      }

      const current = weatherResponse.data.current;
      weather = {
        temp: current.temperature_2m,
        feelsLike: current.apparent_temperature,
        humidity: current.relative_humidity_2m,
        windSpeed: current.wind_speed_10m,
        observedAt: current.time
      };

      cache.set(cacheKey, { weather, timestamp: Date.now() });
    }

    const isHot = weather.temp >= 35;

    // --- Persist to SearchHistory (fire-and-forget, don't block the response on failure) ---
    SearchHistory.create({
      query: q,
      name: loc.display_name,
      lat, lon,
      temp: weather.temp,
      feelsLike: weather.feelsLike,
      humidity: weather.humidity,
      windSpeed: weather.windSpeed,
      isHot
    }).catch(err => console.error('⚠️  Failed to save SearchHistory:', err.message));

    // --- Upsert today's WeatherLog for this location (unique on lat/lon/date) ---
    const today = new Date().toISOString().split('T')[0]; // 'YYYY-MM-DD'
    WeatherLog.findOneAndUpdate(
      { lat, lon, date: today },
      {
        locationName: loc.display_name,
        lat, lon,
        temp: weather.temp,
        humidity: weather.humidity,
        windSpeed: weather.windSpeed,
        classification: classifyTemp(weather.temp).label,
        date: today
      },
      { upsert: true, returnDocument: 'after' }
    ).catch(err => console.error('⚠️  Failed to upsert WeatherLog:', err.message));

    res.json({
      lat, lon,
      name: loc.display_name,
      geojson: loc.geojson,
      isHot,
      temp: weather.temp.toFixed(1),
      feelsLike: weather.feelsLike.toFixed(1),
      humidity: weather.humidity,
      windSpeed: weather.windSpeed,
      observedAt: weather.observedAt
    });

  } catch (e) {
    console.error(e.message);
    res.status(500).json({ error: "Server Error", details: e.message });
  }
});

// New: read endpoint for recent search history
app.get('/api/history', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const history = await SearchHistory.find().sort({ searchedAt: -1 }).limit(limit);
    res.json(history);
  } catch (e) {
    res.status(500).json({ error: "Server Error", details: e.message });
  }
});

// New: read endpoint for a location's weather log trend (by lat/lon)
app.get('/api/weather-log', async (req, res) => {
  try {
    const { lat, lon } = req.query;
    if (!lat || !lon) return res.status(400).json({ error: "Missing lat/lon" });
    const logs = await WeatherLog.find({ lat: parseFloat(lat), lon: parseFloat(lon) }).sort({ date: 1 });
    res.json(logs);
  } catch (e) {
    res.status(500).json({ error: "Server Error", details: e.message });
  }
});

// ===========================================================================
// PART 2 — ML MODEL (was ml_server.js)
// ===========================================================================
function generateTrainingData(n = 200) {
  const X = []; const y = [];
  let seed = 42;
  const rand = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };

  for (let i = 0; i < n; i++) {
    const concrete = 10 + rand() * 85;
    const vegetation = rand() * 80;
    const water = 0.1 + rand() * 9.9;
    const noise = (rand() - 0.5) * 2.4;
    const temp = 28 + 0.22 * concrete - 0.15 * vegetation - 0.8 * (1 / (water + 0.5)) + noise;
    X.push([concrete, vegetation, water]);
    y.push(temp);
  }
  return { X, y };
}

const { X: trainX, y: trainY } = generateTrainingData(200);

function computeScaler(X) {
  const nFeatures = X[0].length;
  const means = new Array(nFeatures).fill(0);
  const stds = new Array(nFeatures).fill(0);
  for (let f = 0; f < nFeatures; f++) {
    const col = X.map(row => row[f]);
    const mean = col.reduce((a, b) => a + b, 0) / col.length;
    const variance = col.reduce((a, b) => a + (b - mean) ** 2, 0) / col.length;
    means[f] = mean;
    stds[f] = Math.sqrt(variance) || 1;
  }
  return { means, stds };
}
function scaleRow(row, scaler) {
  return row.map((val, i) => (val - scaler.means[i]) / scaler.stds[i]);
}

const scaler = computeScaler(trainX);
const scaledX = trainX.map(row => scaleRow(row, scaler));

let model;
let modelTrained = false;
try {
  model = new RandomForestRegression({ seed: 42, nEstimators: 50 });
  model.train(scaledX, trainY);
  modelTrained = true;
  console.log('✅ Random Forest trained successfully');
} catch (e) {
  console.error('⚠️  Random Forest training failed, retrying with different seed:', e.message);
  try {
    model = new RandomForestRegression({ seed: 7, nEstimators: 80 });
    model.train(scaledX, trainY);
    modelTrained = true;
    console.log('✅ Random Forest trained successfully on retry');
  } catch (e2) {
    console.error('❌ Random Forest training failed again:', e2.message);
  }
}

function meanAbsoluteError(preds, actual) {
  let sum = 0;
  for (let i = 0; i < preds.length; i++) sum += Math.abs(preds[i] - actual[i]);
  return sum / preds.length;
}
function shuffleArray(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}
function round1(n) { return Math.round(n * 10) / 10; }

function computeFeatureImportance() {
  const baselinePreds = model.predict(scaledX);
  const baselineError = meanAbsoluteError(baselinePreds, trainY);
  const importances = [];
  for (let f = 0; f < 3; f++) {
    const shuffledX = scaledX.map(row => [...row]);
    const colValues = shuffledX.map(row => row[f]);
    shuffleArray(colValues);
    shuffledX.forEach((row, i) => { row[f] = colValues[i]; });
    const shuffledPreds = model.predict(shuffledX);
    const shuffledError = meanAbsoluteError(shuffledPreds, trainY);
    importances.push(Math.max(0, shuffledError - baselineError));
  }
  const total = importances.reduce((a, b) => a + b, 0) || 1;
  return {
    Concrete: round1((importances[0] / total) * 100),
    Vegetation: round1((importances[1] / total) * 100),
    "Water Distance": round1((importances[2] / total) * 100)
  };
}
const cachedFeatureImportance = computeFeatureImportance();

const COOLING_COEFFICIENTS = { "Greening": -3.0, "Water Body": -2.5, "Cool Roofs": -1.5 };

app.get('/api/feature-importance', (req, res) => {
  res.json(cachedFeatureImportance);
});

app.post('/api/predict', async (req, res) => {
  const { zones } = req.body;
  if (!zones || !zones.length) return res.status(400).json({ error: "No zones provided" });

  const inputRows = zones.map(z => [z.concrete_pct, z.vegetation_pct, z.water_km]);
  const scaledRows = inputRows.map(row => scaleRow(row, scaler));
  const predictions = model.predict(scaledRows);

  const results = zones.map((zone, i) => {
    const temp = round1(predictions[i]);
    return {
      name: zone.name || `Zone ${i + 1}`,
      concrete_pct: zone.concrete_pct,
      vegetation_pct: zone.vegetation_pct,
      water_km: zone.water_km,
      predicted_temp: temp,
      classification: classifyTemp(temp)
    };
  });

  // --- Persist each zone prediction (fire-and-forget) ---
  Prediction.insertMany(results.map(r => ({
    zoneName: r.name,
    concretePct: r.concrete_pct,
    vegetationPct: r.vegetation_pct,
    waterKm: r.water_km,
    predictedTemp: r.predicted_temp,
    classification: r.classification.label,
    featureImportance: {
      concrete: cachedFeatureImportance.Concrete,
      vegetation: cachedFeatureImportance.Vegetation,
      waterDistance: cachedFeatureImportance["Water Distance"]
    }
  }))).catch(err => console.error('⚠️  Failed to save Predictions:', err.message));

  res.json({ results, feature_importance: cachedFeatureImportance });
});

app.post('/api/simulate', async (req, res) => {
  const currentTemp = parseFloat(req.body.current_temp ?? 40);
  const zoneName = req.body.zone_name || null; // optional: link simulation back to a named zone

  const solutions = Object.entries(COOLING_COEFFICIENTS).map(([intervention, coefficient]) => {
    const newTemp = round1(currentTemp + coefficient);
    return {
      intervention,
      before_temp: currentTemp,
      after_temp: newTemp,
      cooling_effect: Math.abs(coefficient),
      classification_before: classifyTemp(currentTemp),
      classification_after: classifyTemp(newTemp)
    };
  });
  const ranked = [...solutions].sort((a, b) => b.cooling_effect - a.cooling_effect);
  ranked.forEach((s, i) => { s.rank = i + 1; });

  // --- Persist simulation if a zone name was supplied ---
  if (zoneName) {
    Prediction.findOneAndUpdate(
      { zoneName },
      {
        $set: {
          coolingSolutions: ranked.map(s => ({
            intervention: s.intervention,
            beforeTemp: s.before_temp,
            afterTemp: s.after_temp,
            coolingEffect: s.cooling_effect,
            rank: s.rank
          }))
        }
      },
      { sort: { predictedAt: -1 } } // update the most recent prediction for that zone, if any
    ).catch(err => console.error('⚠️  Failed to save simulation:', err.message));
  }

  res.json({ ranked_solutions: ranked });
});

app.get('/api/zone-distribution', (req, res) => {
  const sampleZones = [
    { name: "Zone A", concrete_pct: 85, vegetation_pct: 5, water_km: 8 },
    { name: "Zone B", concrete_pct: 60, vegetation_pct: 25, water_km: 3 },
    { name: "Zone C", concrete_pct: 40, vegetation_pct: 45, water_km: 1.5 },
    { name: "Zone D", concrete_pct: 20, vegetation_pct: 65, water_km: 0.5 },
    { name: "Zone E", concrete_pct: 75, vegetation_pct: 10, water_km: 6 }
  ];
  const inputRows = sampleZones.map(z => [z.concrete_pct, z.vegetation_pct, z.water_km]);
  const scaledRows = inputRows.map(row => scaleRow(row, scaler));
  const predictions = model.predict(scaledRows);
  const zones = sampleZones.map((zone, i) => {
    const temp = round1(predictions[i]);
    return { name: zone.name, predicted_temp: temp, classification: classifyTemp(temp) };
  });
  res.json({ zones });
});

// New: read endpoint for past predictions
app.get('/api/predictions', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const predictions = await Prediction.find().sort({ predictedAt: -1 }).limit(limit);
    res.json(predictions);
  } catch (e) {
    res.status(500).json({ error: "Server Error", details: e.message });
  }
});

// ===========================================================================
// PART 3 — SERVE THE BUILT FRONTEND (production)
// ===========================================================================
const frontendBuildPath = path.join(__dirname, 'frontend', 'dist');
app.use(express.static(frontendBuildPath));

app.get('*', (req, res) => {
  res.sendFile(path.join(frontendBuildPath, 'index.html'));
});

// ===========================================================================
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Combined server running on port ${PORT}`);
  console.log(`📊 Random Forest trained on ${trainX.length} samples`);
});