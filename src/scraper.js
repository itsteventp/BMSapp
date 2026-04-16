/**
 * scraper.js — Fetches and parses the Burger Master page into structured data.
 *
 * Page DOM structure (discovered via inspection):
 *   div.elementor-element (container level)
 *     div.elementor-element (inner column)
 *       div.elementor-widget-heading → h2.elementor-heading-title → restaurant name
 *       div.elementor-widget-divider (visual separator)
 *       div.elementor-widget-toggle → elementor-toggle
 *         div.elementor-toggle-item → "Descripción" + content
 *         div.elementor-toggle-item → "Sede: X" + address/phone
 *
 * The heading and its toggle are siblings under the same grandparent container.
 * We walk up 2 levels from the heading to find the matching toggle.
 *
 * v2: Enhanced to catch edge cases (missing headings, deeper nesting)
 *     and deduplicate restaurants that appear under multiple city sections.
 */

import axios from 'axios';
import * as cheerio from 'cheerio';
import { v4 as uuidv4 } from 'uuid';

const DEFAULT_URL =
  'https://tuliorecomienda.com/participantes-burger-master-bogota-y-cundinamarca/';

/**
 * Scrape the page and return an array of raw burger objects.
 */
export async function scrapeBurgers(url) {
  const targetUrl = url || process.env.TARGET_URL || DEFAULT_URL;
  console.log(`🌐  Fetching ${targetUrl}…`);
  const { data: html } = await axios.get(targetUrl, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    },
  });

  const $ = cheerio.load(html);
  const burgers = [];

  // City detection
  let currentCity = 'Bogotá';
  const cityAnchors = {
    bogota: 'Bogotá', cajica: 'Cajicá', chia: 'Chía',
    zipaquira: 'Zipaquirá', mosquera: 'Mosquera', choachi: 'Choachí',
    tenjo: 'Tenjo', villeta: 'Villeta', madrid: 'Madrid', cota: 'Cota',
    ubate: 'Ubaté', fusagasuga: 'Fusagasugá', funza: 'Funza',
    ubaque: 'Ubaque', tabio: 'Tabio',
  };

  // Deduplication map: "restaurant|burgerName" → index in burgers[]
  const dedupeMap = new Map();

  // Iterate every h2.elementor-heading-title
  $('h2.elementor-heading-title').each((_, headingEl) => {
    const $heading = $(headingEl);
    const rawName = $heading.text().trim();

    // Skip nav/section headings
    if (isNavHeading(rawName)) return;
    if (rawName.length < 2) return;

    // Check if this is a city section heading (e.g., "Bogotá", "Cajicá")
    const normalizedLC = rawName
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');
    if (cityAnchors[normalizedLC]) {
      currentCity = cityAnchors[normalizedLC];
      return;
    }

    // Detect city from parenthetical: "Restaurant (City)"
    let detectedCity = currentCity;
    let cleanName = rawName;
    const cityMatch = rawName.match(/\(([^)]+)\)$/);
    if (cityMatch) {
      const parenText = cityMatch[1];
      const cities = parenText.split(/\s+y\s+/i);
      const firstCityLC = cities[0]
        .trim()
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '');
      if (cityAnchors[firstCityLC]) {
        detectedCity = cityAnchors[firstCityLC];
      }
      cleanName = rawName.replace(/\s*\([^)]+\)$/, '').trim();
    }

    // Walk up from the heading to find the smallest container that has
    // both toggle items AND only 1 heading (meaning it's scoped to this restaurant).
    let $container = $heading;
    let togglesFound = 0;
    let foundGoodContainer = false;

    for (let level = 0; level < 8; level++) {
      $container = $container.parent();
      if (!$container.length) break;
      togglesFound = $container.find('.elementor-toggle-item').length;
      const headingsInContainer = $container.find('h2.elementor-heading-title').length;

      // If this container has toggles AND only 1 heading, it's our match
      if (togglesFound > 0 && headingsInContainer === 1) {
        foundGoodContainer = true;
        break;
      }
      // If we see multiple headings, we've gone too far — stop
      if (headingsInContainer > 1) break;
    }

    // Fallback: try finding the toggle widget as a direct sibling of the heading widget
    if (!foundGoodContainer) {
      const $headingWidget = $heading.closest('.elementor-widget');
      // Walk next siblings to find the toggle widget
      let $sibling = $headingWidget.next();
      while ($sibling.length) {
        const sibToggleCount = $sibling.find('.elementor-toggle-item').length;
        if (sibToggleCount > 0) {
          $container = $sibling;
          togglesFound = sibToggleCount;
          foundGoodContainer = true;
          break;
        }
        // If we hit another heading widget, stop
        if ($sibling.find('h2.elementor-heading-title').length > 0) break;
        $sibling = $sibling.next();
      }
    }

    // Fallback 2: try walking previous siblings (for cases where toggle comes before heading)
    if (!foundGoodContainer) {
      const $headingWidget = $heading.closest('.elementor-widget');
      let $sibling = $headingWidget.prev();
      while ($sibling.length) {
        const sibToggleCount = $sibling.find('.elementor-toggle-item').length;
        if (sibToggleCount > 0) {
          $container = $sibling;
          togglesFound = sibToggleCount;
          foundGoodContainer = true;
          break;
        }
        if ($sibling.find('h2.elementor-heading-title').length > 0) break;
        $sibling = $sibling.prev();
      }
    }

    // Fallback 3: walk up to find a broader container that has toggles
    // (for deeply nested Elementor layouts)
    if (!foundGoodContainer) {
      let $walk = $heading.closest('.elementor-widget');
      for (let level = 0; level < 10; level++) {
        $walk = $walk.parent();
        if (!$walk.length) break;
        const toggleCount = $walk.find('.elementor-toggle-item').length;
        if (toggleCount > 0) {
          // Check it's still scoped — at most 2 headings (city heading + restaurant)
          const headCount = $walk.find('h2.elementor-heading-title').filter((_, el) => {
            const txt = $(el).text().trim();
            return !isNavHeading(txt) && txt.length >= 2;
          }).length;
          if (headCount <= 2) {
            $container = $walk;
            togglesFound = toggleCount;
            foundGoodContainer = true;
            break;
          }
        }
      }
    }

    if (!foundGoodContainer || togglesFound === 0) return; // Not a burger entry or no data

    // Parse toggle items
    let description = '';
    let burgerName = '';
    const locations = [];

    $container.find('.elementor-toggle-item').each((_, toggleEl) => {
      const $toggle = $(toggleEl);
      const titleText = $toggle.find('.elementor-toggle-title').first().text().trim();
      const $content = $toggle.find('.elementor-tab-content').first();
      const contentText = $content.text().trim();

      if (/^Descripci[oó]n$/i.test(titleText)) {
        description = contentText;
        // Extract burger name: "BurgerName: long description..."
        const colonIdx = contentText.indexOf(':');
        if (colonIdx > 0 && colonIdx < 60) {
          burgerName = contentText.slice(0, colonIdx).trim();
        } else {
          burgerName = contentText.slice(0, 50).trim();
        }
      } else if (/^Sede/i.test(titleText)) {
        const branchName = titleText
          .replace(/^Sede:\s*/i, '')
          .replace(/^Sede\s+/i, '')
          .trim();

        // Parse address and phone from content
        const phoneLink = $content.find('a[href^="tel:"]').first().text().trim();
        // The address is the text content minus the phone
        let address = contentText;
        if (phoneLink) {
          address = address.replace(phoneLink, '').trim();
        }
        // Clean trailing/leading newlines
        address = address.split('\n')[0]?.trim() || address.trim();

        locations.push({
          id: uuidv4(),
          branch: branchName,
          address,
          phone: phoneLink,
        });
      }
    });

    if (description && description.length > 20) {
      // Check for duplicate (same restaurant + burgerName)
      const dedupeKey = `${cleanName.toLowerCase()}|${burgerName.toLowerCase()}`;
      if (dedupeMap.has(dedupeKey)) {
        // Merge locations into the existing entry
        const existingIdx = dedupeMap.get(dedupeKey);
        const existing = burgers[existingIdx];
        // Add new locations that aren't already present (by address)
        const existingAddresses = new Set(existing.locations.map(l => l.address));
        for (const loc of locations) {
          if (!existingAddresses.has(loc.address)) {
            existing.locations.push(loc);
          }
        }
        return;
      }

      const idx = burgers.length;
      dedupeMap.set(dedupeKey, idx);

      burgers.push({
        id: uuidv4(),
        restaurant: cleanName,
        burgerName,
        description,
        city: detectedCity,
        locations,
      });
    }
  });

  // ── Fallback pass: find orphan toggle containers without headings ──
  // Some entries (like "Burger House" / "Zipa Burger") may have toggles
  // that aren't paired with an h2 heading.
  $('div.elementor-widget-toggle').each((_, toggleWidget) => {
    const $tw = $(toggleWidget);
    // Skip if already consumed by a burger (check if any toggle-item content matches)
    const $descToggle = $tw.find('.elementor-toggle-item').filter((_, t) => {
      return /^Descripci[oó]n$/i.test($(t).find('.elementor-toggle-title').first().text().trim());
    }).first();

    if (!$descToggle.length) return;

    const descContent = $descToggle.find('.elementor-tab-content').first().text().trim();
    if (!descContent || descContent.length < 20) return;

    // Check if this description is already captured
    const alreadyCaptured = burgers.some(b => b.description === descContent);
    if (alreadyCaptured) return;

    // Extract burger name
    let burgerName = '';
    const colonIdx = descContent.indexOf(':');
    if (colonIdx > 0 && colonIdx < 60) {
      burgerName = descContent.slice(0, colonIdx).trim();
    } else {
      burgerName = descContent.slice(0, 50).trim();
    }

    // Check if a burger with the same name already exists (likely a duplicate city listing)
    const existingByName = burgers.find(b =>
      b.burgerName.toLowerCase() === burgerName.toLowerCase()
    );
    if (existingByName) {
      // Merge locations instead of creating a new entry
      const existingAddresses = new Set(existingByName.locations.map(l => l.address));
      const $tw2 = $(toggleWidget);
      $tw2.find('.elementor-toggle-item').each((_, toggleEl) => {
        const $toggle = $(toggleEl);
        const titleText = $toggle.find('.elementor-toggle-title').first().text().trim();
        const $content = $toggle.find('.elementor-tab-content').first();
        const contentText = $content.text().trim();
        if (/^Sede/i.test(titleText)) {
          const branchName = titleText.replace(/^Sede:\s*/i, '').replace(/^Sede\s+/i, '').trim();
          const phoneLink = $content.find('a[href^="tel:"]').first().text().trim();
          let address = contentText;
          if (phoneLink) address = address.replace(phoneLink, '').trim();
          address = address.split('\n')[0]?.trim() || address.trim();
          if (!existingAddresses.has(address)) {
            existingByName.locations.push({ id: uuidv4(), branch: branchName, address, phone: phoneLink });
          }
        }
      });
      return;
    }

    // Try to find a restaurant name from a nearby heading
    let restaurantName = 'Desconocido';
    const $prevWidget = $tw.prev();
    if ($prevWidget.length) {
      const h = $prevWidget.find('h2.elementor-heading-title').first().text().trim();
      if (h && h.length >= 2 && !isNavHeading(h)) {
        restaurantName = h.replace(/\s*\([^)]+\)$/, '').trim();
      }
    }

    // Parse locations from this toggle widget
    const locations = [];
    $tw.find('.elementor-toggle-item').each((_, toggleEl) => {
      const $toggle = $(toggleEl);
      const titleText = $toggle.find('.elementor-toggle-title').first().text().trim();
      const $content = $toggle.find('.elementor-tab-content').first();
      const contentText = $content.text().trim();

      if (/^Sede/i.test(titleText)) {
        const branchName = titleText
          .replace(/^Sede:\s*/i, '')
          .replace(/^Sede\s+/i, '')
          .trim();
        const phoneLink = $content.find('a[href^="tel:"]').first().text().trim();
        let address = contentText;
        if (phoneLink) address = address.replace(phoneLink, '').trim();
        address = address.split('\n')[0]?.trim() || address.trim();

        locations.push({ id: uuidv4(), branch: branchName, address, phone: phoneLink });
      }
    });

    // Deduplicate check
    const dedupeKey = `${restaurantName.toLowerCase()}|${burgerName.toLowerCase()}`;
    if (dedupeMap.has(dedupeKey)) {
      const existingIdx = dedupeMap.get(dedupeKey);
      const existing = burgers[existingIdx];
      const existingAddresses = new Set(existing.locations.map(l => l.address));
      for (const loc of locations) {
        if (!existingAddresses.has(loc.address)) {
          existing.locations.push(loc);
        }
      }
      return;
    }

    const idx = burgers.length;
    dedupeMap.set(dedupeKey, idx);

    burgers.push({
      id: uuidv4(),
      restaurant: restaurantName,
      burgerName,
      description: descContent,
      city: currentCity,
      locations,
    });
  });

  console.log(`📋  Parsed ${burgers.length} burger entries (deduplicated).`);
  return burgers;
}

/**
 * Check if a heading is navigational rather than a burger entry.
 */
function isNavHeading(text) {
  const navTexts = [
    'Participantes Burger Master',
    'Acceso rápido',
    'Navegación',
    'Mis redes',
    'Descarga la APP',
    'Contacto e invitaciones',
    'Búsqueda',
    'Descubre más',
    'Deja un comentario',
    'Cancelar respuesta',
  ];
  return navTexts.some((nav) => text.includes(nav));
}

export default scrapeBurgers;
