/**
 * map.js — Interactive map with walking-distance connection chains.
 * Ported to Google Maps JavaScript API for "gold standard" reliability.
 */

import { loadData, renderNav, applyFilters, haversine } from './data.js';

/* ═══ Chain Colors ═══ */
const CHAIN_COLORS = [
  '#f59e0b','#10b981','#3b82f6','#ef4444','#8b5cf6',
  '#ec4899','#14b8a6','#f97316','#06b6d4','#84cc16',
  '#e11d48','#6366f1','#d946ef','#0ea5e9','#facc15',
];

const DARK_MAP_STYLE = [
  { "elementType": "geometry", "stylers": [{ "color": "#212121" }] },
  { "elementType": "labels.icon", "stylers": [{ "visibility": "off" }] },
  { "elementType": "labels.text.fill", "stylers": [{ "color": "#757575" }] },
  { "elementType": "labels.text.stroke", "stylers": [{ "color": "#212121" }] },
  { "featureType": "administrative", "elementType": "geometry", "stylers": [{ "color": "#757575" }] },
  { "featureType": "administrative.country", "elementType": "labels.text.fill", "stylers": [{ "color": "#9e9e9e" }] },
  { "featureType": "administrative.land_parcel", "stylers": [{ "visibility": "off" }] },
  { "featureType": "administrative.locality", "elementType": "labels.text.fill", "stylers": [{ "color": "#bdbdbd" }] },
  { "featureType": "poi", "elementType": "labels.text.fill", "stylers": [{ "color": "#757575" }] },
  { "featureType": "poi.park", "elementType": "geometry", "stylers": [{ "color": "#181818" }] },
  { "featureType": "poi.park", "elementType": "labels.text.fill", "stylers": [{ "color": "#616161" }] },
  { "featureType": "poi.park", "elementType": "labels.text.stroke", "stylers": [{ "color": "#1b1b1b" }] },
  { "featureType": "road", "elementType": "geometry.fill", "stylers": [{ "color": "#2c2c2c" }] },
  { "featureType": "road", "elementType": "labels.text.fill", "stylers": [{ "color": "#8a8a8a" }] },
  { "featureType": "road.arterial", "elementType": "geometry", "stylers": [{ "color": "#373737" }] },
  { "featureType": "road.highway", "elementType": "geometry", "stylers": [{ "color": "#3c3c3c" }] },
  { "featureType": "road.highway.controlled_access", "elementType": "geometry", "stylers": [{ "color": "#4e4e4e" }] },
  { "featureType": "road.local", "elementType": "labels.text.fill", "stylers": [{ "color": "#616161" }] },
  { "featureType": "transit", "elementType": "labels.text.fill", "stylers": [{ "color": "#757575" }] },
  { "featureType": "water", "elementType": "geometry", "stylers": [{ "color": "#000000" }] },
  { "featureType": "water", "elementType": "labels.text.fill", "stylers": [{ "color": "#3d3d3d" }] }
];

let map, data, currentLocations;
let markerElements = [];
let chainPolylines = [];     // { chain, polyline, color }
let selectedChains = [];      // { chain, color }
let usedRestaurants = new Set();
let initialFitDone = false;
let infoWindow;

async function init() {
  document.getElementById('nav').innerHTML = renderNav('map');
  data = await loadData();
  infoWindow = new google.maps.InfoWindow();

  // Create Map centered on Bogotá
  map = new google.maps.Map(document.getElementById('map'), {
    center: { lat: 4.65, lng: -74.08 },
    zoom: 12,
    styles: DARK_MAP_STYLE,
    disableDefaultUI: false,
    zoomControl: true,
  });

  bindControls();
  rebuildGraph();
}

// Attach to window for the Google Maps callback
window.initMap = init;

function bindControls() {
  const distSlider = document.getElementById('distance');
  const connSlider = document.getElementById('max-conn');
  const chainSlider = document.getElementById('max-chain');
  const noRepeat = document.getElementById('no-repeat');

  for (const el of [distSlider, connSlider, chainSlider]) {
    el.addEventListener('input', () => {
      updateLabels();
      rebuildGraph();
    });
  }

  noRepeat.addEventListener('change', rebuildGraph);

  document.getElementById('clear-selection').addEventListener('click', () => {
    selectedChains = [];
    usedRestaurants.clear();
    rebuildGraph();
  });
}

function updateLabels() {
  document.getElementById('dist-val').textContent = document.getElementById('distance').value + 'm';
  document.getElementById('conn-val').textContent = document.getElementById('max-conn').value;
  document.getElementById('chain-val').textContent = document.getElementById('max-chain').value;
}

