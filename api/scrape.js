import scrapeBurgers from '../src/scraper.js';
import classifyIngredients from '../src/ai-classifier.js';
import geocodeAndCluster from '../src/geocoder.js';
import uploadToSupabase from '../src/supabase-uploader.js';

/**
 * api/scrape.js — Vercel Cron Job entry point.
 * Triggered by Vercel Cron (configured in vercel.json).
 * 
 * IMPORTANT: Vercel Free plan has a 60s timeout. 
 * Full pipeline may exceed this.
 */
export default async function handler(req, res) {
  // CRON_SECRET protection
  const authHeader = req.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response('Unauthorized', { status: 401 });
  }

  console.log('🚀 Starting Daily Scrape Job…');
  
  try {
    const GEMINI_KEY = process.env.GEMINI_API_KEY;
    const DISTANCE = parseInt(process.env.WALKING_DISTANCE_METERS || '800', 10);

    if (!GEMINI_KEY) throw new Error('GEMINI_API_KEY missing');

    // 1. Scrape
    const rawBurgers = await scrapeBurgers();
    
    // 2. Classify
    const { classifiedBurgers, globalIngredients } = await classifyIngredients(rawBurgers, GEMINI_KEY);
    
    // 3. Geocode
    const { geocodedLocations } = await geocodeAndCluster(classifiedBurgers, DISTANCE);
    
    const finalData = { classifiedBurgers, globalIngredients, geocodedLocations };

    // 4. Upload
    await uploadToSupabase(finalData);

    console.log('✅ Daily Scrape Complete!');
    return new Response(JSON.stringify({ 
      success: true, 
      burgers: classifiedBurgers.length,
      ingredients: globalIngredients.length,
      locations: geocodedLocations.length
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (err) {
    console.error('❌ Daily Scrape Failed:', err.message);
    return new Response(JSON.stringify({ success: false, error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

// Vercel Edge Runtime (optional, but good for speed. However, geocoder might need node)
// For now, using standard Node.js runtime for stability with axios/cheerio.
export const config = {
  maxDuration: 60, // Max 60s on Hobby, 300s on Pro
};
