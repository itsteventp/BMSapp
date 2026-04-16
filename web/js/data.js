/**
 * data.js — Shared data loader and filter state management.
 * Loads data from Supabase and exposes filtered data via localStorage.
 */

let _config = null;
export async function getConfig() {
  if (_config) return _config;
  try {
    const resp = await fetch('config.json');
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    _config = await resp.json();
    return _config;
  } catch (err) {
    console.error('❌ Failed to load config.json:', err);
    return {};
  }
}

// Fallbacks for local development if config.json is missing
const DEFAULT_SUPABASE_URL = 'https://jclxaletgxrjxkrgrrnp.supabase.co';
const DEFAULT_SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpjbHhhbGV0Z3hyanhrcmdycm5wIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYyODQ4NTYsImV4cCI6MjA5MTg2MDg1Nn0.7-h29Du4DgLZ7DBr5XoZSFP8E1s-jMUdw4BC5IkqniU';

let _rawData = null;

/** Load the pipeline data from Supabase. Cached after first call. */
export async function loadData() {
  if (_rawData) return _rawData;

  const config = await getConfig().catch(() => ({}));
  const supabaseUrl = config.SUPABASE_URL || DEFAULT_SUPABASE_URL;
  const supabaseKey = config.SUPABASE_ANON_KEY || DEFAULT_SUPABASE_ANON_KEY;

  const restHeaders = {
    'apikey': supabaseKey,
    'Authorization': `Bearer ${supabaseKey}`,
    'Content-Type': 'application/json',
  };

  console.log('📡 Loading data from Supabase…');

  /** Helper to fetch table with pagination using the resolved config */
  async function fetchTable(table) {
    const allRows = [];
    let offset = 0;
    const limit = 1000;

    while (true) {
      const url = `${supabaseUrl}/rest/v1/${table}?select=*&offset=${offset}&limit=${limit}`;
      const resp = await fetch(url, { headers: restHeaders });
      if (!resp.ok) throw new Error(`Failed to fetch ${table}: ${resp.status}`);
      const rows = await resp.json();
      allRows.push(...rows);
      if (rows.length < limit) break;
      offset += limit;
    }
    return allRows;
  }

  // Fetch all tables in parallel
  const [burgers, ingredients, burgerIngredients, locations] = await Promise.all([
    fetchTable('burgers'),
    fetchTable('ingredients'),
    fetchTable('burger_ingredients'),
    fetchTable('locations'),
  ]);

  // Build ingredient lookup
  const ingMap = new Map();
  for (const ing of ingredients) {
    ingMap.set(ing.id, { name: ing.name, category: ing.category, count: ing.usage_count });
  }

  // Build burger→ingredients lookup
  const burgerIngMap = new Map(); // burger_id → ingredient_id[]
  for (const bi of burgerIngredients) {
    if (!burgerIngMap.has(bi.burger_id)) burgerIngMap.set(bi.burger_id, []);
    burgerIngMap.get(bi.burger_id).push(bi.ingredient_id);
  }

  // Build burger→locations lookup
  const burgerLocMap = new Map(); // burger_id → location[]
  for (const loc of locations) {
    if (!burgerLocMap.has(loc.burger_id)) burgerLocMap.set(loc.burger_id, []);
    burgerLocMap.get(loc.burger_id).push(loc);
  }

  // Assemble classified burgers matching the original shape
  const classifiedBurgers = burgers.map(b => {
    const ingredientIds = burgerIngMap.get(b.id) || [];
    const rawIngredients = ingredientIds
      .map(id => ingMap.get(id))
      .filter(Boolean);
    const locs = (burgerLocMap.get(b.id) || []).map(l => ({
      id: l.id,
      branch: l.branch,
      address: l.address,
      phone: l.phone,
    }));

    return {
      id: b.id,
      restaurant: b.restaurant,
      burgerName: b.burger_name,
      description: b.description,
      city: b.city,
      locations: locs,
      ingredientIds,
      rawIngredients,
    };
  });

  // Build geocoded locations matching the original shape
  const geocodedLocations = locations.map(l => ({
    id: l.id,
    burgerId: l.burger_id,
    restaurant: l.restaurant,
    branch: l.branch,
    address: l.address,
    city: l.city,
    phone: l.phone,
    lat: l.lat,
    lng: l.lng,
    nearbyLocationIds: l.nearby_ids || [],
  }));

  // Build global ingredients
  const globalIngredients = ingredients.map(ing => ({
    id: ing.id,
    name: ing.name,
    category: ing.category,
    count: ing.usage_count,
  }));

  _rawData = { classifiedBurgers, globalIngredients, geocodedLocations };
  console.log(`✅ Loaded ${classifiedBurgers.length} burgers, ${globalIngredients.length} ingredients, ${geocodedLocations.length} locations`);
  return _rawData;
}

