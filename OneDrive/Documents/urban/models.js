/**
 * MongoDB Models — using Mongoose
 * Install: npm install mongoose
 */

const mongoose = require('mongoose');

// -----------------------------------------------------------------------
// 1. SEARCH HISTORY — every location searched, with the weather snapshot
//    Use case: "recently searched" list, popularity of zones, basic logs
// -----------------------------------------------------------------------
const searchHistorySchema = new mongoose.Schema({
  query: { type: String, required: true },          // what the user typed/spoke
  name: { type: String, required: true },            // resolved place name (from Nominatim)
  lat: { type: Number, required: true },
  lon: { type: Number, required: true },
  temp: { type: Number, required: true },
  feelsLike: { type: Number },
  humidity: { type: Number },
  windSpeed: { type: Number },
  isHot: { type: Boolean, required: true },
  searchedAt: { type: Date, default: Date.now }
});

const SearchHistory = mongoose.model('SearchHistory', searchHistorySchema);


// -----------------------------------------------------------------------
// 2. DAILY WEATHER LOG — one snapshot per location per day
//    Use case: trend charts ("how has this city's heat changed over a week")
//    Unique index on (lat, lon, date) prevents duplicate same-day entries
// -----------------------------------------------------------------------
const weatherLogSchema = new mongoose.Schema({
  locationName: { type: String, required: true },
  lat: { type: Number, required: true },
  lon: { type: Number, required: true },
  temp: { type: Number, required: true },
  humidity: { type: Number, required: true },
  windSpeed: { type: Number },
  classification: { type: String, enum: ['DANGER', 'HOT', 'WARM', 'COOL'], required: true },
  date: { type: String, required: true },  // store as 'YYYY-MM-DD' for easy daily grouping
  recordedAt: { type: Date, default: Date.now }
});

weatherLogSchema.index({ lat: 1, lon: 1, date: 1 }, { unique: true });

const WeatherLog = mongoose.model('WeatherLog', weatherLogSchema);


// -----------------------------------------------------------------------
// 3. ML PREDICTIONS — store each Random Forest prediction + cooling simulation
//    Use case: revisit past hotspot analyses, build a history of interventions
// -----------------------------------------------------------------------
const predictionSchema = new mongoose.Schema({
  zoneName: { type: String, required: true },
  concretePct: { type: Number, required: true },
  vegetationPct: { type: Number, required: true },
  waterKm: { type: Number, required: true },
  predictedTemp: { type: Number, required: true },
  classification: { type: String, enum: ['DANGER', 'HOT', 'WARM', 'COOL'], required: true },
  featureImportance: {
    concrete: Number,
    vegetation: Number,
    waterDistance: Number
  },
  coolingSolutions: [
    {
      intervention: String,
      beforeTemp: Number,
      afterTemp: Number,
      coolingEffect: Number,
      rank: Number
    }
  ],
  predictedAt: { type: Date, default: Date.now }
});

const Prediction = mongoose.model('Prediction', predictionSchema);


module.exports = { SearchHistory, WeatherLog, Prediction };