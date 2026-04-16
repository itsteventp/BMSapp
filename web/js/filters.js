/**
 * filters.js — Filter page logic.
 */
import {
  loadData, renderNav, getIngredientsByCategory, getCities,
  getExcludedIngredients, getExcludedCities, toggleIngredient, toggleCity,
  clearFilters, applyFilters, CATEGORY_LABELS, CATEGORY_ORDER,
} from './data.js';

let data;

async function init() {
  document.getElementById('nav').innerHTML = renderNav('filter');
  data = await loadData();

  renderIngredients();
  renderCities();
  updateCount();

  document.getElementById('clear-btn').addEventListener('click', () => {
    clearFilters();
    renderIngredients();
    renderCities();
    updateCount();
  });
}

function renderIngredients() {
  const grouped = getIngredientsByCategory(data);
  const excluded = new Set(getExcludedIngredients());
  const container = document.getElementById('ingredients-container');
  container.innerHTML = '';

  let totalIng = 0;
  for (const cat of CATEGORY_ORDER) {
    const ings = grouped[cat];
    if (!ings) continue;
    totalIng += ings.length;

    const section = document.createElement('div');
    section.className = 'filter-category';

    const label = document.createElement('div');
    label.className = 'filter-category-label';
    label.textContent = `${CATEGORY_LABELS[cat]} (${ings.length})`;
    section.appendChild(label);

    const chips = document.createElement('div');
    chips.className = 'filter-chips';

    for (const ing of ings) {
      const chip = document.createElement('span');
      chip.className = `chip chip-${cat} ${excluded.has(ing.name) ? 'chip--excluded' : 'chip--active'}`;
      chip.textContent = ing.name;
      chip.title = `Usado en ${ing.count} burger${ing.count > 1 ? 's' : ''}`;
      chip.addEventListener('click', () => {
        toggleIngredient(ing.name);
        chip.classList.toggle('chip--excluded');
        chip.classList.toggle('chip--active');
        updateCount();
      });
      chips.appendChild(chip);
    }

    section.appendChild(chips);
    container.appendChild(section);
  }

  document.getElementById('ing-count').textContent = `${totalIng} ingredientes`;
}

function renderCities() {
  const cities = getCities(data);
  const excluded = new Set(getExcludedCities());
  const container = document.getElementById('cities-container');
  container.innerHTML = '';

  for (const { city, count } of cities) {
    const item = document.createElement('label');
    item.className = `city-item ${excluded.has(city) ? 'city-item--excluded' : ''}`;

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = excluded.has(city);
    cb.addEventListener('change', () => {
      toggleCity(city);
      item.classList.toggle('city-item--excluded');
      updateCount();
    });

    const lbl = document.createElement('label');
    lbl.textContent = city;

    const cnt = document.createElement('span');
    cnt.className = 'city-count';
    cnt.textContent = `${count}`;

    item.appendChild(cb);
    item.appendChild(lbl);
    item.appendChild(cnt);
    container.appendChild(item);
  }
}

function updateCount() {
  const { burgers } = applyFilters(data);
  document.getElementById('remaining').textContent = burgers.length;
  document.getElementById('total').textContent = data.classifiedBurgers.length;
}

init();
