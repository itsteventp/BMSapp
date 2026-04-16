/**
 * geocoder.js — Geocode addresses using Google Maps Platform.
 */

import { Client } from '@googlemaps/google-maps-services-js';
import fs from 'fs/promises';
import path from 'path';

const googleClient = new Client({});
const API_KEY = process.env.GOOGLE_MAPS_API_KEY;

const CACHE_FILE = path.resolve('data', 'geocache.json');

/**
 * Geocode all locations and compute proximity clusters.
 * Uses Google Maps API for high accuracy.
 */
export default async function geocodeAndCluster(allLocations, maxDistanceMeters = 800) {
  if (!API_KEY || API_KEY === 'YOUR_API_KEY_HERE') {
    console.error('❌  GOOGLE_MAPS_API_KEY is missing or invalid in .env');
    throw new Error('Missing Google Maps API Key');
  }

  let cache = {};
  try {
    const cacheData = await fs.readFile(CACHE_FILE, 'utf8');
    cache = JSON.parse(cacheData);
    console.log(`📂  Loaded ${Object.keys(cache).length} geocoding results from ${path.basename(CACHE_FILE)}`);
  } catch (err) {
    console.log(`❕  No existing geocode cache found at ${path.basename(CACHE_FILE)}.`);
  }

  console.log(`📍  Geocoding ${allLocations.length} locations using Google Maps...`);

  for (let i = 0; i < allLocations.length; i++) {
    const loc = allLocations[i];
    const cacheKey = `${loc.address}|${loc.city}`;

    // Show progress
    process.stdout.write(`   [${i + 1}/${allLocations.length}] ${loc.restaurant} — ${loc.branch}\r`);

    if (cache[cacheKey]) {
      loc.lat = cache[cacheKey].lat;
      loc.lng = cache[cacheKey].lng;
      continue;
    }

    try {
      const coords = await googleGeocode(loc.restaurant, loc.branch, loc.address, loc.city);
      if (coords) {
        loc.lat = coords.lat;
        loc.lng = coords.lng;
        cache[cacheKey] = coords;
      } else {
        console.warn(`\n   ⚠️  Could not geocode: ${loc.restaurant} ${loc.branch}`);
        loc.lat = null;
        loc.lng = null;
      }
    } catch (err) {
      console.error(`\n   ⚠️  Error geocoding ${loc.restaurant} ${loc.branch}: ${err.message}`);
      loc.lat = null;
      loc.lng = null;
    }

    // Incremental save to prevent data loss
    await fs.mkdir(path.dirname(CACHE_FILE), { recursive: true });
    await fs.writeFile(CACHE_FILE, JSON.stringify(cache, null, 2));
  }
  process.stdout.write('\n');

  // Compute proximity clusters (< maxDistanceMeters)
  console.log(`🔗  Computing proximity clusters (< ${maxDistanceMeters}m)…`);
  for (const loc of allLocations) {
    loc.nearbyLocationIds = [];
    if (loc.lat == null || loc.lng == null) continue;

    for (const other of allLocations) {
      if (other.id === loc.id) continue;
      if (other.lat == null || other.lng == null) continue;

      const dist = haversineDistance(loc.lat, loc.lng, other.lat, other.lng);
      if (dist <= maxDistanceMeters) {
        loc.nearbyLocationIds.push(other.id);
      }
    }
  }

  const geocoded = allLocations.filter((l) => l.lat != null);
  const failed = allLocations.filter((l) => l.lat == null);
  console.log(`✅  Geocoded ${geocoded.length} / ${allLocations.length} locations (${failed.length} failed).`);

  return { geocodedLocations: allLocations };
}

/**
 * Advanced Geocoding with Google Maps
 */
async function googleGeocode(restaurant, branch, address, city) {
  // Try POI search first (best for mall branches)
  const poiSearch = `${restaurant} ${branch}, ${city}, Colombia`;
  let result = await callGoogleApi(poiSearch);
  
  if (!result) {
    // Fallback to absolute address
    const addressSearch = `${address}, ${city}, Colombia`;
    result = await callGoogleApi(addressSearch);
  }

  return result;
}

async function callGoogleApi(query) {
  try {
    const response = await googleClient.geocode({
      params: {
        address: query,
        key: API_KEY,
        region: 'co', // Colombia
      },
      timeout: 2000,
    });

    if (response.data.status === 'OK' && response.data.results.length > 0) {
      const location = response.data.results[0].geometry.location;
      return {
        lat: location.lat,
        lng: location.lng
      };
    }
  } catch (err) {
    // If it's a hard error (not just 'no results'), rethrow it
    if (err.response && err.response.data && err.response.data.error_message) {
      throw new Error(err.response.data.error_message);
    }
  }
  return null;
}

/** Calculates the distance between two points in meters */
function haversineDistance(lat1, lon1, lat2, lon2) {
  const R = 6371e3; // Earth's radius in meters
  const f1 = (lat1 * Math.PI) / 180;
  const f2 = (lat2 * Math.PI) / 180;
  const df = ((lat2 - lat1) * Math.PI) / 180;
  const dl = ((lon2 - lon1) * Math.PI) / 180;

  const a = Math.sin(df / 2) * Math.sin(df / 2) + Math.cos(f1) * Math.cos(f2) * Math.sin(dl / 2) * Math.sin(dl / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c;
}
