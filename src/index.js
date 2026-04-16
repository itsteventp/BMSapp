/**
 * index.js — Orchestrator for the Burger Master Scraper pipeline.
 *
 * Usage:
 *   node src/index.js                  # full pipeline
 *   node src/index.js --skip-geocode   # skip geocoding
 *   node src/index.js --skip-upload    # skip Supabase upload
 *   node src/index.js --only-scrape    # only scrape
 *   node src/index.js --only-classify  # only classify (needs scraped data)
 *   node src/index.js --only-geocode   # only geocode (needs classified data)
 *   node src/index.js --only-upload    # only upload to Supabase (needs final data)
 *   node src/index.js --url <URL>      # scrape a different city/year page
 *   node src/index.js --clear-cache    # wipe cached data before running
 */

import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';

import scrapeBurgers from './scraper.js';
import classifyIngredients from './ai-classifier.js';
import geocodeAndCluster from './geocoder.js';
import uploadToSupabase from './supabase-uploader.js';

const DATA_DIR = path.resolve('data');
const FILES = {
  raw: path.join(DATA_DIR, 'raw-burgers.json'),
  classified: path.join(DATA_DIR, 'classified-burgers.json'),
  final: path.join(DATA_DIR, 'final-data.json'),
};

async function ensureDataDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

async function loadJSON(filepath) {
  const raw = await fs.readFile(filepath, 'utf-8');
  return JSON.parse(raw);
}

async function saveJSON(filepath, data) {
  await ensureDataDir();
  await fs.writeFile(filepath, JSON.stringify(data, null, 2));
  console.log(`💾  Saved ${filepath}`);
}

// ─── Parse CLI flags ───
const args = process.argv.slice(2);
const flags = {
  skipGeocode: args.includes('--skip-geocode'),
  skipUpload: args.includes('--skip-upload'),
  onlyScrape: args.includes('--only-scrape'),
  onlyClassify: args.includes('--only-classify'),
  onlyGeocode: args.includes('--only-geocode'),
  onlyUpload: args.includes('--only-upload'),
  clearCache: args.includes('--clear-cache'),
  url: args.find(a => a.startsWith('--url='))?.split('=')[1]
    || (args.includes('--url') ? args[args.indexOf('--url') + 1] : null),
};

async function main() {
  console.log('');
  console.log('═══════════════════════════════════════════════');
  console.log('   🍔  Burger Master Scraper Pipeline  🍔');
  console.log('═══════════════════════════════════════════════');
  console.log('');

  // ── Clear cache if requested ──
  if (flags.clearCache) {
    const { rm } = await import('fs/promises');
    for (const f of Object.values(FILES)) {
      try { await rm(f); } catch { /* ignore */ }
    }
    try { await rm(path.join(DATA_DIR, 'classified-cache.json')); } catch { /* ignore */ }
    console.log('🗑️  Cleared all cached data.\n');
  }

  // ── Phase 1: Scrape ──
  let rawBurgers;
  if (flags.onlyClassify || flags.onlyGeocode || flags.onlyUpload) {
    // Load from cache
    try {
      rawBurgers = await loadJSON(FILES.raw);
      console.log(`📂  Loaded ${rawBurgers.length} burgers from cache.`);
    } catch {
      console.error('❌  No cached raw data. Run without --only-* first.');
      process.exit(1);
    }
  } else {
    rawBurgers = await scrapeBurgers(flags.url);
    await saveJSON(FILES.raw, rawBurgers);
    console.log(`🍔  Scraped ${rawBurgers.length} burgers.\n`);

    if (flags.onlyScrape) {
      console.log('Done (--only-scrape).');
      return;
    }
  }

  // ── Phase 2: AI Classification ──
  let classifiedData;
  if (flags.onlyGeocode || flags.onlyUpload) {
    try {
      classifiedData = await loadJSON(FILES.classified);
      console.log(`📂  Loaded classified data from cache.`);
    } catch {
      console.error('❌  No cached classified data. Run classify first.');
      process.exit(1);
    }
  } else {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      console.error('❌  GEMINI_API_KEY not set in .env');
      process.exit(1);
    }
    classifiedData = await classifyIngredients(rawBurgers, apiKey);
    await saveJSON(FILES.classified, classifiedData);
    console.log('');

    if (flags.onlyClassify) {
      console.log('Done (--only-classify).');
      return;
    }
  }

  // ── Phase 3: Geocode ──
  let finalData;
  if (flags.skipGeocode) {
    console.log('⏭️   Skipping geocoding (--skip-geocode).\n');
    // Build locations without coords
    const allLocs = [];
    for (const b of classifiedData.classifiedBurgers) {
      for (const loc of b.locations) {
        allLocs.push({
          ...loc,
          restaurant: b.restaurant,
          city: b.city,
          lat: null,
          lng: null,
          nearbyLocationIds: [],
        });
      }
    }
    finalData = {
      ...classifiedData,
      geocodedLocations: allLocs,
    };
  } else if (flags.onlyUpload) {
    try {
      finalData = await loadJSON(FILES.final);
      console.log(`📂  Loaded final data from cache.`);
    } catch {
      console.error('❌  No cached final data. Run geocode first.');
      process.exit(1);
    }
  } else {
    const allLocsToGeocode = [];
    for (const burger of classifiedData.classifiedBurgers) {
      if (burger.locations) {
        for (const loc of burger.locations) {
          allLocsToGeocode.push({
            ...loc,
            restaurant: burger.restaurant,
            burgerId: burger.id
          });
        }
      }
    }

    const threshold = parseInt(process.env.WALKING_DISTANCE_METERS || '800', 10);
    const { geocodedLocations } = await geocodeAndCluster(
      allLocsToGeocode,
      threshold,
    );
    finalData = {
      ...classifiedData,
      geocodedLocations,
    };
    console.log('');

    if (flags.onlyGeocode) {
      await saveJSON(FILES.final, finalData);
      console.log('Done (--only-geocode).');
      return;
    }
  }

  await saveJSON(FILES.final, finalData);

  // ── Phase 4: Upload to Supabase ──
  if (flags.skipUpload) {
    console.log('⏭️   Skipping Supabase upload (--skip-upload).\n');
  } else {
    console.log('☁️   Uploading to Supabase…');
    await uploadToSupabase(finalData);
  }

  // ── Phase 5: Save Frontend Config ──
  const frontendConfig = {
    GOOGLE_MAPS_API_KEY: process.env.GOOGLE_MAPS_API_KEY,
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY,
  };
  await fs.writeFile(path.join('web', 'config.json'), JSON.stringify(frontendConfig, null, 2));
  console.log(`⚙️   Frontend config saved to web/config.json`);

  // ── Summary ──
  console.log('');
  console.log('═══════════════════════════════════════════════');
  console.log('   ✅  Pipeline Complete!');
  console.log('═══════════════════════════════════════════════');
  console.log(`   🍔  Burgers: ${finalData.classifiedBurgers.length}`);
  console.log(`   🧂  Unique Ingredients: ${finalData.globalIngredients.length}`);
  console.log(`   📍  Locations: ${finalData.geocodedLocations.length}`);
  console.log(`   📁  Data saved to: ${DATA_DIR}`);
  console.log('');
}

main().catch((err) => {
  console.error('💥  Fatal error:', err);
  process.exit(1);
});
