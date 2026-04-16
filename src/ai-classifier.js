/**
 * ai-classifier.js — Uses Gemini to extract structured ingredients from
 * each burger's description text.
 *
 * Features:
 *  - Batches 5 burgers per request to stay under rate limits
 *  - Retries with exponential backoff on 429 errors
 *  - Caches results to resume after partial runs
 */

import { GoogleGenAI } from '@google/genai';
import fs from 'fs';
import path from 'path';

const BATCH_SIZE = 20;           // Burgers per API call (large batches = fewer calls)
const BASE_DELAY_MS = 5000;      // Delay between requests
const MAX_RETRIES = 8;           // Max retries per batch on 429
const CACHE_FILE = path.join('data', 'classified-cache.json');

/**
 * Classify all burgers' ingredients using Gemini.
 * @param {Array} burgers — array of { id, description, ... }
 * @param {string} apiKey — Gemini API key
 * @returns {Object} — { classifiedBurgers, globalIngredients }
 */
export async function classifyIngredients(burgers, apiKey) {
  const ai = new GoogleGenAI({ apiKey });
  const modelName = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  console.log(`🧠  Using model: ${modelName}`);

  // Load cache from previous partial runs
  const cache = loadCache();
  const cachedCount = Object.keys(cache).length;
  if (cachedCount > 0) {
    console.log(`📦  Loaded ${cachedCount} cached classifications.`);
  }

  // Global ingredient dedup map: normalized name → { id, name, category }
  const ingredientMap = new Map();
  const classifiedBurgers = [];

  // First, restore cached ingredients into the map
  for (const burger of burgers) {
    if (cache[burger.id]) {
      const cachedIngredients = cache[burger.id];
      const burgerIngredientIds = [];
      for (const ing of cachedIngredients) {
        const key = normalizeIngredientName(ing.name);
        if (!ingredientMap.has(key)) {
          const { v4: uuidv4 } = await import('uuid');
          ingredientMap.set(key, {
            id: uuidv4(), name: ing.name, category: ing.category, count: 0,
          });
        }
        const globalIng = ingredientMap.get(key);
        globalIng.count++;
        burgerIngredientIds.push(globalIng.id);
      }
      classifiedBurgers.push({
        ...burger, ingredientIds: burgerIngredientIds, rawIngredients: cachedIngredients,
      });
    }
  }

  // Find un-cached burgers
  const uncached = burgers.filter(b => !cache[b.id]);
  if (uncached.length === 0) {
    console.log(`✅  All ${burgers.length} burgers already classified from cache.`);
    const globalIngredients = Array.from(ingredientMap.values());
    return { classifiedBurgers, globalIngredients };
  }

  console.log(`🤖  Classifying ${uncached.length} burgers in batches of ${BATCH_SIZE}…`);

  // Process in batches
  for (let batchStart = 0; batchStart < uncached.length; batchStart += BATCH_SIZE) {
    const batch = uncached.slice(batchStart, batchStart + BATCH_SIZE);
    const batchNum = Math.floor(batchStart / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(uncached.length / BATCH_SIZE);

    const names = batch.map(b => b.restaurant).join(', ');
    console.log(`   [Batch ${batchNum}/${totalBatches}] ${names}`);

    try {
      const batchResults = await extractIngredientsBatch(ai, modelName, batch);

      for (let i = 0; i < batch.length; i++) {
        const burger = batch[i];
        const ingredients = batchResults[i] || [];

        // Cache this result
        cache[burger.id] = ingredients;

        // Deduplicate ingredients globally
        const burgerIngredientIds = [];
        for (const ing of ingredients) {
          const key = normalizeIngredientName(ing.name);
          if (!ingredientMap.has(key)) {
            const { v4: uuidv4 } = await import('uuid');
            ingredientMap.set(key, {
              id: uuidv4(), name: ing.name, category: ing.category, count: 0,
            });
          }
          const globalIng = ingredientMap.get(key);
          globalIng.count++;
          burgerIngredientIds.push(globalIng.id);
        }

        classifiedBurgers.push({
          ...burger, ingredientIds: burgerIngredientIds, rawIngredients: ingredients,
        });
      }

      // Save cache after each batch
      saveCache(cache);
    } catch (err) {
      console.error(`   ❌  Batch failed after retries: ${err.message}`);
      for (const burger of batch) {
        classifiedBurgers.push({
          ...burger, ingredientIds: [], rawIngredients: [],
        });
      }
    }

    // Rate-limit delay between batches
    if (batchStart + BATCH_SIZE < uncached.length) {
      await sleep(BASE_DELAY_MS);
    }
  }

  const globalIngredients = Array.from(ingredientMap.values());
  console.log(
    `✅  Extracted ${globalIngredients.length} unique ingredients across ${classifiedBurgers.length} burgers.`,
  );

  return { classifiedBurgers, globalIngredients };
}

/**
 * Call Gemini to extract ingredients from a BATCH of burgers.
 * Includes retry logic with exponential backoff for 429 errors.
 */
async function extractIngredientsBatch(ai, modelName, batch, retryCount = 0) {
  const burgersBlock = batch.map((b, idx) =>
    `[${idx}] ${b.restaurant} — ${b.burgerName}:\n${b.description}`,
  ).join('\n\n---\n\n');

  const prompt = `You are a food ingredient parser. Given ${batch.length} Spanish-language burger descriptions from a Colombian burger festival, extract ALL individual ingredients used in EACH burger.

Return ONLY a valid JSON object (no markdown, no explanation). The keys are the indices "0", "1", etc. Each value is an array of ingredient objects:
{
  "0": [{"name": "...", "category": "..."}],
  "1": [{"name": "...", "category": "..."}],
  ...
}

Each ingredient:
{
  "name": "ingredient name in Spanish (lowercase, singular)",
  "category": "one of: pan | proteina | queso | salsa | topping | condimento | vegetal | otro"
}

Categories:
- pan: bread/bun types (brioche, pretzel, artisan, etc.)
- proteina: meat, bacon/tocineta, brisket, pulled pork, chorizo, etc.
- queso: cheese (cheddar, mozzarella, gouda, brie, cream cheese, etc.)
- salsa: sauces, mayo, aioli, reductions, jams/mermeladas, chutneys, bbq, demiglace, etc.
- topping: crispy/crunchy items (onion rings, chips, crispy onions, etc.)
- condimento: spices, honey, mustard, vinegar, etc.
- vegetal: lettuce, tomato, onion, pickles, arugula, etc.
- otro: anything that doesn't fit above

Be thorough — include bun type, every sauce, every cheese, every topping.

Burger descriptions:
"""
${burgersBlock}
"""`;

  try {
    const response = await ai.models.generateContent({
      model: modelName,
      contents: prompt,
    });
    const text = (response.text || '').trim();

    // Strip markdown code fences if present
    const jsonText = text
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();

    const parsed = JSON.parse(jsonText);
    if (typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Response is not an object');
    }

    // Extract results for each burger in the batch
    const results = [];
    for (let i = 0; i < batch.length; i++) {
      const items = parsed[String(i)] || parsed[i] || [];
      results.push(
        Array.isArray(items)
          ? items.map(item => ({
              name: String(item.name || '').toLowerCase().trim(),
              category: validateCategory(item.category),
            }))
          : [],
      );
    }
    return results;
  } catch (err) {
    // Retry on 429 (rate limit)
    if (err.message?.includes('429') && retryCount < MAX_RETRIES) {
      // Try to parse retryDelay from error message (e.g., "retry in 12.5s" or "retryDelay\":\"12s\"")
      let backoffMs;
      const delayMatch = err.message.match(/retry[^\d]*(\d+\.?\d*)\s*s/i);
      if (delayMatch) {
        backoffMs = Math.ceil(parseFloat(delayMatch[1]) * 1000) + 2000; // Add 2s buffer
      } else {
        backoffMs = Math.min(BASE_DELAY_MS * Math.pow(2, retryCount), 300000); // Max 5 min
      }
      console.log(`   ⏳  Rate limited. Retrying in ${Math.round(backoffMs / 1000)}s (attempt ${retryCount + 1}/${MAX_RETRIES})…`);
      await sleep(backoffMs);
      return extractIngredientsBatch(ai, modelName, batch, retryCount + 1);
    }
    throw err;
  }
}

/**
 * Normalize an ingredient name for deduplication.
 */
function normalizeIngredientName(name) {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // strip accents
    .replace(/\s+/g, ' ')
    .trim();
}

const VALID_CATEGORIES = [
  'pan', 'proteina', 'queso', 'salsa', 'topping', 'condimento', 'vegetal', 'otro',
];

function validateCategory(cat) {
  const c = String(cat || 'otro').toLowerCase().trim();
  return VALID_CATEGORIES.includes(c) ? c : 'otro';
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
    }
  } catch { /* ignore */ }
  return {};
}

function saveCache(cache) {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
  } catch (err) {
    // In serverless environments like Vercel, the filesystem is read-only except for /tmp.
    // If the standard data/ path fails, we try /tmp as a best-effort cache for the current run.
    try {
      const tmpCache = path.join('/tmp', 'classified-cache.json');
      fs.writeFileSync(tmpCache, JSON.stringify(cache, null, 2));
    } catch {
      // If /tmp also fails, we just don't cache. The run continues in-memory.
    }
  }
}

export default classifyIngredients;