function rebuildGraph() {
  updateLabels();

  const maxDist = parseInt(document.getElementById('distance').value);
  const maxConn = parseInt(document.getElementById('max-conn').value);
  const maxChain = parseInt(document.getElementById('max-chain').value);
  const noRepeat = document.getElementById('no-repeat').checked;

  const { locations: filtLocs } = applyFilters(data);
  currentLocations = filtLocs.filter(l => l.lat && l.lng);

  clearLayers();
  addMarkers(currentLocations);

  const adj = buildAdjacency(currentLocations, maxDist, maxConn);
  const chains = findChains(currentLocations, adj, maxChain, noRepeat);

  drawChains(chains, noRepeat);

  updateStats(currentLocations.length, chains.length);
  updateLegend();

  if (!initialFitDone && currentLocations.length > 0) {
    const bounds = new google.maps.LatLngBounds();
    for (const loc of currentLocations) {
      bounds.extend({ lat: loc.lat, lng: loc.lng });
    }
    map.fitBounds(bounds);
    initialFitDone = true;
  }
}

function clearLayers() {
  for (const m of markerElements) m.setMap(null);
  markerElements = [];
  for (const cp of chainPolylines) cp.polyline.setMap(null);
  chainPolylines = [];
}

function addMarkers(locs) {
  for (const loc of locs) {
    const isUsed = usedRestaurants.has(loc.restaurant);
    
    // Using a simple Circle as a custom marker
    const circle = new google.maps.Circle({
      strokeColor: isUsed ? '#222' : '#fff',
      strokeOpacity: 0.8,
      strokeWeight: 1.5,
      fillColor: isUsed ? '#333' : '#f59e0b',
      fillOpacity: isUsed ? 0.3 : 0.9,
      map: map,
      center: { lat: loc.lat, lng: loc.lng },
      radius: 50, // Fixed radius in meters for visibility
      clickable: true,
      zIndex: 100
    });

    circle.addListener('click', () => {
      const content = `
        <strong>${loc.restaurant}</strong><br>
        ${loc.branch}<br>
        <span style="color:#888">${loc.address}</span><br>
        ${loc.phone ? `📞 ${loc.phone}` : ''}
      `;
      infoWindow.setContent(content);
      infoWindow.setPosition({ lat: loc.lat, lng: loc.lng });
      infoWindow.open(map);
    });

    markerElements.push(circle);
  }
}

function buildAdjacency(locs, maxDist, maxConn) {
  const n = locs.length;
  const edges = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (locs[i].restaurant === locs[j].restaurant) continue;
      const dist = haversine(locs[i].lat, locs[i].lng, locs[j].lat, locs[j].lng);
      if (dist <= maxDist) {
        edges.push({ i, j, dist });
      }
    }
  }

  edges.sort((a, b) => a.dist - b.dist);

  const adj = Array.from({ length: n }, () => []);
  const degree = new Array(n).fill(0);

  for (const { i, j, dist } of edges) {
    if (degree[i] < maxConn && degree[j] < maxConn) {
      adj[i].push(j);
      adj[j].push(i);
      degree[i]++;
      degree[j]++;
    }
  }

  return adj;
}

function findChains(locs, adj, maxChain, noRepeat) {
  const n = locs.length;
  const visited = new Array(n).fill(false);
  const chains = [];

  if (noRepeat) {
    for (let i = 0; i < n; i++) {
      if (usedRestaurants.has(locs[i].restaurant)) {
        visited[i] = true;
      }
    }
  }

  for (let start = 0; start < n; start++) {
    if (visited[start]) continue;
    if (adj[start].length === 0) continue;

    const chain = [];
    const queue = [start];
    visited[start] = true;

    while (queue.length > 0 && chain.length < maxChain) {
      const node = queue.shift();
      chain.push(node);

      for (const neighbor of adj[node]) {
        if (!visited[neighbor] && chain.length < maxChain) {
          visited[neighbor] = true;
          queue.push(neighbor);
        }
      }
    }

    if (chain.length >= 2) {
      chains.push(chain);
    }
  }

  return chains;
}

