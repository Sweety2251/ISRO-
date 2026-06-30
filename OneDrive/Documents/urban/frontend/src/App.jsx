import React, { useState, useEffect, useRef } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { Search, Mic, Satellite, Wind, MapPin, CheckCircle, RefreshCcw, Droplets, Clock, TrendingUp, Award } from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend, Cell } from 'recharts';

const App = () => {
  const mapContainer = useRef(null);
  const map = useRef(null);
  const recognitionRef = useRef(null);
  const silenceTimer = useRef(null);

  const [searchText, setSearchText] = useState("");
  const [isListening, setIsListening] = useState(false);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");
  const [activeTab, setActiveTab] = useState('heat');

  // --- ML INSIGHTS STATE ---
  const [zoneDistribution, setZoneDistribution] = useState([]);
  const [featureImportance, setFeatureImportance] = useState(null);
  const [coolingSolutions, setCoolingSolutions] = useState([]);
  const [mlLoading, setMlLoading] = useState(false);

  useEffect(() => {
    if (map.current) return;
    map.current = new maplibregl.Map({
      container: mapContainer.current,
      style: 'https://tiles.basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
      center: [78.9629, 20.5937],
      zoom: 4,
      pitch: 45,
    });
  }, []);

  // --- YOUTUBE STYLE AUTO-MIC ---
  const handleMicClick = () => {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) return alert("Chrome Required");

    recognitionRef.current = new SpeechRecognition();
    recognitionRef.current.lang = 'en-US';
    recognitionRef.current.interimResults = true;
    recognitionRef.current.continuous = true;

    recognitionRef.current.onstart = () => setIsListening(true);

    recognitionRef.current.onresult = (event) => {
      clearTimeout(silenceTimer.current); // Reset timer on every word

      const transcript = Array.from(event.results)
        .map(result => result[0].transcript)
        .join('');

      setSearchText(transcript);

      // AUTO-SEARCH AFTER 1.5 SECONDS OF SILENCE
      silenceTimer.current = setTimeout(() => {
        stopMicAndSearch(transcript);
      }, 1500);
    };

    recognitionRef.current.start();
  };

  const stopMicAndSearch = (finalQuery) => {
    if (recognitionRef.current) recognitionRef.current.stop();
    setIsListening(false);
    if (finalQuery.trim()) {
      runMagicTyping(finalQuery);
    }
  };

  const runMagicTyping = (text) => {
    let i = 0;
    setSearchText("");
    const interval = setInterval(() => {
      setSearchText(text.slice(0, i + 1));
      i++;
      if (i >= text.length) {
        clearInterval(interval);
        executeSearch(text);
      }
    }, 40);
  };

  const executeSearch = async (query) => {
    if (!query) return;
    setLoading(true);
    setErrorMsg("");
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
      const result = await res.json();

      if (!res.ok) {
        setErrorMsg(result.error || "Something went wrong");
        setLoading(false);
        return;
      }

      if (result.lat && result.geojson) {
        const bounds = new maplibregl.LngLatBounds();
        const extend = (c) => {
          if (typeof c[0] === 'number') bounds.extend(c);
          else c.forEach(extend);
        };
        extend(result.geojson.coordinates);

        map.current.fitBounds(bounds, {
          padding: 100,
          duration: 2500,
          maxZoom: 10 // Balanced zoom to keep context
        });

        renderNeonBorders(result.geojson, result.isHot);
        setData(result);
      } else {
        setErrorMsg("No boundary data found for this location");
      }
    } catch (e) {
      console.error(e);
      setErrorMsg("Could not reach backend — is server.js running on port 5000?");
    } finally {
      setLoading(false);
    }
  };

  const renderNeonBorders = (geojson, isHot) => {
    const color = isHot ? '#FF3131' : '#00D4FF';
    const layers = ['glow-out', 'glow-in', 'line-sharp'];

    layers.forEach(l => map.current.getLayer(l) && map.current.removeLayer(l));
    if (map.current.getSource('region')) map.current.removeSource('region');

    map.current.addSource('region', { type: 'geojson', data: geojson });

    map.current.addLayer({
      id: 'glow-out', type: 'line', source: 'region',
      paint: { 'line-color': color, 'line-width': 25, 'line-blur': 20, 'line-opacity': 0.5 }
    });
    map.current.addLayer({
      id: 'glow-in', type: 'line', source: 'region',
      paint: { 'line-color': color, 'line-width': 8, 'line-blur': 4, 'line-opacity': 0.8 }
    });
    map.current.addLayer({
      id: 'line-sharp', type: 'line', source: 'region',
      paint: { 'line-color': '#fff', 'line-width': 1.5 }
    });
  };

  // --- ML INSIGHTS: fetch zone distribution + feature importance ---
  const loadMLOverview = async () => {
    setMlLoading(true);
    try {
      const [zoneRes, importanceRes] = await Promise.all([
        fetch('/api/zone-distribution'),
        fetch('/api/feature-importance')
      ]);
      const zoneData = await zoneRes.json();
      const importanceData = await importanceRes.json();
      setZoneDistribution(zoneData.zones || []);
      setFeatureImportance(importanceData);
    } catch (e) {
      console.error("ML backend unreachable:", e);
    } finally {
      setMlLoading(false);
    }
  };

  // --- ML INSIGHTS: run cooling simulation for current searched zone's temp ---
  const runCoolingSimulation = async (currentTemp) => {
    try {
      const res = await fetch('/api/simulate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ current_temp: parseFloat(currentTemp) })
      });
      const result = await res.json();
      setCoolingSolutions(result.ranked_solutions || []);
    } catch (e) {
      console.error("Simulation failed:", e);
    }
  };

  useEffect(() => {
    if (activeTab === 'ml' && zoneDistribution.length === 0) {
      loadMLOverview();
    }
    if (activeTab === 'cool' && data && coolingSolutions.length === 0) {
      runCoolingSimulation(data.temp);
    }
  }, [activeTab, data]);

  // --- THE RESET FEATURE (DONE BUTTON) ---
  const handleDone = () => {
    // 1. Clear Data and Search
    setData(null);
    setSearchText("");
    setErrorMsg("");
    setCoolingSolutions([]);
    setActiveTab('heat');

    // 2. Remove Highlighting Layers
    const layers = ['glow-out', 'glow-in', 'line-sharp'];
    layers.forEach(l => map.current.getLayer(l) && map.current.removeLayer(l));
    if (map.current.getSource('region')) map.current.removeSource('region');

    // 3. Reset Map View
    map.current.flyTo({ center: [78.9629, 20.5937], zoom: 4, pitch: 45 });
  };

  return (
    <div style={{ width: '100vw', height: '100vh', background: '#000', position: 'relative' }}>

      {/* MAP */}
      <div ref={mapContainer} style={{ position: 'absolute', inset: 0, zIndex: 0 }} />

      {/* TOP BRANDING */}
      <div className="absolute top-3 left-3 sm:top-6 sm:left-6 z-20 flex items-center gap-2 sm:gap-4 bg-slate-900/90 p-2 sm:p-4 rounded-xl sm:rounded-2xl border border-blue-500/30 backdrop-blur-md">
        <div className="bg-blue-600 p-1.5 sm:p-2 rounded-lg"><Satellite className="text-white" size={18} /></div>
        <h1 className="text-white font-black text-sm sm:text-xl italic tracking-tighter hidden xs:block">BHUVAN_RADAR</h1>
      </div>

      {/* YOUTUBE STYLE MIC & SEARCH */}
      <div className="absolute top-20 sm:top-6 left-1/2 -translate-x-1/2 z-20 w-full max-w-xl px-3 sm:px-4">
        <div className={`flex items-center bg-slate-900/95 border-2 ${isListening ? 'border-red-500 shadow-[0_0_30px_rgba(239,68,68,0.4)]' : 'border-white/10'} rounded-2xl sm:rounded-3xl backdrop-blur-xl transition-all`}>
          <Search className="ml-3 sm:ml-6 text-slate-500 shrink-0" size={18} />
          <input
            className="w-full min-w-0 bg-transparent p-3 sm:p-6 text-white font-bold outline-none text-sm sm:text-base"
            placeholder={isListening ? "Listening..." : "Search a location..."}
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && executeSearch(searchText)}
          />
          <button
            onClick={handleMicClick}
            className={`p-3 sm:p-6 relative shrink-0 ${isListening ? 'bg-red-600 rounded-r-2xl sm:rounded-r-3xl' : 'hover:bg-white/5 rounded-r-2xl sm:rounded-r-3xl'}`}
          >
            <Mic className="text-white" size={18} />
            {isListening && (
              <span className="absolute inset-0 rounded-r-2xl sm:rounded-r-3xl bg-red-600 animate-ping opacity-25"></span>
            )}
          </button>
        </div>
        {loading && (
          <div className="mt-2 text-center text-[9px] sm:text-[10px] font-bold uppercase tracking-widest text-blue-400 animate-pulse">
            Fetching live data...
          </div>
        )}
        {errorMsg && (
          <div className="mt-2 text-center text-[9px] sm:text-[10px] font-bold uppercase tracking-widest text-red-400 px-2">
            {errorMsg}
          </div>
        )}
      </div>

      {/* STANDALONE ML INSIGHTS TOGGLE (works even before any search) */}
      {!data && (
        <button
          onClick={() => { setData({ standalone: true, temp: '42.0', isHot: true, name: 'Sample Zone Analysis' }); setActiveTab('ml'); }}
          className="absolute top-36 sm:top-32 right-3 sm:right-6 z-20 flex items-center gap-2 bg-emerald-600/90 hover:bg-emerald-500 text-white px-3 sm:px-5 py-2 sm:py-3 rounded-xl sm:rounded-2xl font-black text-[9px] sm:text-[10px] uppercase tracking-widest shadow-xl backdrop-blur-md"
        >
          <TrendingUp size={13} /> <span className="hidden xs:inline">View </span>ML Insights
        </button>
      )}

      {/* DATA TABLE */}
      {data && (
        <div className="absolute inset-x-3 bottom-24 sm:inset-x-auto sm:bottom-auto sm:top-6 sm:right-6 z-20 w-auto sm:w-80 max-h-[60vh] sm:max-h-[85vh] overflow-y-auto space-y-3 sm:space-y-4">
          <div className="flex bg-slate-900/95 p-1 rounded-xl sm:rounded-2xl border border-white/10 backdrop-blur-md">
            <button onClick={() => setActiveTab('heat')} className={`flex-1 py-2 sm:py-3 rounded-lg sm:rounded-xl text-[9px] sm:text-[10px] font-black uppercase ${activeTab === 'heat' ? 'bg-red-600' : 'text-slate-500'}`}>Heat</button>
            <button onClick={() => setActiveTab('cool')} className={`flex-1 py-2 sm:py-3 rounded-lg sm:rounded-xl text-[9px] sm:text-[10px] font-black uppercase ${activeTab === 'cool' ? 'bg-blue-600' : 'text-slate-500'}`}>Cooling</button>
            <button onClick={() => setActiveTab('ml')} className={`flex-1 py-2 sm:py-3 rounded-lg sm:rounded-xl text-[9px] sm:text-[10px] font-black uppercase ${activeTab === 'ml' ? 'bg-emerald-600' : 'text-slate-500'}`}>ML</button>
          </div>

          <div className="bg-slate-900/95 border border-white/10 rounded-2xl sm:rounded-[2.5rem] p-4 sm:p-8 backdrop-blur-xl shadow-2xl">
            <div className="flex items-center gap-2 mb-4 sm:mb-6">
              <MapPin size={14} className={data.isHot ? 'text-red-500' : 'text-blue-400'} />
              <span className="text-[9px] sm:text-[10px] font-bold uppercase truncate tracking-tighter text-slate-400">{data.name}</span>
            </div>

            {activeTab === 'heat' && (
              <div className="space-y-4">
                <div className={`text-center py-3 rounded-xl font-black text-xs border ${data.isHot ? 'border-red-500 text-red-500 bg-red-500/5' : 'border-blue-500 text-blue-500 bg-blue-500/5'}`}>
                  STATE: {data.isHot ? 'CRITICAL' : 'OPTIMAL'}
                </div>
                <div className="space-y-3">
                  <Row label="Temperature" value={`${data.temp}°C`} color={data.isHot ? 'text-red-500' : 'text-blue-400'} />
                  <Row label="Feels Like" value={`${data.feelsLike}°C`} />
                  <Row icon={<Droplets size={12} />} label="Humidity" value={`${data.humidity}%`} />
                  <Row icon={<Wind size={12} />} label="Wind Speed" value={`${data.windSpeed} km/h`} />
                  <Row icon={<Clock size={12} />} label="Observed" value={formatTime(data.observedAt)} />
                </div>
              </div>
            )}

            {activeTab === 'cool' && (
              <div className="space-y-3">
                <p className="text-[9px] sm:text-[10px] text-slate-500 uppercase font-bold mb-3">
                  Cooling Simulation (base: {data.temp}°C)
                </p>
                {coolingSolutions.length === 0 ? (
                  <p className="text-[11px] text-slate-500">Loading simulation...</p>
                ) : (
                  coolingSolutions.map((sol) => (
                    <div key={sol.intervention} className="bg-white/5 rounded-xl p-2.5 sm:p-3 border border-white/10">
                      <div className="flex justify-between items-center mb-1">
                        <span className="flex items-center gap-1 text-[10px] font-black text-emerald-400 uppercase">
                          <Award size={11} /> #{sol.rank} {sol.intervention}
                        </span>
                        <span className="text-[10px] font-mono text-emerald-400">-{sol.cooling_effect}°C</span>
                      </div>
                      <div className="flex justify-between text-[11px] font-mono">
                        <span className="text-slate-400">{sol.classification_before.emoji} {sol.before_temp}°C</span>
                        <TrendingUp size={12} className="text-slate-600" />
                        <span className="text-emerald-300">{sol.classification_after.emoji} {sol.after_temp}°C</span>
                      </div>
                    </div>
                  ))
                )}
              </div>
            )}

            {activeTab === 'ml' && (
              <div className="space-y-5">
                {mlLoading && <p className="text-[11px] text-slate-500">Training & loading model...</p>}

                {zoneDistribution.length > 0 && (
                  <div>
                    <p className="text-[10px] text-slate-500 uppercase font-bold mb-2">Zone Temp Distribution (Random Forest)</p>
                    <ResponsiveContainer width="100%" height={140}>
                      <BarChart data={zoneDistribution}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#ffffff10" />
                        <XAxis dataKey="name" tick={{ fill: '#64748b', fontSize: 9 }} />
                        <YAxis tick={{ fill: '#64748b', fontSize: 9 }} />
                        <Tooltip contentStyle={{ background: '#0f172a', border: '1px solid #334155', fontSize: 11 }} />
                        <Bar dataKey="predicted_temp" radius={[4, 4, 0, 0]}>
                          {zoneDistribution.map((z, i) => (
                            <Cell key={i} fill={z.classification.color} />
                          ))}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                )}

                {featureImportance && (
                  <div>
                    <p className="text-[10px] text-slate-500 uppercase font-bold mb-2">Feature Importance (Gini)</p>
                    <ResponsiveContainer width="100%" height={120}>
                      <BarChart
                        layout="vertical"
                        data={[
                          { name: 'Concrete', value: featureImportance.Concrete },
                          { name: 'Vegetation', value: featureImportance.Vegetation },
                          { name: 'Water Dist.', value: featureImportance['Water Distance'] },
                        ]}
                      >
                        <XAxis type="number" tick={{ fill: '#64748b', fontSize: 9 }} />
                        <YAxis dataKey="name" type="category" tick={{ fill: '#94a3b8', fontSize: 9 }} width={70} />
                        <Tooltip contentStyle={{ background: '#0f172a', border: '1px solid #334155', fontSize: 11 }} />
                        <Bar dataKey="value" fill="#FF8C00" radius={[0, 4, 4, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                )}

                <p className="text-[9px] text-slate-600 leading-relaxed pt-2 border-t border-white/5">
                  Model: RandomForestRegressor (n_estimators=10, random_state=42) · StandardScaler normalization · Trained on concrete%, vegetation%, water distance.
                </p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* DONE BUTTON (BOTTOM RIGHT) */}
      <button
        onClick={handleDone}
        className="absolute bottom-3 right-3 sm:bottom-8 sm:right-8 z-30 group flex items-center gap-2 sm:gap-3 bg-emerald-600 hover:bg-emerald-500 text-white px-4 sm:px-8 py-2.5 sm:py-4 rounded-xl sm:rounded-2xl font-black text-xs sm:text-sm tracking-widest shadow-2xl transition-all active:scale-95"
      >
        <CheckCircle size={16} />
        <span className="hidden xs:inline">DONE</span>
        <div className="w-6 h-6 sm:w-8 sm:h-8 bg-white/20 rounded-md sm:rounded-lg flex items-center justify-center group-hover:rotate-180 transition-transform">
          <RefreshCcw size={12} />
        </div>
      </button>

      {/* FOOTER BAR */}
      <div className="hidden sm:block absolute bottom-8 left-8 z-20 p-4 border-l-2 border-blue-600 bg-slate-900/40 text-blue-400 font-mono text-[9px] tracking-widest backdrop-blur-sm uppercase">
        Live Weather Feed: Open-Meteo <br />
        Coordinate System: WGS84
      </div>

    </div>
  );
};

const formatTime = (isoString) => {
  if (!isoString) return '—';
  try {
    const t = isoString.split('T')[1];
    return t || isoString;
  } catch {
    return isoString;
  }
};

const Row = ({ label, value, color = "text-white", icon = null }) => (
  <div className="flex justify-between items-center border-b border-white/5 pb-2">
    <span className="text-[10px] text-slate-500 font-black uppercase flex items-center gap-1">
      {icon}{label}
    </span>
    <span className={`font-mono font-bold ${color}`}>{value}</span>
  </div>
);

export default App;