/* ═══ Filter State (localStorage) ═══ */

const STORAGE_KEY = 'bm-filters';

function getFilters() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || { ingredients: [], cities: [] };
  } catch { return { ingredients: [], cities: [] }; }
}

function saveFilters(f) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(f));
}

export function getExcludedIngredients() { return getFilters().ingredients; }
export function getExcludedCities() { return getFilters().cities; }

export function toggleIngredient(name) {
  const f = getFilters();
  const idx = f.ingredients.indexOf(name);
  if (idx === -1) f.ingredients.push(name);
  else f.ingredients.splice(idx, 1);
  saveFilters(f);
}

export function toggleCity(city) {
  const f = getFilters();
  const idx = f.cities.indexOf(city);
  if (idx === -1) f.cities.push(city);
  else f.cities.splice(idx, 1);
  saveFilters(f);
}

export function clearFilters() {
  saveFilters({ ingredients: [], cities: [] });
}

/** Apply current filters to the data and return filtered burgers + locations. */
export function applyFilters(data) {
  const excIng = new Set(getExcludedIngredients());
  const excCities = new Set(getExcludedCities());

  const filteredBurgers = data.classifiedBurgers.filter(b => {
    if (excCities.has(b.city)) return false;
    if (b.rawIngredients.some(ing => excIng.has(ing.name))) return false;
    return true;
  });

  const burgerIds = new Set(filteredBurgers.map(b => b.id));
  const filteredLocations = data.geocodedLocations.filter(l => burgerIds.has(l.burgerId));

  return { burgers: filteredBurgers, locations: filteredLocations };
}

/** Get all unique ingredients grouped by category. */
export function getIngredientsByCategory(data) {
  const map = new Map();
  for (const b of data.classifiedBurgers) {
    for (const ing of b.rawIngredients) {
      if (!map.has(ing.name)) {
        map.set(ing.name, { name: ing.name, category: ing.category, count: 0 });
      }
      map.get(ing.name).count++;
    }
  }
  const grouped = {};
  for (const ing of map.values()) {
    if (!grouped[ing.category]) grouped[ing.category] = [];
    grouped[ing.category].push(ing);
  }
  // Sort each category by count descending
  for (const cat in grouped) {
    grouped[cat].sort((a, b) => b.count - a.count);
  }
  return grouped;
}

/** Get all unique cities with burger counts. */
export function getCities(data) {
  const map = new Map();
  for (const b of data.classifiedBurgers) {
    map.set(b.city, (map.get(b.city) || 0) + 1);
  }
  return Array.from(map.entries())
    .map(([city, count]) => ({ city, count }))
    .sort((a, b) => b.count - a.count);
}

/* ═══ Nav Helper ═══ */
export function renderNav(activePage) {
  return `
    <nav class="nav">
      <div class="nav-brand"><span>🍔</span> Burger Master</div>
      <a href="index.html" class="nav-link ${activePage === 'filter' ? 'active' : ''}">Filtros</a>
      <a href="burgers.html" class="nav-link ${activePage === 'burgers' ? 'active' : ''}">Burgers</a>
      <a href="map.html" class="nav-link ${activePage === 'map' ? 'active' : ''}">Mapa</a>
    </nav>`;
}

/* ═══ Haversine Distance ═══ */
export function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Category labels in Spanish */
export const CATEGORY_LABELS = {
  pan: 'Pan', proteina: 'Proteína', queso: 'Queso', salsa: 'Salsa',
  topping: 'Topping', condimento: 'Condimento', vegetal: 'Vegetal', otro: 'Otro',
};

export const CATEGORY_ORDER = ['pan','proteina','queso','salsa','topping','condimento','vegetal','otro'];
