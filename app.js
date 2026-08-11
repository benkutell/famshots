/* ===========================================================
   FamShots — Dropbox-backed photo search with on-device face matching.
   Everything (auth tokens, photo cache, face descriptors) lives only
   in this browser's local storage / IndexedDB. Nothing goes to any
   server other than Dropbox's own API and the CDN that serves the
   face-matching model files.
=========================================================== */

const MODEL_URL = "https://cdn.jsdelivr.net/npm/@vladmandic/face-api/model";
const MATCH_THRESHOLD = 0.58; // lower = stricter face match
const IMAGE_EXT = /\.(jpe?g|png|heic|webp)$/i;

const REDIRECT_URI = location.origin + location.pathname;

const $ = (sel) => document.querySelector(sel);
const state = {
  appKey: localStorage.getItem("fs_app_key") || "",
  accessToken: localStorage.getItem("fs_access_token") || "",
  refreshToken: localStorage.getItem("fs_refresh_token") || "",
  cursor: localStorage.getItem("fs_cursor") || "",
  activeFilterPerson: null,
  modelsReady: false,
};

/* ---------------- IndexedDB (photos, thumbnails, faces, people) ---------------- */
let dbp = new Promise((resolve, reject) => {
  const req = indexedDB.open("famshots", 1);
  req.onupgradeneeded = () => {
    const db = req.result;
    if (!db.objectStoreNames.contains("photos")) db.createObjectStore("photos", { keyPath: "path" });
    if (!db.objectStoreNames.contains("thumbs")) db.createObjectStore("thumbs", { keyPath: "path" });
    if (!db.objectStoreNames.contains("faces")) db.createObjectStore("faces", { keyPath: "id", autoIncrement: true });
    if (!db.objectStoreNames.contains("people")) db.createObjectStore("people", { keyPath: "id", autoIncrement: true });
  };
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

async function idbAll(store) {
  const db = await dbp;
  return new Promise((res, rej) => {
    const tx = db.transaction(store, "readonly");
    const req = tx.objectStore(store).getAll();
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}
async function idbPut(store, val) {
  const db = await dbp;
  return new Promise((res, rej) => {
    const tx = db.transaction(store, "readwrite");
    const req = tx.objectStore(store).put(val);
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}
async function idbGet(store, key) {
  const db = await dbp;
  return new Promise((res, rej) => {
    const tx = db.transaction(store, "readonly");
    const req = tx.objectStore(store).get(key);
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}

/* ---------------- PKCE helpers ---------------- */
function randomString(len = 64) {
  const arr = new Uint8Array(len);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"[b % 62]).join("");
}
async function sha256base64url(input) {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  let str = "";
  new Uint8Array(digest).forEach((b) => (str += String.fromCharCode(b)));
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/* ---------------- Auth flow ---------------- */
async function beginAuth() {
  const appKey = $("#appKeyInput").value.trim();
  if (!appKey) {
    setConnectStatus("Paste your Dropbox App key first.", true);
    return;
  }
  localStorage.setItem("fs_app_key", appKey);
  const verifier = randomString(96);
  sessionStorage.setItem("fs_pkce_verifier", verifier);
  const challenge = await sha256base64url(verifier);

  const url = new URL("https://www.dropbox.com/oauth2/authorize");
  url.searchParams.set("client_id", appKey);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("token_access_type", "offline");
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  location.href = url.toString();
}

async function completeAuthIfRedirected() {
  const params = new URLSearchParams(location.search);
  const code = params.get("code");
  if (!code) return false;
  const verifier = sessionStorage.getItem("fs_pkce_verifier");
  const appKey = localStorage.getItem("fs_app_key");
  setConnectStatus("Finishing sign-in…");
  try {
    const body = new URLSearchParams({
      code,
      grant_type: "authorization_code",
      client_id: appKey,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    });
    const res = await fetch("https://api.dropboxapi.com/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error_description || json.error || "Token exchange failed");
    state.accessToken = json.access_token;
    state.refreshToken = json.refresh_token || state.refreshToken;
    localStorage.setItem("fs_access_token", state.accessToken);
    if (json.refresh_token) localStorage.setItem("fs_refresh_token", json.refresh_token);
    history.replaceState({}, "", REDIRECT_URI);
    return true;
  } catch (err) {
    setConnectStatus("Sign-in failed: " + err.message, true);
    return false;
  }
}

async function refreshAccessToken() {
  const appKey = localStorage.getItem("fs_app_key");
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: state.refreshToken,
    client_id: appKey,
  });
  const res = await fetch("https://api.dropboxapi.com/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error_description || "Could not refresh session");
  state.accessToken = json.access_token;
  localStorage.setItem("fs_access_token", state.accessToken);
}

/* ---------------- Dropbox API wrapper (auto-retries once on 401) ---------------- */
async function dbxFetch(url, opts = {}, isContent = false) {
  const doCall = () =>
    fetch(url, {
      ...opts,
      headers: { ...(opts.headers || {}), Authorization: "Bearer " + state.accessToken },
    });
  let res = await doCall();
  if (res.status === 401 && state.refreshToken) {
    await refreshAccessToken();
    res = await doCall();
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Dropbox API error (${res.status}): ${text.slice(0, 200)}`);
  }
  return res;
}

async function listAllPhotos() {
  let entries = [];
  let res = await dbxFetch("https://api.dropboxapi.com/2/files/list_folder", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: "", recursive: true, include_non_downloadable_files: false }),
  });
  let json = await res.json();
  entries = entries.concat(json.entries);
  while (json.has_more) {
    res = await dbxFetch("https://api.dropboxapi.com/2/files/list_folder/continue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cursor: json.cursor }),
    });
    json = await res.json();
    entries = entries.concat(json.entries);
  }
  return entries.filter((e) => e[".tag"] === "file" && IMAGE_EXT.test(e.name));
}

async function fetchThumbnail(path, size = "w480h320") {
  const res = await dbxFetch(
    "https://content.dropboxapi.com/2/files/get_thumbnail_v2",
    {
      method: "POST",
      headers: {
        "Dropbox-API-Arg": JSON.stringify({
          resource: { ".tag": "path", path },
          format: "jpeg",
          size,
          mode: "strict",
        }),
      },
    },
    true
  );
  return res.blob();
}

/* ---------------- UI helpers ---------------- */
function setConnectStatus(msg, isError = false) {
  const el = $("#connectStatus");
  el.textContent = msg;
  el.classList.toggle("error", isError);
}
function showMain() {
  $("#view-connect").classList.remove("active");
  $("#mainApp").classList.remove("hidden");
}
function switchTab(name) {
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
  $("#view-photos").classList.toggle("active", name === "photos");
  $("#view-people").classList.toggle("active", name === "people");
  $("#brandTitle").textContent = name === "photos" ? "Photos" : "People";
}
function setIndexBanner(text, active) {
  $("#indexBannerText").textContent = text;
  $("#indexBanner").classList.toggle("active", active);
}

/* ---------------- Rendering ---------------- */
async function renderGrid() {
  const photos = await idbAll("photos");
  photos.sort((a, b) => new Date(b.server_modified) - new Date(a.server_modified));

  let visible = photos;
  if (state.activeFilterPerson) {
    const faces = await idbAll("faces");
    const paths = new Set(faces.filter((f) => f.personId === state.activeFilterPerson).map((f) => f.path));
    visible = photos.filter((p) => paths.has(p.path));
  }

  const grid = $("#photosGrid");
  grid.innerHTML = "";
  $("#photosEmpty").classList.toggle("hidden", visible.length > 0);

  for (const p of visible) {
    const cell = document.createElement("div");
    cell.className = "thumb skeleton";
    grid.appendChild(cell);
    idbGet("thumbs", p.path).then((rec) => {
      cell.classList.remove("skeleton");
      const img = document.createElement("img");
      img.loading = "lazy";
      img.src = rec ? URL.createObjectURL(rec.blob) : "";
      img.onclick = () => openViewer(p.path);
      cell.appendChild(img);
      if (p.hasFace) {
        const dot = document.createElement("div");
        dot.className = "face-dot";
        cell.appendChild(dot);
      }
    });
  }
}

async function renderPeople() {
  const people = await idbAll("people");
  const grid = $("#peopleGrid");
  grid.innerHTML = "";
  const shown = people.filter((p) => p.count >= 1).sort((a, b) => b.count - a.count);
  $("#peopleEmpty").classList.toggle("hidden", shown.length > 0);

  for (const person of shown) {
    const btn = document.createElement("button");
    btn.className = "person";
    btn.innerHTML = `
      <div class="avatar"><img src="${person.avatarDataUrl}" alt=""></div>
      <div class="name">${person.name || "Unnamed"}</div>
      <div class="count">${person.count} photo${person.count === 1 ? "" : "s"}</div>`;
    btn.onclick = () => {
      if (!person.name) {
        const name = prompt("Name this person?", "");
        if (name) {
          person.name = name;
          idbPut("people", person);
          btn.querySelector(".name").textContent = name;
        }
      }
      state.activeFilterPerson = person.id;
      $("#filterAvatar").src = person.avatarDataUrl;
      $("#filterLabel").textContent = person.name || "Unnamed";
      $("#filterBar").classList.add("active");
      switchTab("photos");
      renderGrid();
    };
    grid.appendChild(btn);
  }
}

function openViewer(path) {
  idbGet("thumbs", path).then((rec) => {
    if (!rec) return;
    $("#viewerImg").src = URL.createObjectURL(rec.blob);
    $("#viewer").classList.add("active");
  });
}

/* ---------------- Face model loading ---------------- */
async function ensureModels() {
  if (state.modelsReady) return;
  await faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL);
  await faceapi.nets.faceLandmark68TinyNet.loadFromUri(MODEL_URL);
  await faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL);
  state.modelsReady = true;
}

/* ---------------- Clustering ---------------- */
function euclidean(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += (a[i] - b[i]) ** 2;
  return Math.sqrt(sum);
}

async function assignToPerson(descriptor, cropDataUrl) {
  const people = await idbAll("people");
  let best = null;
  let bestDist = Infinity;
  for (const person of people) {
    const d = euclidean(person.centroid, descriptor);
    if (d < bestDist) {
      bestDist = d;
      best = person;
    }
  }
  if (best && bestDist < MATCH_THRESHOLD) {
    const n = best.count;
    best.centroid = best.centroid.map((v, i) => (v * n + descriptor[i]) / (n + 1));
    best.count = n + 1;
    await idbPut("people", best);
    return best.id;
  }
  const newPerson = {
    centroid: descriptor,
    count: 1,
    name: "",
    avatarDataUrl: cropDataUrl,
  };
  const id = await idbPut("people", newPerson);
  return id;
}

async function cropFaceDataUrl(imgEl, box) {
  const canvas = document.createElement("canvas");
  const pad = box.width * 0.35;
  const sx = Math.max(0, box.x - pad);
  const sy = Math.max(0, box.y - pad);
  const sw = Math.min(imgEl.width - sx, box.width + pad * 2);
  const sh = Math.min(imgEl.height - sy, box.height + pad * 2);
  canvas.width = 160;
  canvas.height = 160;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(imgEl, sx, sy, sw, sh, 0, 0, 160, 160);
  return canvas.toDataURL("image/jpeg", 0.85);
}

/* ---------------- Sync + indexing pipeline ---------------- */
let syncing = false;
async function syncAndIndex() {
  if (syncing) return;
  syncing = true;
  try {
    setIndexBanner("Checking Dropbox for new photos…", true);
    const entries = await listAllPhotos();
    const known = new Map((await idbAll("photos")).map((p) => [p.path, p]));

    for (const e of entries) {
      if (!known.has(e.path_lower)) {
        await idbPut("photos", {
          path: e.path_lower,
          name: e.name,
          server_modified: e.server_modified,
          hasFace: false,
          indexed: false,
        });
      }
    }
    renderGrid();

    const photos = (await idbAll("photos")).filter((p) => !p.indexed);
    if (photos.length === 0) {
      setIndexBanner("", false);
      syncing = false;
      return;
    }

    await ensureModels();
    const MAX_ATTEMPTS = 3;
    let done = 0;
    let failedCount = 0;
    for (const p of photos) {
      setIndexBanner(`Matching faces… ${done}/${photos.length}`, true);
      let succeeded = false;
      try {
        let thumbRec = await idbGet("thumbs", p.path);
        if (!thumbRec) {
          const blob = await fetchThumbnail(p.path, "w640h480");
          thumbRec = { path: p.path, blob };
          await idbPut("thumbs", thumbRec);
          renderGrid();
        }
        const imgEl = await blobToImage(thumbRec.blob);
        const results = await faceapi
          .detectAllFaces(imgEl, new faceapi.TinyFaceDetectorOptions({ inputSize: 320 }))
          .withFaceLandmarks(true)
          .withFaceDescriptors();

        if (results.length > 0) {
          p.hasFace = true;
          for (const r of results) {
            const crop = await cropFaceDataUrl(imgEl, r.detection.box);
            const personId = await assignToPerson(Array.from(r.descriptor), crop);
            await idbPut("faces", { path: p.path, personId });
          }
        }
        succeeded = true;
      } catch (err) {
        console.warn("Indexing failed for", p.path, err);
      }

      // Only mark a photo "indexed" (done, won't be retried) once it has
      // actually been processed successfully. A photo that fails (e.g. a
      // network blip mid-download, or the app closing mid-index) is left
      // for the next sync to pick up again automatically — up to
      // MAX_ATTEMPTS times, after which it's marked as a permanent skip
      // so a single corrupt file can't stall every future sync forever.
      if (succeeded) {
        p.indexed = true;
        p.failCount = 0;
      } else {
        p.failCount = (p.failCount || 0) + 1;
        if (p.failCount >= MAX_ATTEMPTS) {
          p.indexed = true;
          p.indexFailed = true;
        }
        failedCount++;
      }
      await idbPut("photos", p);
      done++;
      if (done % 5 === 0) {
        renderGrid();
        renderPeople();
      }
    }
    renderGrid();
    renderPeople();
    setIndexBanner(
      failedCount > 0 ? `Done — ${failedCount} photo${failedCount === 1 ? "" : "s"} will retry next sync` : "",
      failedCount > 0
    );
    if (failedCount > 0) setTimeout(() => setIndexBanner("", false), 5000);
  } catch (err) {
    console.error(err);
    setIndexBanner("Sync paused — " + err.message, true);
    setTimeout(() => setIndexBanner("", false), 4000);
  } finally {
    syncing = false;
  }
}

function blobToImage(blob) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = URL.createObjectURL(blob);
  });
}

/* ---------------- Maintenance ---------------- */
async function clearStore(name) {
  const db = await dbp;
  return new Promise((res, rej) => {
    const tx = db.transaction(name, "readwrite");
    tx.objectStore(name).clear();
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}

async function rebuildFaceIndex() {
  await clearStore("faces");
  await clearStore("people");
  const photos = await idbAll("photos");
  for (const p of photos) {
    p.indexed = false;
    p.hasFace = false;
    p.failCount = 0;
    delete p.indexFailed;
    await idbPut("photos", p);
  }
  state.activeFilterPerson = null;
  $("#filterBar").classList.remove("active");
  await renderGrid();
  await renderPeople();
  syncAndIndex();
}

/* ---------------- Wire up events ---------------- */
$("#connectBtn").addEventListener("click", beginAuth);
$("#settingsBtn").addEventListener("click", () => $("#settingsSheet").classList.add("active"));
$("#settingsCancel").addEventListener("click", () => $("#settingsSheet").classList.remove("active"));
$("#rebuildIndexBtn").addEventListener("click", () => {
  $("#settingsSheet").classList.remove("active");
  if (confirm("Clear and re-scan all faces? Photos already downloaded won't be re-downloaded, just re-matched. This can take a while on a large library.")) {
    rebuildFaceIndex();
  }
});
$("#signOutBtn").addEventListener("click", () => {
  $("#settingsSheet").classList.remove("active");
  if (confirm("Sign out of Dropbox on this phone? Your photo index stays cached until you clear it.")) {
    localStorage.removeItem("fs_access_token");
    localStorage.removeItem("fs_refresh_token");
    location.reload();
  }
});
document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => switchTab(t.dataset.tab)));
$("#clearFilterBtn").addEventListener("click", () => {
  state.activeFilterPerson = null;
  $("#filterBar").classList.remove("active");
  renderGrid();
});
$("#viewerClose").addEventListener("click", () => $("#viewer").classList.remove("active"));

/* ---------------- Init ---------------- */
(async function init() {
  if (state.appKey) $("#appKeyInput").value = state.appKey;

  const gotToken = await completeAuthIfRedirected();
  if (gotToken || state.accessToken) {
    showMain();
    await renderGrid();
    await renderPeople();
    syncAndIndex();
  }
})();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}
