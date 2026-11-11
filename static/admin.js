const HIDE_AFTER_REPORTS = 3;
const $ = id => document.getElementById(id);

function el(tag, className = "", text = "") {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}

function adminKey() {
  return sessionStorage.getItem("adminKey") ?? "";
}

async function call(path, method = "GET") {
  const response = await fetch(path, { method, headers: { "X-Admin-Key": adminKey() } });
  if (response.status === 403) throw new Error("Wrong admin key.");
  if (!response.ok) throw new Error(`Request failed (${response.status}).`);
  return response.status === 204 ? null : response.json();
}

function spotRow(spot) {
  const item = el("li");
  const photo = spot.has_photo ? el("img") : el("div", "empty-photo");
  if (spot.has_photo) {
    photo.src = `/api/spots/${spot.id}/photo`;
    photo.alt = "";
  }
  const info = el("div", "info");
  const count = `${spot.reports} report${spot.reports === 1 ? "" : "s"}`;
  const reports = spot.reports >= HIDE_AFTER_REPORTS ? `${count} · hidden` : count;
  info.append(el("strong", "", spot.name), el("small", spot.reports ? "flagged" : "", reports),
    el("small", "", `#${spot.id} · ${spot.lat.toFixed(4)}, ${spot.lng.toFixed(4)}`));

  const clear = el("button", "", "Clear reports");
  clear.disabled = spot.reports === 0;
  clear.onclick = () => act(`/api/admin/spots/${spot.id}/reports`, `Clear the reports on "${spot.name}"?`);
  const remove = el("button", "danger", "Delete");
  remove.onclick = () => act(`/api/admin/spots/${spot.id}`, `Delete "${spot.name}" for everyone? This can't be undone.`);
  item.append(photo, info, clear, remove);
  return item;
}

async function act(path, question) {
  if (!confirm(question)) return;
  try {
    await call(path, "DELETE");
    await loadSpots();
  } catch (error) {
    $("status").textContent = error.message;
  }
}

async function loadSpots() {
  $("status").textContent = "Loading…";
  try {
    const spots = await call("/api/admin/spots");
    $("spots").replaceChildren(...spots.map(spotRow));
    const flagged = spots.filter(spot => spot.reports > 0).length;
    $("status").textContent = `${spots.length} spots · ${flagged} with reports`;
  } catch (error) {
    $("spots").replaceChildren();
    $("status").textContent = error.message;
  }
}

$("login").addEventListener("submit", event => {
  event.preventDefault();
  sessionStorage.setItem("adminKey", $("key").value);
  $("key").value = "";
  loadSpots();
});

if (adminKey()) loadSpots();
