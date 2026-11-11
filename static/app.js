const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const OVERPASS_URL = "https://overpass-api.de/api/interpreter";
const PLACE_TYPES = {
  cafe: { label: "Café", color: "#b45309" },
  library: { label: "Library", color: "#4338ca" },
  fast_food: { label: "Fast food", color: "#dc2626" },
  coworking_space: { label: "Coworking", color: "#0891b2" }
};

const $ = id => document.getElementById(id);
const POPUP = { minWidth: 240, autoPanPaddingTopLeft: [16, 150], autoPanPaddingBottomRight: [16, 24] };

function load(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}

function save(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    showToast("Couldn't save on this device.", 2500);
  }
}

let spots = [];
let log = [load("log", [])].flat().filter(entry => Number.isFinite(entry?.amount) && Number.isFinite(entry?.time));
let pendingLatLng = null;
let photoData = null;
let addMode = false;
let popupOpen = false;
let placesRequest = null;
let placesTimer = null;
let youMarker = null;
let userLatLng = null;
let searchMarker = null;
const spotMarkers = new Map();

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search?format=json&limit=10&extratags=1";
const EURO = ["AT", "BE", "CY", "DE", "EE", "ES", "FI", "FR", "GR", "HR", "IE", "IT", "LT", "LU", "LV", "MT", "NL", "PT", "SI", "SK"];
const CURRENCIES = {
  PH: "₱", US: "$", CA: "$", AU: "$", NZ: "$", SG: "$", HK: "$", MX: "$", GB: "£", IN: "₹", JP: "¥", CN: "¥",
  KR: "₩", ID: "Rp", MY: "RM", TH: "฿", VN: "₫", NG: "₦", BR: "R$", ZA: "R", KE: "KSh", PK: "Rs", BD: "৳",
  TR: "₺", PL: "zł", UA: "₴", AE: "AED ", SA: "SAR ", EG: "E£"
};
const SYMBOLS = ["$", "€", "£", "₱", "₹", "¥", "₩", "Rp", "RM", "฿", "₫", "₦", "R$", "R", "KSh", "Rs", "৳", "₺", "zł", "₴", "AED ", "SAR ", "E£"];

function guessCurrency() {
  const region = new Intl.Locale(navigator.language).maximize().region;
  return EURO.includes(region) ? "€" : CURRENCIES[region] ?? "$";
}

let currency = load("currency", guessCurrency());
const reporterId = load("reporter", null) ?? crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
save("reporter", reporterId);
function money(amount) {
  const text = Math.abs(amount).toLocaleString(undefined, { maximumFractionDigits: 2 });
  return `${amount < 0 ? "-" : ""}${currency}${text}`;
}

const map = L.map("map", { zoomControl: false, minZoom: 3, worldCopyJump: true }).setView([20, 0], 3);
L.control.zoom({ position: "topright" }).addTo(map);
L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  attribution: "© OpenStreetMap contributors",
  maxZoom: 19
}).addTo(map);

const placeLayer = L.layerGroup().addTo(map);
const spotLayer = L.layerGroup().addTo(map);
const form = $("spot-form");
const dialog = $("spot-dialog");
$("budget").value = load("budget", 500);

function el(tag, className = "", text = "") {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}

function image(src, className) {
  const node = el("img", className);
  node.src = src;
  node.alt = "";
  node.loading = "lazy";
  return node;
}

function link(text, href) {
  const node = el("a", "button", text);
  node.href = href;
  node.target = "_blank";
  node.rel = "noopener";
  return node;
}

function showToast(message, duration = 0) {
  const toast = $("toast");
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(toast.timer);
  if (duration) toast.timer = setTimeout(() => (toast.hidden = true), duration);
}

function hideToast() {
  $("toast").hidden = true;
}

function costLabel(cost) {
  return cost === 0 ? "Free" : money(cost);
}

