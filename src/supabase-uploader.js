/**
 * supabase-uploader.js — Uploads pipeline data to Supabase.
 *
 * Strategy: full truncate-and-replace (idempotent).
 * Uses service_role key for write access.
 */

import { createClient } from '@supabase/supabase-js';

const BATCH_SIZE = 500; // Supabase insert batch limit

/**
 * Upload all pipeline data to Supabase, replacing existing data.
 * @param {Object} finalData — { classifiedBurgers, globalIngredients, geocodedLocations }
 */
export async function uploadToSupabase(finalData) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    console.error('❌  SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set in .env');
    process.exit(1);
  }

  const supabase = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { classifiedBurgers, globalIngredients, geocodedLocations } = finalData;

  console.log('🗑️   Clearing existing data…');

  // Delete in FK-safe order
  await deleteAll(supabase, 'burger_ingredients');
  await deleteAll(supabase, 'locations');
  await deleteAll(supabase, 'ingredients');
  await deleteAll(supabase, 'burgers');

  console.log('✅  Cleared all tables.\n');

  // ── Insert Burgers ──
  console.log(`🍔  Inserting ${classifiedBurgers.length} burgers…`);
  const burgerRows = classifiedBurgers.map(b => ({
    id: b.id,
    restaurant: b.restaurant,
    burger_name: b.burgerName,
    description: b.description,
    city: b.city,
  }));
  await batchInsert(supabase, 'burgers', burgerRows);

  // ── Insert Ingredients ──
  console.log(`🧂  Inserting ${globalIngredients.length} ingredients…`);
  const ingredientRows = globalIngredients.map(ing => ({
    id: ing.id,
    name: ing.name,
    category: ing.category,
    usage_count: ing.count,
  }));
  await batchInsert(supabase, 'ingredients', ingredientRows);

  // ── Insert Burger↔Ingredient join rows ──
  const joinRows = [];
  for (const b of classifiedBurgers) {
    // Deduplicate ingredient IDs per burger
    const seen = new Set();
    for (const ingId of (b.ingredientIds || [])) {
      if (!seen.has(ingId)) {
        seen.add(ingId);
        joinRows.push({ burger_id: b.id, ingredient_id: ingId });
      }
    }
  }
  console.log(`🔗  Inserting ${joinRows.length} burger↔ingredient links…`);
  await batchInsert(supabase, 'burger_ingredients', joinRows);

  // ── Insert Locations ──
  console.log(`📍  Inserting ${geocodedLocations.length} locations…`);
  const locationRows = geocodedLocations.map(loc => ({
    id: loc.id,
    burger_id: loc.burgerId,
    restaurant: loc.restaurant,
    branch: loc.branch || null,
    address: loc.address || null,
    city: loc.city || null,
    phone: loc.phone || null,
    lat: loc.lat || null,
    lng: loc.lng || null,
    nearby_ids: loc.nearbyLocationIds || [],
  }));
  await batchInsert(supabase, 'locations', locationRows);

  console.log('\n✅  All data uploaded to Supabase!');
  console.log(`   🍔 ${burgerRows.length} burgers`);
  console.log(`   🧂 ${ingredientRows.length} ingredients`);
  console.log(`   🔗 ${joinRows.length} links`);
  console.log(`   📍 ${locationRows.length} locations`);
}

/**
 * Delete all rows from a table.
 */
async function deleteAll(supabase, table) {
  // Supabase requires a filter for delete — use neq on a non-existent value
  const { error } = await supabase.from(table).delete().neq('id', '00000000-0000-0000-0000-000000000000');
  if (error) {
    // For tables with composite PKs (burger_ingredients), use a different approach
    const { error: err2 } = await supabase.from(table).delete().gte('burger_id', '00000000-0000-0000-0000-000000000000');
    if (err2) {
      console.error(`   ⚠️  Could not clear ${table}: ${err2.message}`);
    }
  }
}

/**
 * Insert rows in batches.
 */
async function batchInsert(supabase, table, rows) {
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const { error } = await supabase.from(table).insert(batch);
    if (error) {
      console.error(`   ❌  Error inserting into ${table} (batch ${Math.floor(i / BATCH_SIZE) + 1}): ${error.message}`);
      // Log first row for debugging
      if (batch.length > 0) {
        console.error(`   First row:`, JSON.stringify(batch[0]).slice(0, 200));
      }
      throw error;
    }
  }
}

export default uploadToSupabase;