function drawChains(chains, noRepeat) {
  for (let ci = 0; ci < chains.length; ci++) {
    const chain = chains[ci];
    const chainLocs = chain.map(i => currentLocations[i]);

    const hasUsed = noRepeat && chainLocs.some(l => usedRestaurants.has(l.restaurant));

    const isSelected = selectedChains.some(sc =>
      sc.chain.length === chain.length &&
      sc.chain.every((idx, k) =>
        currentLocations[idx]?.id === chainLocs[k]?.id
      )
    );

    const selectedEntry = isSelected
      ? selectedChains.find(sc =>
          sc.chain.length === chain.length &&
          sc.chain.every((idx, k) => currentLocations[idx]?.id === chainLocs[k]?.id)
        )
      : null;

    const edgeCoords = buildChainEdges(chain, currentLocations);

    for (const [a, b] of edgeCoords) {
      const color = isSelected
        ? selectedEntry.color
        : hasUsed
          ? '#333'
          : '#5a8fff';

      const polyline = new google.maps.Polyline({
        path: [
          { lat: a[0], lng: a[1] },
          { lat: b[0], lng: b[1] }
        ],
        geodesic: true,
        strokeColor: color,
        strokeOpacity: isSelected ? 1 : hasUsed ? 0.2 : 0.7,
        strokeWeight: isSelected ? 6 : hasUsed ? 2 : 4,
        map: map,
        zIndex: isSelected ? 50 : 1
      });

      if (!hasUsed) {
        polyline.addListener('mouseover', () => {
          if (!isSelected) {
            highlightChain(chain, true);
          }
        });
        polyline.addListener('mouseout', () => {
          if (!isSelected) {
            highlightChain(chain, false);
          }
        });
        polyline.addListener('click', () => {
          selectChain(chain);
        });
      }

      chainPolylines.push({ chain, polyline, isSelected, hasUsed });
    }
  }
}

function buildChainEdges(chain, locs) {
  if (chain.length <= 1) return [];

  const edges = [];
  const inTree = new Set([chain[0]]);
  const remaining = new Set(chain.slice(1));

  while (remaining.size > 0) {
    let bestEdge = null;
    let bestDist = Infinity;

    for (const a of inTree) {
      for (const b of remaining) {
        const dist = haversine(locs[a].lat, locs[a].lng, locs[b].lat, locs[b].lng);
        if (dist < bestDist) {
          bestDist = dist;
          bestEdge = [a, b];
        }
      }
    }

    if (bestEdge) {
      edges.push([[locs[bestEdge[0]].lat, locs[bestEdge[0]].lng], [locs[bestEdge[1]].lat, locs[bestEdge[1]].lng]]);
      inTree.add(bestEdge[1]);
      remaining.delete(bestEdge[1]);
    } else break;
  }

  return edges;
}

function highlightChain(chain, on) {
  for (const cp of chainPolylines) {
    if (cp.chain === chain && !cp.isSelected) {
      cp.polyline.setOptions({
        strokeColor: on ? '#f59e0b' : '#5a8fff',
        strokeWeight: on ? 6 : 4,
        strokeOpacity: on ? 0.9 : 0.7,
      });
    }
  }
}

function selectChain(chain) {
  const chainLocs = chain.map(i => currentLocations[i]);

  const existingIdx = selectedChains.findIndex(sc =>
    arraysMatchByLocation(sc.chain, chain)
  );

  if (existingIdx !== -1) {
    const removed = selectedChains.splice(existingIdx, 1)[0];
    const removedLocs = removed.chain.map(i => currentLocations[i]);
    for (const l of removedLocs) {
      const stillUsed = selectedChains.some(sc =>
        sc.chain.some(i => currentLocations[i]?.restaurant === l.restaurant)
      );
      if (!stillUsed) usedRestaurants.delete(l.restaurant);
    }
  } else {
    const color = CHAIN_COLORS[selectedChains.length % CHAIN_COLORS.length];
    selectedChains.push({ chain, color });
    for (const l of chainLocs) {
      usedRestaurants.add(l.restaurant);
    }
  }

  rebuildGraph();
}

function arraysMatchByLocation(a, b) {
  if (a.length !== b.length) return false;
  const aIds = new Set(a.map(i => currentLocations[i]?.id));
  return b.every(i => aIds.has(currentLocations[i]?.id));
}

function updateStats(locCount, chainCount) {
  document.getElementById('stats').innerHTML = `
    <strong>${locCount}</strong> ubicaciones<br>
    <strong>${chainCount}</strong> cadenas encontradas<br>
    <strong>${selectedChains.length}</strong> cadenas seleccionadas<br>
    <strong>${usedRestaurants.size}</strong> restaurantes elegidos
  `;
}

function updateLegend() {
  const legend = document.getElementById('legend');

  if (selectedChains.length === 0) {
    legend.innerHTML = '<span class="legend-empty">Haz clic en una línea del mapa para seleccionar una cadena.</span>';
    return;
  }

  legend.innerHTML = '';
  for (let i = 0; i < selectedChains.length; i++) {
    const sc = selectedChains[i];
    const names = sc.chain
      .map(idx => currentLocations[idx])
      .map(l => l.restaurant)
      .filter((v, j, a) => a.indexOf(v) === j) // unique
      .join(' → ');

    const item = document.createElement('div');
    item.className = 'legend-item';
    item.innerHTML = `<span class="legend-dot" style="background:${sc.color}"></span>${names}`;
    item.title = 'Clic para deseleccionar';
    item.addEventListener('click', () => selectChain(sc.chain));
    legend.appendChild(item);
  }
}
