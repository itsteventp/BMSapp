/**
 * burgers.js — Burger browser page logic.
 */
import { loadData, renderNav, applyFilters } from './data.js';

let data, filteredBurgers;

async function init() {
  document.getElementById('nav').innerHTML = renderNav('burgers');
  data = await loadData();

  const { burgers } = applyFilters(data);
  filteredBurgers = burgers;

  renderGrid(filteredBurgers);
  updateStats(filteredBurgers.length);

  document.getElementById('search').addEventListener('input', (e) => {
    const q = e.target.value.toLowerCase().trim();
    const results = filteredBurgers.filter(b =>
      b.restaurant.toLowerCase().includes(q) ||
      b.burgerName.toLowerCase().includes(q)
    );
    renderGrid(results);
    updateStats(results.length);
  });
}

function updateStats(shown) {
  document.getElementById('stats').textContent =
    `Mostrando ${shown} de ${data.classifiedBurgers.length} burgers` +
    (shown < data.classifiedBurgers.length ? ' (filtros aplicados)' : '');
}

function renderGrid(burgers) {
  const grid = document.getElementById('grid');
  grid.innerHTML = '';

  if (burgers.length === 0) {
    grid.innerHTML = '<p style="color:var(--text-3);grid-column:1/-1;text-align:center;padding:60px 20px;font-size:15px;">No se encontraron burgers. Ajusta los filtros o la búsqueda.</p>';
    return;
  }

  for (const b of burgers) {
    const card = document.createElement('div');
    card.className = 'burger-card';
    card.addEventListener('click', () => card.classList.toggle('expanded'));

    // Ingredient pills
    const pills = (b.rawIngredients || [])
      .map(ing => `<span class="chip chip-${ing.category}" style="cursor:default;font-size:11px">${ing.name}</span>`)
      .join('');

    // Locations
    const locs = (b.locations || [])
      .map(l => `📍 ${l.branch}: ${l.address}`)
      .join('<br>');

    card.innerHTML = `
      <div class="burger-card__restaurant">${esc(b.restaurant)}</div>
      <div class="burger-card__name">${esc(b.burgerName)}</div>
      <div class="burger-card__ingredients">${pills}</div>
      <div class="burger-card__locations">${locs}</div>
      <span class="burger-card__city">${esc(b.city)}</span>
      <div class="burger-card__desc">${esc(b.description)}</div>
    `;

    grid.appendChild(card);
  }
}

function esc(str) {
  const d = document.createElement('div');
  d.textContent = str || '';
  return d.innerHTML;
}

init();