function tagRow(spot) {
  const row = el("div", "tags");
  [spot.wifi && "📶 Wi-Fi", spot.outlets && "🔌 Outlets", spot.quiet && "🤫 Quiet"]
    .filter(Boolean)
    .forEach(tag => row.append(el("span", "tag", tag)));
  return row;
}

function directionsUrl(lat, lng) {
  return `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;
}

function photoUrl(spot) {
  return `/api/spots/${spot.id}/photo`;
}

function spotPopup(spot) {
  const card = el("div", "popup");
  if (spot.has_photo) card.append(image(photoUrl(spot), "popup-photo"));
  const logButton = el("button", "primary", "Log session");
  logButton.onclick = () => logSession(spot);
  const actions = el("div", "actions");
  actions.append(logButton, link("Directions", directionsUrl(spot.lat, spot.lng)));
  const reportButton = el("button", "report", "Report a problem");
  reportButton.onclick = () => reportSpot(spot);
  card.append(el("span", "badge", costLabel(spot.cost)), el("h3", "", spot.name), tagRow(spot), actions, reportButton);
  return card;
}

function spotItem(spot) {
  const item = el("li", "spot");
  const thumb = spot.has_photo ? image(photoUrl(spot), "thumb") : el("div", "thumb placeholder", "📚");
  const info = el("div", "info");
  info.append(el("h4", "", spot.name), el("span", "badge", costLabel(spot.cost)), tagRow(spot));
  item.append(thumb, info);
  item.onclick = () => focusSpot(spot);
  return item;
}

function pinIcon(spot) {
  return L.divIcon({ className: "pin-anchor", iconSize: [0, 0], html: `<div class="pin">${costLabel(spot.cost)}</div>` });
}

function activeFilters() {
  return [...document.querySelectorAll("[data-filter]:checked")].map(box => box.dataset.filter);
}

function visibleSpots() {
  const filters = activeFilters();
  return spots.filter(spot => filters.every(filter => (filter === "free" ? spot.cost === 0 : spot[filter])));
}

function renderMarkers() {
  spotLayer.clearLayers();
  spotMarkers.clear();
  visibleSpots().forEach(spot => {
    const marker = L.marker([spot.lat, spot.lng], { icon: pinIcon(spot), zIndexOffset: 1000 })
      .bindPopup(() => spotPopup(spot), POPUP)
      .addTo(spotLayer);
    spotMarkers.set(spot.id, marker);
  });
}

function renderList() {
  const center = map.getCenter();
  const sorted = visibleSpots().sort((a, b) => center.distanceTo([a.lat, a.lng]) - center.distanceTo([b.lat, b.lng]));
  $("spots").replaceChildren(...sorted.map(spotItem));
  $("empty").hidden = sorted.length > 0;
}

function renderSpots() {
  renderMarkers();
  renderList();
}

function focusSpot(spot) {
  setSheet(false);
  map.once("moveend", () => spotMarkers.get(spot.id)?.openPopup());
  map.flyTo([spot.lat, spot.lng], 18, { duration: 0.8 });
}

function placePopup(tags, lat, lng) {
  const card = el("div", "popup");
  if (tags.image?.startsWith("https://")) card.append(image(tags.image, "popup-photo"));
  card.append(el("span", "badge muted", PLACE_TYPES[tags.amenity].label), el("h3", "", tags.name));

  const address = [tags["addr:housenumber"], tags["addr:street"], tags["addr:city"]].filter(Boolean).join(" ");
  if (address) card.append(el("p", "detail", `📍 ${address}`));
  if (tags.opening_hours) card.append(el("p", "detail", `🕒 ${tags.opening_hours}`));
  if (["wlan", "yes"].includes(tags.internet_access)) card.append(el("p", "detail", "📶 Wi-Fi listed"));

  const addButton = el("button", "primary", "Add as spot");
  addButton.onclick = () => {
    map.closePopup();
    openDialog(L.latLng(lat, lng), tags.name);
  };
  const searchUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${tags.name} ${lat},${lng}`)}`;
  const actions = el("div", "actions");
  actions.append(addButton, link("Photos", searchUrl));
  card.append(actions);
  return card;
}

function addPlace(element) {
  const lat = element.lat ?? element.center.lat;
  const lng = element.lon ?? element.center.lon;
  const { color } = PLACE_TYPES[element.tags.amenity];
  L.circleMarker([lat, lng], { radius: 7, color: "#fff", weight: 2, fillColor: color, fillOpacity: 1 })
    .bindPopup(() => placePopup(element.tags, lat, lng), { ...POPUP, minWidth: 220 })
    .bindTooltip(element.tags.name, { direction: "top", offset: [0, -8] })
    .addTo(placeLayer);
}

async function loadPlaces() {
  if (popupOpen) return;
  if (map.getZoom() < 15) {
    placeLayer.clearLayers();
    return;
  }

  placesRequest?.abort();
  placesRequest = new AbortController();
  const bounds = map.getBounds();
  const bbox = [bounds.getSouth(), bounds.getWest(), bounds.getNorth(), bounds.getEast()].join(",");
  const amenities = Object.keys(PLACE_TYPES).join("|");
  const query = `[out:json][timeout:15];nwr["amenity"~"^(${amenities})$"]["name"](${bbox});out center 150;`;

  try {
    const response = await fetch(OVERPASS_URL, {
      method: "POST",
      body: new URLSearchParams({ data: query }),
      signal: placesRequest.signal
    });
    const data = await response.json();
    placeLayer.clearLayers();
    data.elements.forEach(addPlace);
  } catch {
    return;
  }
}

function schedulePlaces() {
  clearTimeout(placesTimer);
  placesTimer = setTimeout(loadPlaces, 700);
}

async function loadSpots() {
  try {
    const response = await fetch("/api/spots");
    if (!response.ok) throw new Error(response.status);
    spots = await response.json();
    renderSpots();
  } catch {
    showToast("Couldn't load spots. Try refreshing the page.", 4000);
  }
}

async function addSpot(spot) {
  let response;
  try {
    response = await fetch("/api/spots", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(spot)
    });
  } catch {
    return showToast("Couldn't reach the server. Check your connection and try again.", 3500);
  }
  if (!response.ok) return showToast("Could not save the spot. Check the name and price.", 3500);
  spots.push(await response.json());
  renderSpots();
  showToast("Spot shared. Thanks! 🎉", 2500);
}

async function reportSpot(spot) {
  if (!confirm(`Report "${spot.name}" as wrong or inappropriate?`)) return;
  try {
    const response = await fetch(`/api/spots/${spot.id}/report`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reporter: reporterId })
    });
    if (!response.ok) throw new Error(response.status);
    map.closePopup();
    showToast("Thanks for the report. We'll take a look.", 3000);
  } catch {
    showToast("Couldn't send the report. Try again later.", 3000);
  }
}

function logSession(spot) {
  const answer = prompt(`How much did you spend at ${spot.name}?`, spot.cost);
  if (answer === null || answer.trim() === "") return;
  const amount = Math.round(Number(answer) * 100) / 100;
  if (!Number.isFinite(amount) || amount < 0) return showToast("Enter an amount like 120", 2500);
  log.push({ spot: spot.name, amount, time: Date.now() });
  save("log", log);
  renderBudget();
  showToast(`Logged ${money(amount)} at ${spot.name}`, 2500);
}

function renderBudget() {
  const budget = Number($("budget").value) || 0;
  const thisWeek = log.filter(entry => Date.now() - entry.time < WEEK_MS);
  const spent = thisWeek.reduce((total, entry) => total + entry.amount, 0);
  const over = spent > budget;

  $("spent").textContent = money(spent);
  $("left").textContent = money(budget - spent);
  $("left").classList.toggle("over", over);
  const used = budget > 0 ? (spent / budget) * 100 : spent > 0 ? 100 : 0;
  $("bar-fill").style.width = `${Math.min(100, used)}%`;
  $("bar-fill").classList.toggle("over", over);

  const items = thisWeek.slice().reverse().map(entry => {
    const item = el("li");
    const name = el("div", "", entry.spot);
    name.append(el("small", "", new Date(entry.time).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })));
    item.append(name, el("strong", "", money(entry.amount)));
    return item;
  });
  $("log").replaceChildren(...items);
  $("log-empty").hidden = items.length > 0;
}

function setSheet(open) {
  $("sheet").classList.toggle("open", open);
  document.body.classList.toggle("sheet-open", open);
}

function setAddMode(on) {
  addMode = on;
  $("add").textContent = on ? "✕ Cancel" : "+ Add spot";
  $("add").classList.toggle("cancel", on);
  document.body.classList.toggle("adding", on);
  if (on) {
    setSheet(false);
    showToast("Tap the map where the spot is, or tap a dot");
  } else {
    hideToast();
  }
}

function openDialog(latlng, name = "") {
  setAddMode(false);
  pendingLatLng = latlng;
  photoData = null;
  form.reset();
  form.elements.namedItem("name").value = name;
  $("photo-preview").hidden = true;
  $("photo-label").hidden = false;
  dialog.returnValue = "";
  dialog.showModal();
}

function resizeImage(file) {
  return new Promise((resolve, reject) => {
    const picture = new Image();
    picture.onerror = () => {
      URL.revokeObjectURL(picture.src);
      reject(new Error("unsupported image"));
    };
    picture.onload = () => {
      const scale = Math.min(1, 800 / Math.max(picture.width, picture.height));
      const canvas = document.createElement("canvas");
      canvas.width = picture.width * scale;
      canvas.height = picture.height * scale;
      canvas.getContext("2d").drawImage(picture, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(picture.src);
      resolve(canvas.toDataURL("image/jpeg", 0.75));
    };
    picture.src = URL.createObjectURL(file);
  });
}

function viewboxAround(center) {
  const box = center.toBounds(10000);
  return [box.getWest(), box.getNorth(), box.getEast(), box.getSouth()].join(",");
}

async function fetchPlaces(query, viewbox) {
  const area = viewbox ? `&viewbox=${viewbox}&bounded=1` : "";
  const response = await fetch(`${NOMINATIM_URL}${area}&q=${encodeURIComponent(query)}`);
  return response.json();
}

async function findNearest(query, center) {
  const results = await fetchPlaces(query, viewboxAround(center));
  return results.sort((a, b) => center.distanceTo([a.lat, a.lon]) - center.distanceTo([b.lat, b.lon]))[0];
}

function placeName(result) {
  return result.name || result.display_name.split(",")[0];
}

function placeType(result) {
  const raw = !result.type || result.type === "yes" ? result.class ?? "place" : result.type;
  const type = raw.replaceAll("_", " ");
  return type.charAt(0).toUpperCase() + type.slice(1);
}

function distanceLabel(latlng) {
  if (!userLatLng) return "";
  const meters = userLatLng.distanceTo(latlng);
  return meters < 1000 ? `${Math.round(meters)} m from you` : `${(meters / 1000).toFixed(1)} km from you`;
}

function searchPopup(result, latlng) {
  const name = placeName(result);
  const card = el("div", "popup");
  card.append(el("span", "badge muted", placeType(result)), el("h3", "", name));

  const address = result.display_name.split(",").slice(1, 4).join(",").trim();
  if (address) card.append(el("p", "detail", `📍 ${address}`));
  const distance = distanceLabel(latlng);
  if (distance) card.append(el("p", "detail", `🚶 ${distance}`));
  const hours = result.extratags?.opening_hours;
  if (hours) card.append(el("p", "detail", `🕒 ${hours}`));

  const addButton = el("button", "primary", "Add as spot");
  addButton.onclick = () => {
    map.closePopup();
    openDialog(latlng, name);
  };
  const actions = el("div", "actions");
  actions.append(addButton, link("Directions", directionsUrl(latlng.lat, latlng.lng)));
  card.append(actions);
  return card;
}

function showSearchResult(result) {
  const latlng = L.latLng(result.lat, result.lon);
  const icon = L.divIcon({ className: "pin-anchor", iconSize: [0, 0], html: el("div", "pin search", `📍 ${placeName(result)}`).outerHTML });
  searchMarker?.remove();
  searchMarker = L.marker(latlng, { icon, zIndexOffset: 2000 })
    .bindPopup(() => searchPopup(result, latlng), { ...POPUP, offset: [0, -30] })
    .addTo(map);
  map.once("moveend", () => searchMarker.openPopup());
  map.flyTo(latlng, 17);
}

async function searchPlace(event) {
  event.preventDefault();
  const query = $("search-input").value.trim();
  if (!query) return;
  const center = userLatLng ?? map.getCenter();
  let result;
  try {
    result = (await findNearest(query, center)) ?? (await fetchPlaces(query))[0];
  } catch {
    return showToast("Search isn't available right now. Try again in a bit.", 3000);
  }
  if (!result) return showToast("Place not found", 2500);
  $("search-input").blur();
  showSearchResult(result);
}

map.on("click", event => {
  if (addMode) openDialog(event.latlng.wrap());
});
map.on("moveend", () => {
  renderList();
  schedulePlaces();
});
map.on("popupopen", () => {
  popupOpen = true;
  document.body.classList.add("popup-open");
});
map.on("popupclose", () => {
  popupOpen = false;
  document.body.classList.remove("popup-open");
});
map.on("locationfound", event => {
  userLatLng = event.latlng;
  youMarker?.remove();
  youMarker = L.circleMarker(event.latlng, { radius: 8, color: "#fff", weight: 3, fillColor: "#2563eb", fillOpacity: 1 }).addTo(map);
});
map.on("locationerror", () => showToast("Couldn't get your location", 2500));

$("search").addEventListener("submit", searchPlace);
$("locate").onclick = () => map.locate({ setView: true, maxZoom: 17 });
$("add").onclick = () => setAddMode(!addMode);
$("handle").onclick = () => setSheet(!$("sheet").classList.contains("open"));
$("cancel-spot").onclick = () => dialog.close("cancel");

document.querySelectorAll(".tab").forEach(tab => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach(other => other.classList.toggle("active", other === tab));
    $("spots-panel").hidden = tab.dataset.tab !== "spots";
    $("budget-panel").hidden = tab.dataset.tab !== "budget";
    setSheet(true);
  });
});

document.querySelectorAll("[data-filter]").forEach(box => box.addEventListener("change", renderSpots));

$("currency").replaceChildren(...[...new Set([currency, ...SYMBOLS])].map(symbol => {
  const option = el("option", "", symbol.trim());
  option.value = symbol;
  return option;
}));
$("currency").value = currency;
$("currency").addEventListener("change", () => {
  currency = $("currency").value;
  save("currency", currency);
  renderSpots();
  renderBudget();
});

$("budget").addEventListener("input", () => {
  save("budget", Number($("budget").value));
  renderBudget();
});

$("photo").addEventListener("change", async event => {
  const [file] = event.target.files;
  if (!file) return;
  try {
    photoData = await resizeImage(file);
  } catch {
    event.target.value = "";
    return showToast("That photo type isn't supported. Try a JPG or PNG.", 3000);
  }
  $("photo-preview").src = photoData;
  $("photo-preview").hidden = false;
  $("photo-label").hidden = true;
});

dialog.addEventListener("close", () => {
  if (dialog.returnValue !== "save") return;
  const data = new FormData(form);
  addSpot({
    name: data.get("name"),
    cost: Number(data.get("cost")),
    wifi: data.has("wifi"),
    outlets: data.has("outlets"),
    quiet: data.has("quiet"),
    lat: pendingLatLng.lat,
    lng: pendingLatLng.lng,
    photo: photoData
  });
});

map.locate({ setView: true, maxZoom: 16 });
loadSpots();
renderBudget();
schedulePlaces();
