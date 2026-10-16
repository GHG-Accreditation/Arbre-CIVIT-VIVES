"use strict";

const STORAGE_KEY = "genealogyApp.v2";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const SVG_NS = "http://www.w3.org/2000/svg";

const State = {
  people: [],
  branches: [],
  places: {},
  filter: { query: "", branches: new Set(), onlyRel: false, onlyDates: false, todayAnniv: false, sort: "surname" },
  view: "list",
  editingId: null,
  picker: { active: false, mode: null, onPick: null },
  tree: {
    focusId: null,
    gensUp: 2,
    gensDown: 2,
    pan: { x: 0, y: 0 },
    scale: 1,
  },
  map: {
    instance: null,
    cluster: null,
    branch: "",
    kind: "both",
  },
};

/* ============== Storage ============== */

function safeStorage() {
  try {
    const t = "__t__";
    window.localStorage.setItem(t, t);
    window.localStorage.removeItem(t);
    return window.localStorage;
  } catch (_) { return null; }
}

function load() {
  const ls = safeStorage();
  const raw = ls ? ls.getItem(STORAGE_KEY) : null;
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.people)) {
        State.people = parsed.people;
        State.branches = parsed.branches || window.__PRELOADED_DATA__.branches.slice();
        State.places = parsed.places || window.__PRELOADED_DATA__.places || {};
        migratePeople();
        return;
      }
    } catch (e) { console.warn("Bad stored data", e); }
  }
  const src = window.__PRELOADED_DATA__;
  State.people = src.people.map(p => ({ ...p }));
  State.branches = src.branches.slice();
  State.places = src.places || {};
  migratePeople();
}

/* Older data only had parentIds (unordered) and spouseIds. Split parents into
   fatherId / motherId and turn each spouse into a marriage record. */
function migratePeople() {
  const ids = new Map(State.people.map(p => [p.id, p]));
  for (const p of State.people) {
    if (p.fatherId === undefined && p.motherId === undefined) {
      let father = null, mother = null;
      const rest = [];
      for (const pid of (p.parentIds || [])) {
        const q = ids.get(pid);
        if (!q) continue;
        const s1 = fold(q.surname1);
        if (!father && s1 && s1 === fold(p.surname1)) father = pid;
        else if (!mother && s1 && s1 === fold(p.surname2)) mother = pid;
        else rest.push(pid);
      }
      for (const pid of rest) { if (!father) father = pid; else if (!mother) mother = pid; }
      p.fatherId = father;
      p.motherId = mother;
    }
    p.parentIds = [p.fatherId, p.motherId].filter(Boolean);
    if (!Array.isArray(p.marriages)) p.marriages = [];
  }
  for (const p of State.people) {
    for (const sid of p.spouseIds || []) {
      if (p.marriages.some(m => m.spouseId === sid)) continue;
      const sp = ids.get(sid);
      if (!sp) continue;
      const theirs = sp.marriages.find(m => m.spouseId === p.id);
      const m = theirs
        ? { ...theirs, spouseId: sid }
        : { id: coupleMarriageId(p.id, sid), spouseId: sid, place: "", dateFull: null, year: null };
      p.marriages.push(m);
      if (!theirs) sp.marriages.push({ ...m, spouseId: p.id });
    }
  }
  for (const p of State.people) p.spouseIds = spouseIdsOf(p);
}

function coupleMarriageId(a, b) { return "m-" + [a, b].sort().join("-"); }
function newMarriageId() { return "m" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function spouseIdsOf(p) { return [...new Set((p.marriages || []).map(m => m.spouseId).filter(Boolean))]; }
function marriageBetween(a, b) {
  return (a.marriages || []).find(m => m.spouseId === b.id) ||
         (b.marriages || []).find(m => m.spouseId === a.id) || null;
}

/* ============== Photos (IndexedDB) ==============
   Keys: "<personId>:birth", "<personId>:death", "marriage:<marriageId>"
   (a marriage photo is shared by both spouses). Values: JPEG data URLs. */

const PhotoDB = (() => {
  let dbp = null;
  function open() {
    if (!dbp) dbp = new Promise((res, rej) => {
      if (!window.indexedDB) return rej(new Error("IndexedDB no disponible"));
      const r = indexedDB.open("genealogyPhotos", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("photos");
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return dbp;
  }
  async function tx(mode, fn) {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction("photos", mode);
      const req = fn(t.objectStore("photos"));
      t.oncomplete = () => res(req ? req.result : undefined);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error);
    });
  }
  return {
    get: k => tx("readonly", st => st.get(k)),
    put: (k, v) => tx("readwrite", st => st.put(v, k)),
    del: k => tx("readwrite", st => st.delete(k)),
    async all() {
      const keys = await tx("readonly", st => st.getAllKeys());
      const vals = await tx("readonly", st => st.getAll());
      const out = {};
      keys.forEach((k, i) => { out[k] = vals[i]; });
      return out;
    },
  };
})();

function compressImage(file, maxSide = 2200, quality = 0.85) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const sc = Math.min(1, maxSide / Math.max(img.width, img.height));
      const c = document.createElement("canvas");
      c.width = Math.round(img.width * sc);
      c.height = Math.round(img.height * sc);
      const ctx = c.getContext("2d");
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      res(c.toDataURL("image/jpeg", quality));
    };
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error("No s'ha pogut llegir la imatge")); };
    img.src = url;
  });
}

function photoLabel(key) {
  if (key.endsWith(":birth")) return "naixement";
  if (key.endsWith(":death")) return "defunció";
  return "boda";
}

async function renderPhotoSlot(el, key) {
  el.dataset.key = key || "";
  el.innerHTML = "";
  if (!key) {
    el.innerHTML = `<span class="photo-empty">Desa la fitxa per poder afegir la foto del llibre.</span>`;
    return;
  }
  let url = null;
  try { url = await PhotoDB.get(key); } catch (e) { console.warn(e); }
  if (el.dataset.key !== key) return;
  const fs = el.closest(".marriage");
  if (fs) fs.dataset.hasPhoto = url ? "1" : "";
  const pick = () => {
    const inp = document.createElement("input");
    inp.type = "file";
    inp.accept = "image/jpeg,image/png,image/*";
    inp.addEventListener("change", async () => {
      const f = inp.files && inp.files[0];
      if (!f) return;
      try {
        await PhotoDB.put(key, await compressImage(f));
        toast("Foto desada");
        renderPhotoSlot(el, key);
      } catch (e) { alert("No s'ha pogut desar la foto: " + e.message); }
    });
    inp.click();
  };
  if (!url) {
    const b = document.createElement("button");
    b.type = "button"; b.className = "link-btn photo-add";
    b.textContent = `📷 Afegir foto del llibre (${photoLabel(key)})`;
    b.addEventListener("click", pick);
    el.appendChild(b);
    return;
  }
  const wrap = document.createElement("div");
  wrap.className = "photo-thumb";
  wrap.innerHTML = `<img src="${url}" alt="Foto del llibre (${photoLabel(key)})">
    <div class="photo-actions">
      <button type="button" class="link-btn" data-act="view">Veure</button>
      <button type="button" class="link-btn" data-act="change">Canviar</button>
      <button type="button" class="link-btn danger-link" data-act="del">Treure</button>
    </div>`;
  const view = () => openPhotoViewer(url, `Foto del llibre — ${photoLabel(key)}`);
  wrap.querySelector("img").addEventListener("click", view);
  wrap.querySelector('[data-act="view"]').addEventListener("click", view);
  wrap.querySelector('[data-act="change"]').addEventListener("click", pick);
  wrap.querySelector('[data-act="del"]').addEventListener("click", async () => {
    if (!confirm(`Vols treure la foto de ${photoLabel(key)}? No es podrà recuperar.`)) return;
    await PhotoDB.del(key);
    toast("Foto treta");
    renderPhotoSlot(el, key);
  });
  el.appendChild(wrap);
}

function openPhotoViewer(url, title) {
  $("#photo-title").textContent = title;
  $("#photo-img").src = url;
  $("#photo-download").href = url;
  $("#photo-download").setAttribute("download", "foto-llibre.jpg");
  $("#photo-overlay").classList.remove("hidden");
}
function closePhotoViewer() {
  $("#photo-overlay").classList.add("hidden");
  $("#photo-img").removeAttribute("src");
}

function persist() {
  const ls = safeStorage();
  if (!ls) return;
  try {
    ls.setItem(STORAGE_KEY, JSON.stringify({
      people: State.people,
      branches: State.branches,
      places: State.places,
    }));
  } catch (e) { console.warn("Could not persist data:", e); }
}

function resetData() {
  if (!confirm("Tornar a les dades originals descartarà els canvis locals. Continuar?")) return;
  const ls = safeStorage();
  if (ls) ls.removeItem(STORAGE_KEY);
  load();
  persist();
  renderAll();
  if (State.tree.focusId) renderTree();
  if (State.view === "map") drawMap();
  toast("Dades reiniciades");
}

/* ============== Utilities ============== */

function nextId() {
  let max = 0;
  for (const p of State.people) {
    const m = /^p(\d+)$/.exec(p.id || "");
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `p${String(max + 1).padStart(4, "0")}`;
}

function byId(id) { return State.people.find(p => p.id === id); }
function fullName(p) {
  return [p.firstName, p.surname1, p.surname2].filter(Boolean).join(" ").trim() || "(Sense nom)";
}
function surnameKey(p) {
  return `${(p.surname1||"").toLowerCase()} ${(p.surname2||"").toLowerCase()} ${(p.firstName||"").toLowerCase()}`;
}
function lifeSpan(p) {
  const b = formatLifeDate(p.birthDateFull, p.birthYear);
  const d = formatLifeDate(p.deathDateFull, p.deathYear);
  if (!b && !d) return "";
  return `${b || "?"} – ${d || "…"}`;
}

const MONTHS_CA = ["gen","feb","març","abr","maig","juny","jul","ago","set","oct","nov","des"];

function parseDDMMYYYY(s) {
  if (!s) return null;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(s).trim());
  if (!m) return null;
  const d = +m[1], mo = +m[2], y = +m[3];
  if (d < 1 || d > 31 || mo < 1 || mo > 12) return null;
  return { d, m: mo, y };
}

function normalizeDateInput(raw) {
  const s = (raw || "").trim();
  if (!s) return "";
  const m = /^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})$/.exec(s);
  if (!m) return "";
  const d = +m[1], mo = +m[2], y = +m[3];
  if (d < 1 || d > 31 || mo < 1 || mo > 12) return "";
  return `${String(d).padStart(2,"0")}/${String(mo).padStart(2,"0")}/${y}`;
}

function formatLifeDate(dateFull, yearFallback) {
  const dt = parseDDMMYYYY(dateFull);
  if (dt) return `${dt.d} ${MONTHS_CA[dt.m - 1]} ${dt.y}`;
  if (yearFallback) return String(yearFallback);
  return "";
}

/* "Lloc, data" — place first, then date (as written in the parish books). */
function eventText(place, dateFull, year) {
  return [place, formatLifeDate(dateFull, year)].filter(Boolean).join(", ");
}

/* Accepts DD/MM/AAAA or just AAAA. Returns null when the text is not valid. */
function parseFlexibleDate(raw) {
  const s = (raw || "").trim();
  if (!s) return { dateFull: null, year: null };
  if (/^\d{4}$/.test(s)) return { dateFull: null, year: +s };
  const n = normalizeDateInput(s);
  if (!n) return null;
  return { dateFull: n, year: parseDDMMYYYY(n).y };
}
function flexibleDateText(dateFull, year) { return dateFull || (year != null ? String(year) : ""); }

function searchTokens(q) { return fold(q).split(/\s+/).filter(Boolean); }
function matchesTokens(hay, tokens) { return tokens.every(t => hay.includes(t)); }
function nameHaystack(p) { return fold(`${p.firstName||""} ${p.surname1||""} ${p.surname2||""}`); }
function searchHaystack(p) {
  const parts = [p.firstName, p.surname1, p.surname2, p.birthPlace, p.deathPlace,
                 p.birthYear, p.deathYear, p.birthDateFull, p.deathDateFull];
  for (const m of p.marriages || []) parts.push(m.place, m.year, m.dateFull);
  return fold(parts.filter(x => x != null && x !== "").join(" "));
}

function formatDayMonth(dateFull) {
  const dt = parseDDMMYYYY(dateFull);
  if (!dt) return "";
  return `${dt.d} ${MONTHS_CA[dt.m - 1]}`;
}

function todayKey() {
  const d = new Date();
  return `${String(d.getDate()).padStart(2,"0")}/${String(d.getMonth()+1).padStart(2,"0")}`;
}

function dateDayMonth(dateFull) {
  const dt = parseDDMMYYYY(dateFull);
  if (!dt) return null;
  return `${String(dt.d).padStart(2,"0")}/${String(dt.m).padStart(2,"0")}`;
}
function childrenOf(id) {
  return State.people.filter(p => Array.isArray(p.parentIds) && p.parentIds.includes(id));
}
function placeKey(v) {
  if (!v) return null;
  let s = String(v);
  s = s.split(/[\/,]/)[0];
  s = s.replace(/\b\d.*$/, "").trim();
  s = s.replace(/\s+/g, " ").toLowerCase();
  return s || null;
}
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
}
function fold(s) {
  return String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}
function branchShort(key) {
  const b = State.branches.find(x => x.key === key);
  if (!b) return key;
  const m = /\b([A-Za-zÀ-ú]+)$/.exec(b.label);
  return m ? m[1] : b.label;
}

let toastTimer = null;
function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), 1600);
}

/* ============== View switching ============== */

function switchView(name) {
  State.view = name;
  $$(".view-tabs .tab").forEach(b => b.classList.toggle("active", b.dataset.view === name));
  $$(".view").forEach(v => v.classList.toggle("active", v.id === "view-" + name));
  if (name === "tree") renderTree();
  if (name === "map")  ensureMap();
}

/* ============== List view ============== */

function renderBranchChips() {
  const root = $("#branch-chips");
  root.innerHTML = "";
  for (const b of State.branches) {
    const chip = document.createElement("span");
    chip.className = `chip ${b.key}` + (State.filter.branches.has(b.key) ? " active" : "");
    chip.dataset.key = b.key;
    chip.innerHTML = `<span class="dot" style="background:${b.color}"></span>${b.label}`;
    chip.addEventListener("click", () => {
      if (State.filter.branches.has(b.key)) State.filter.branches.delete(b.key);
      else State.filter.branches.add(b.key);
      renderBranchChips();
      renderPeopleList();
    });
    root.appendChild(chip);
  }
}

function matchesFilter(p) {
  const f = State.filter;
  if (f.branches.size) {
    if (!Array.isArray(p.branches)) return false;
    let ok = false;
    for (const b of p.branches) if (f.branches.has(b)) { ok = true; break; }
    if (!ok) return false;
  }
  if (f.onlyRel) {
    const has = (p.parentIds && p.parentIds.length) ||
                (p.spouseIds && p.spouseIds.length) ||
                childrenOf(p.id).length > 0;
    if (!has) return false;
  }
  if (f.onlyDates) {
    if (!p.birthDateFull && !p.deathDateFull) return false;
  }
  if (f.todayAnniv) {
    const td = todayKey();
    if (dateDayMonth(p.birthDateFull) !== td && dateDayMonth(p.deathDateFull) !== td) return false;
  }
  if (f.query) {
    // Every word must appear somewhere, in any order: "Joan Civit", "Civit Joan", "Joan 1850"…
    if (!matchesTokens(searchHaystack(p), searchTokens(f.query))) return false;
  }
  return true;
}

function compareForSort(a, b) {
  switch (State.filter.sort) {
    case "firstName":
      return (a.firstName||"").localeCompare(b.firstName||"", "ca") || surnameKey(a).localeCompare(surnameKey(b), "ca");
    case "birthYear":
      return (a.birthYear || 99999) - (b.birthYear || 99999) || surnameKey(a).localeCompare(surnameKey(b), "ca");
    case "birthYearDesc":
      return (b.birthYear || -99999) - (a.birthYear || -99999) || surnameKey(a).localeCompare(surnameKey(b), "ca");
    default:
      return surnameKey(a).localeCompare(surnameKey(b), "ca");
  }
}

function renderPeopleList() {
  const list = $("#people-list");
  const filtered = State.people.filter(matchesFilter).sort(compareForSort);
  $("#total-count").textContent = State.people.length;
  $("#visible-count").textContent = filtered.length;
  if (!filtered.length) {
    list.innerHTML = `<div class="empty">Cap persona coincideix amb el filtre.</div>`;
    return;
  }
  const frag = document.createDocumentFragment();
  for (const p of filtered) {
    const card = document.createElement("article");
    card.className = "person-card";
    card.dataset.id = p.id;
    const names = `<div class="name">${escapeHtml(p.firstName || "(Sense nom)")}</div>`;
    const surnames = (p.surname1 || p.surname2)
      ? `<div class="surnames">${escapeHtml([p.surname1, p.surname2].filter(Boolean).join(" "))}</div>`
      : "";
    const evs = [];
    const bt = eventText(p.birthPlace, p.birthDateFull, p.birthYear);
    if (bt) evs.push(`<div class="ev"><span class="ev-ico" title="Naixement">★</span><span>${escapeHtml(bt)}</span></div>`);
    (p.marriages || []).forEach((m, i) => {
      const mt = eventText(m.place, m.dateFull, m.year);
      const sp = m.spouseId ? byId(m.spouseId) : null;
      if (!mt && !sp) return;
      const label = p.marriages.length > 1 ? `Boda ${i + 1}` : "Boda";
      evs.push(`<div class="ev"><span class="ev-ico" title="${label}">⚭</span><span>${escapeHtml(mt)}${sp ? `<span class="ev-with">${mt ? " · " : ""}amb ${escapeHtml(fullName(sp))}</span>` : ""}</span></div>`);
    });
    const dt = eventText(p.deathPlace, p.deathDateFull, p.deathYear);
    if (dt) evs.push(`<div class="ev"><span class="ev-ico" title="Defunció">†</span><span>${escapeHtml(dt)}</span></div>`);
    const dates = evs.length ? `<div class="events">${evs.join("")}</div>` : "";
    const tags = (p.branches||[]).map(k => `<span class="branch-tag ${k}">${branchShort(k)}</span>`).join("");
    const td = todayKey();
    const isAnniv = dateDayMonth(p.birthDateFull) === td || dateDayMonth(p.deathDateFull) === td;
    const annivBadge = isAnniv ? `<span class="anniv-badge" title="Aniversari avui">★</span>` : "";
    const badgesHtml = annivBadge ? `<div class="date-badges">${annivBadge}<span class="anniv-text">Aniversari avui</span></div>` : "";
    card.innerHTML = `${names}${surnames}${dates}${badgesHtml}${tags ? `<div class="branches">${tags}</div>` : ""}`;
    card.addEventListener("click", () => openDetail(p.id));
    frag.appendChild(card);
  }
  list.replaceChildren(frag);
}

/* ============== Detail panel ============== */

function openDetail(id) {
  const p = id ? byId(id) : null;
  State.editingId = id;
  $("#detail-title").textContent = p ? fullName(p) : "Nova persona";
  $("#f-id").value = p ? p.id : "";
  $("#f-firstName").value = p?.firstName || "";
  $("#f-surname1").value = p?.surname1 || "";
  $("#f-surname2").value = p?.surname2 || "";
  $("#f-birthPlace").value = p?.birthPlace || "";
  $("#f-birthYear").value = p?.birthYear || "";
  $("#f-birthDateFull").value = p?.birthDateFull || "";
  $("#f-deathPlace").value = p?.deathPlace || "";
  $("#f-deathYear").value = p?.deathYear || "";
  $("#f-deathDateFull").value = p?.deathDateFull || "";
  $("#f-notes").value = p?.notes || "";

  const br = $("#f-branches");
  br.innerHTML = "";
  const selected = new Set(p?.branches || []);
  for (const b of State.branches) {
    const c = document.createElement("span");
    c.className = `chip ${b.key}` + (selected.has(b.key) ? " active" : "");
    c.dataset.key = b.key;
    c.innerHTML = `<span class="dot" style="background:${b.color}"></span>${b.label}`;
    c.addEventListener("click", () => c.classList.toggle("active"));
    br.appendChild(c);
  }

  renderRelLists(p);
  renderMarriageForms(p);
  renderPhotoSlot($('[data-photo-slot="birth"]'), p ? `${p.id}:birth` : null);
  renderPhotoSlot($('[data-photo-slot="death"]'), p ? `${p.id}:death` : null);
  $("#btn-delete").style.display = p ? "" : "none";
  $("#btn-show-in-tree").style.display = p ? "" : "none";

  const panel = $("#detail-panel");
  panel.classList.remove("hidden");
  panel.setAttribute("aria-hidden", "false");
  panel.scrollTop = 0;
  setTimeout(() => $("#f-firstName").focus(), 50);
}

function closeDetail() {
  const panel = $("#detail-panel");
  panel.classList.add("hidden");
  panel.setAttribute("aria-hidden", "true");
  State.editingId = null;
}

function renderRelLists(p) {
  renderRelList("#f-father", p?.fatherId ? [p.fatherId] : [], "father");
  renderRelList("#f-mother", p?.motherId ? [p.motherId] : [], "mother");
  const kids = p ? childrenOf(p.id) : [];
  const childRoot = $("#f-children");
  childRoot.innerHTML = "";
  if (!kids.length) {
    childRoot.innerHTML = `<span style="color:var(--text-soft);font-size:12px">— cap fill registrat —</span>`;
    return;
  }
  for (const k of kids) {
    const item = document.createElement("span");
    item.className = "rel-item linkable";
    item.textContent = fullName(k) + (k.birthYear ? ` (${k.birthYear})` : "");
    item.addEventListener("click", () => { if (saveCurrent(true)) openDetail(k.id); });
    childRoot.appendChild(item);
  }
}

const REL_LABEL = { father: "el pare", mother: "la mare", spouse: "el cònjuge" };

function renderRelList(sel, ids, kind, onRemove) {
  const root = typeof sel === "string" ? $(sel) : sel;
  root.innerHTML = "";
  for (const id of ids) {
    const person = byId(id);
    if (!person) continue;
    const item = document.createElement("span");
    item.className = "rel-item linkable";
    item.innerHTML = `<span>${escapeHtml(fullName(person))}${person.birthYear ? " (" + person.birthYear + ")" : ""}</span>`;
    item.addEventListener("click", () => { if (saveCurrent(true)) openDetail(person.id); });
    const x = document.createElement("button");
    x.type = "button"; x.textContent = "×"; x.title = "Treure";
    x.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!confirm(`Vols treure ${fullName(person)} com a ${REL_LABEL[kind] || "relació"}?\n(La persona no s'esborra, només es desfà l'enllaç.)`)) return;
      if (onRemove) onRemove(id); else removeRel(kind, id);
    });
    item.appendChild(x);
    root.appendChild(item);
  }
  if (!ids.length) root.innerHTML = `<span class="rel-empty">—</span>`;
  root.dataset.kind = kind;
  root.dataset.ids = JSON.stringify(ids);
}

function readRelIds(sel) { return JSON.parse($(sel).dataset.ids || "[]"); }

function removeRel(kind, id) {
  const sel = kind === "father" ? "#f-father" : "#f-mother";
  renderRelList(sel, readRelIds(sel).filter(x => x !== id), kind);
}

function addRel(kind) {
  const sel = kind === "father" ? "#f-father" : "#f-mother";
  openPicker(kind === "father" ? "Triar pare" : "Triar mare", (chosen) => {
    if (State.editingId && chosen.id === State.editingId) { toast("No es pot enllaçar amb un mateix"); return; }
    renderRelList(sel, [chosen.id], kind);
  });
}

/* ---------- Marriages (Boda 1, Boda 2, …) ---------- */

function renderMarriageForms(p) {
  const root = $("#f-marriages");
  root.innerHTML = "";
  const list = (p?.marriages || []).map(m => ({ ...m }));
  while (list.length < 2) list.push({ id: newMarriageId(), spouseId: null, place: "", dateFull: null, year: null });
  list.forEach(m => appendMarriageForm(m, p));
}

function appendMarriageForm(m, p) {
  const root = $("#f-marriages");
  const fs = document.createElement("fieldset");
  fs.className = "marriage";
  fs.dataset.mid = m.id;
  fs.dataset.spouseId = m.spouseId || "";
  fs.innerHTML = `
    <legend><span class="m-title"></span> <button type="button" class="link-btn danger-link m-remove" title="Treure aquesta boda">treure</button></legend>
    <div class="rel-block">
      <div class="rel-label">Cònjuge</div>
      <div class="rel-list m-spouse"></div>
      <button type="button" class="link-btn m-pick">+ Triar cònjuge</button>
    </div>
    <div class="row two">
      <label>Lloc<input class="m-place" type="text" placeholder=" "></label>
      <label>Data (DD/MM/AAAA o AAAA)<input class="m-date" type="text" placeholder="p.ex. 03/02/1875"></label>
    </div>
    <div class="photo-slot"></div>`;
  fs.querySelector(".m-place").value = m.place || "";
  fs.querySelector(".m-date").value = flexibleDateText(m.dateFull, m.year);
  const drawSpouse = () => renderRelList(fs.querySelector(".m-spouse"), fs.dataset.spouseId ? [fs.dataset.spouseId] : [], "spouse",
    () => { fs.dataset.spouseId = ""; drawSpouse(); });
  drawSpouse();
  fs.querySelector(".m-pick").addEventListener("click", () => {
    openPicker("Triar cònjuge", (chosen) => {
      if (State.editingId && chosen.id === State.editingId) { toast("No es pot enllaçar amb un mateix"); return; }
      fs.dataset.spouseId = chosen.id;
      drawSpouse();
    });
  });
  fs.querySelector(".m-remove").addEventListener("click", () => {
    const filled = fs.dataset.spouseId || fs.querySelector(".m-place").value.trim() || fs.querySelector(".m-date").value.trim() || fs.dataset.hasPhoto;
    if (filled && !confirm("Vols treure aquesta boda? Es perdran les dades de la boda en desar.")) return;
    fs.remove();
    numberMarriageForms();
  });
  renderPhotoSlot(fs.querySelector(".photo-slot"), p ? `marriage:${m.id}` : null);
  root.appendChild(fs);
  numberMarriageForms();
}

function numberMarriageForms() {
  $$("#f-marriages .marriage").forEach((fs, i) => { fs.querySelector(".m-title").textContent = `Boda ${i + 1}`; });
}

function readMarriagesFromForm() {
  const out = [];
  for (const fs of $$("#f-marriages .marriage")) {
    const place = fs.querySelector(".m-place").value.trim();
    const dt = parseFlexibleDate(fs.querySelector(".m-date").value);
    if (!dt) return { error: "Format de data de boda no vàlid (cal DD/MM/AAAA o AAAA)" };
    const spouseId = fs.dataset.spouseId || null;
    if (!spouseId && !place && !dt.year && !fs.dataset.hasPhoto) continue;
    out.push({ id: fs.dataset.mid, spouseId, place, dateFull: dt.dateFull, year: dt.year });
  }
  return { marriages: out };
}

/* ============== Picker ============== */

function openPicker(title, onPick) {
  State.picker.active = true;
  State.picker.onPick = onPick;
  $("#picker-title").textContent = title;
  $("#picker-search").value = "";
  renderPickerResults("");
  $("#picker-overlay").classList.remove("hidden");
  setTimeout(() => $("#picker-search").focus(), 30);
}

function closePicker() {
  State.picker.active = false;
  State.picker.onPick = null;
  $("#picker-overlay").classList.add("hidden");
}

function renderPickerResults(q) {
  const root = $("#picker-results");
  const tokens = searchTokens(q);
  const filtered = State.people
    .filter(p => {
      if (State.editingId && p.id === State.editingId) return false;
      if (!tokens.length) return true;
      return matchesTokens(nameHaystack(p), tokens);
    })
    .sort(compareForSort)
    .slice(0, 80);
  root.innerHTML = "";
  if (!filtered.length) { root.innerHTML = `<div class="empty">Sense resultats</div>`; return; }
  for (const p of filtered) {
    const row = document.createElement("div");
    row.className = "picker-result";
    row.innerHTML = `<span>${escapeHtml(fullName(p))}</span><span class="meta">${escapeHtml(lifeSpan(p))}</span>`;
    row.addEventListener("click", () => {
      if (State.picker.onPick) State.picker.onPick(p);
      closePicker();
    });
    root.appendChild(row);
  }
}

/* ============== Save / Delete ============== */

function saveCurrent(silent = false) {
  const id = $("#f-id").value || null;
  const birthDateFull = normalizeDateInput($("#f-birthDateFull").value);
  const deathDateFull = normalizeDateInput($("#f-deathDateFull").value);
  const birthDateParsed = parseDDMMYYYY(birthDateFull);
  const deathDateParsed = parseDDMMYYYY(deathDateFull);
  const fatherId = readRelIds("#f-father")[0] || null;
  const motherId = readRelIds("#f-mother")[0] || null;
  const mres = readMarriagesFromForm();
  if (mres.error) { if (!silent) toast(mres.error); return false; }
  const data = {
    firstName: $("#f-firstName").value.trim(),
    surname1: $("#f-surname1").value.trim(),
    surname2: $("#f-surname2").value.trim(),
    birthPlace: $("#f-birthPlace").value.trim(),
    birthDateFull: birthDateFull || null,
    birthYear: birthDateParsed ? birthDateParsed.y : intOrNull($("#f-birthYear").value),
    deathPlace: $("#f-deathPlace").value.trim(),
    deathDateFull: deathDateFull || null,
    deathYear: deathDateParsed ? deathDateParsed.y : intOrNull($("#f-deathYear").value),
    notes: $("#f-notes").value.trim(),
    branches: $$("#f-branches .chip.active").map(c => c.dataset.key),
    fatherId,
    motherId,
    parentIds: [fatherId, motherId].filter(Boolean),
    marriages: mres.marriages,
  };
  if (($("#f-birthDateFull").value || "").trim() && !birthDateFull) {
    if (!silent) toast("Format de data de naixement no vàlid (cal DD/MM/AAAA)");
    return false;
  }
  if (($("#f-deathDateFull").value || "").trim() && !deathDateFull) {
    if (!silent) toast("Format de data de defunció no vàlid (cal DD/MM/AAAA)");
    return false;
  }
  if (!data.firstName && !data.surname1 && !data.surname2) {
    if (!silent) toast("Cal almenys un nom o cognom");
    return false;
  }
  let person;
  if (id) {
    person = byId(id);
    const prev = person.marriages || [];
    Object.assign(person, data);
    syncMarriages(person, prev);
  } else {
    person = { id: nextId(), ...data };
    State.people.push(person);
    syncMarriages(person, []);
    State.editingId = person.id;
    $("#f-id").value = person.id;
  }
  persist();
  renderPeopleList();
  if (State.view === "tree") renderTree();
  if (!silent) { toast("Desat"); closeDetail(); }
  return true;
}

/* A marriage is stored on both spouses with the same id, so its data and
   photo stay the same whichever of the two is edited. */
function syncMarriages(person, prev) {
  for (const m of prev) {
    if (!m.spouseId) continue;
    if (person.marriages.some(x => x.id === m.id && x.spouseId === m.spouseId)) continue;
    const sp = byId(m.spouseId);
    if (sp) { sp.marriages = (sp.marriages || []).filter(x => x.id !== m.id); sp.spouseIds = spouseIdsOf(sp); }
  }
  for (const m of person.marriages) {
    const sp = m.spouseId ? byId(m.spouseId) : null;
    if (!sp) continue;
    sp.marriages = sp.marriages || [];
    const mirror = { id: m.id, spouseId: person.id, place: m.place, dateFull: m.dateFull, year: m.year };
    const i = sp.marriages.findIndex(x => x.id === m.id || x.spouseId === person.id);
    if (i >= 0) sp.marriages[i] = mirror; else sp.marriages.push(mirror);
    sp.spouseIds = spouseIdsOf(sp);
  }
  person.spouseIds = spouseIdsOf(person);
  // Drop photos of marriages that nobody references any more.
  const live = new Set(State.people.flatMap(q => (q.marriages || []).map(x => x.id)));
  for (const m of prev) if (!live.has(m.id)) PhotoDB.del(`marriage:${m.id}`).catch(() => {});
}

function deleteCurrent() {
  const id = State.editingId;
  if (!id) { closeDetail(); return; }
  const p = byId(id);
  if (!p) { closeDetail(); return; }
  const kids = childrenOf(id).length;
  const links = [
    kids ? `${kids} fill(s) perdran aquest pare/mare` : "",
    p.spouseIds && p.spouseIds.length ? `${p.spouseIds.length} cònjuge(s) quedaran sense aquest enllaç` : "",
  ].filter(Boolean).join("\n· ");
  if (!confirm(`Segur que vols ELIMINAR "${fullName(p)}"?\n\n${links ? "· " + links + "\n· " : "· "}També s'esborraran les seves fotos de naixement i defunció.\n\nAquesta acció no es pot desfer.`)) return;
  State.people = State.people.filter(x => x.id !== id);
  for (const x of State.people) {
    if (x.fatherId === id) x.fatherId = null;
    if (x.motherId === id) x.motherId = null;
    if (Array.isArray(x.parentIds)) x.parentIds = x.parentIds.filter(i => i !== id);
    // The spouse keeps the marriage data (place, date, photo), just without the link.
    for (const m of x.marriages || []) if (m.spouseId === id) m.spouseId = null;
    x.spouseIds = spouseIdsOf(x);
  }
  PhotoDB.del(`${id}:birth`).catch(() => {});
  PhotoDB.del(`${id}:death`).catch(() => {});
  for (const m of p.marriages || []) if (!m.spouseId || !byId(m.spouseId)) PhotoDB.del(`marriage:${m.id}`).catch(() => {});
  persist();
  closeDetail();
  renderPeopleList();
  if (State.view === "tree") renderTree();
  toast("Eliminat");
}

function intOrNull(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

/* ============== Tree view ============== */

const NODE_W = 160, NODE_H = 56, COUPLE_GAP = 76, SIB_GAP = 22, GEN_GAP = 92;

function renderTree() {
  const empty = !State.tree.focusId || !byId(State.tree.focusId);
  $("#tree-canvas").classList.toggle("empty", empty);
  if (empty) {
    $("#tree-current").textContent = "— cap persona seleccionada —";
    $("#tree-svg").innerHTML = "";
    return;
  }
  const root = byId(State.tree.focusId);
  $("#tree-current").textContent = fullName(root);
  hideTreeCard();

  // Build layout in two halves: ancestors above (rows 0..-up), descendants below (1..down).
  const layout = layoutTree(root, State.tree.gensUp, State.tree.gensDown);
  drawTree(layout);
}

/**
 * Layout returns:
 *   nodes:   [{id, x, y, person, role}]   role: focus | ancestor | descendant | spouse | added
 *   links:   [{from:{x,y}, to:{x,y}, kind: 'parent'|'spouse'}]
 *   bbox:    {minX, maxX, minY, maxY}
 */
function layoutTree(root, gensUp, gensDown) {
  const nodes = [];
  const links = [];

  // ---------- Ancestors (top): inverted binary-ish tree per parents.
  //   level 0 is the focus row (also home of spouses + siblings later for descendants)
  //   levels -1, -2, ... are parents, grandparents.
  //   We place ancestors with a recursive "subtree width" measure.
  function ancWidth(personId, level) {
    if (level === 0) return NODE_W + 20;
    const p = byId(personId);
    if (!p || !p.parentIds || !p.parentIds.length) return NODE_W + 20;
    let w = 0;
    for (const pid of p.parentIds.slice(0, 2)) w += ancWidth(pid, level + 1);
    return Math.max(w, NODE_W + 20);
  }
  function placeAncestors(personId, level, centerX) {
    // Place this person's parents above (level - 1)
    const p = byId(personId);
    if (!p || level <= -gensUp) return;
    const parents = (p.parentIds || []).slice(0, 2).map(byId).filter(Boolean);
    if (!parents.length) return;
    const y = (level - 1) * GEN_GAP;
    if (parents.length === 1) {
      const x = centerX;
      const node = { id: parents[0].id, x, y, person: parents[0], role: "ancestor" };
      nodes.push(node);
      links.push({ from: { x: centerX, y: y + NODE_H + 4 }, to: { x: centerX, y: level * GEN_GAP - 4 }, kind: "parent-bus" });
      placeAncestors(parents[0].id, level - 1, x);
    } else {
      // Two parents side by side. Recursively their subtrees set our spacing.
      const wL = ancWidth(parents[0].id, level - 1);
      const wR = ancWidth(parents[1].id, level - 1);
      const span = Math.max(wL + wR, (NODE_W + COUPLE_GAP) * 2);
      const xL = centerX - span / 4;
      const xR = centerX + span / 4;
      const nL = { id: parents[0].id, x: xL, y, person: parents[0], role: "ancestor" };
      const nR = { id: parents[1].id, x: xR, y, person: parents[1], role: "ancestor" };
      nodes.push(nL, nR);
      // Spouse link between parents
      links.push({
        from: { x: xL + NODE_W / 2, y: y + NODE_H / 2 },
        to:   { x: xR - NODE_W / 2, y: y + NODE_H / 2 },
        kind: "spouse",
        marriage: marriageBetween(parents[0], parents[1]),
      });
      // Drop-down bus to the centerX child
      const busY = y + NODE_H + 12;
      links.push({ from: { x: xL, y: y + NODE_H / 2 }, to: { x: xL, y: busY }, kind: "parent-bus" });
      links.push({ from: { x: xR, y: y + NODE_H / 2 }, to: { x: xR, y: busY }, kind: "parent-bus" });
      links.push({ from: { x: xL, y: busY }, to: { x: xR, y: busY }, kind: "parent-bus" });
      links.push({ from: { x: centerX, y: busY }, to: { x: centerX, y: level * GEN_GAP - 4 }, kind: "parent-bus" });
      placeAncestors(parents[0].id, level - 1, xL);
      placeAncestors(parents[1].id, level - 1, xR);
    }
  }

  // ---------- Focus + spouses (at level 0)
  const focusX = 0;
  const focusY = 0;
  const focusNode = { id: root.id, x: focusX, y: focusY, person: root, role: "focus" };
  nodes.push(focusNode);

  const spouses = (root.spouseIds || []).map(byId).filter(Boolean);
  // Place spouses to the right of focus
  spouses.forEach((sp, i) => {
    const x = focusX + (i + 1) * (NODE_W + COUPLE_GAP);
    const n = { id: sp.id, x, y: focusY, person: sp, role: "spouse" };
    nodes.push(n);
    links.push({
      from: { x: focusX + NODE_W / 2, y: focusY + NODE_H / 2 },
      to:   { x: x - NODE_W / 2,       y: focusY + NODE_H / 2 },
      kind: "spouse",
      marriage: marriageBetween(root, sp),
    });
  });

  placeAncestors(root.id, 0, focusX);

  // ---------- Descendants
  // We collect descendants via BFS up to gensDown.
  // For each (root + each spouse) treat as one "couple unit" for children.
  function descWidth(personId, level) {
    if (level > gensDown) return NODE_W + 16;
    const kids = childrenOf(personId);
    if (!kids.length) return NODE_W + 16;
    let w = 0;
    for (const k of kids) {
      // Include spouse width too
      const spouseW = (k.spouseIds || []).length * (NODE_W + COUPLE_GAP);
      const cw = Math.max(descWidth(k.id, level + 1), NODE_W + 16) + spouseW;
      w += cw + SIB_GAP;
    }
    return Math.max(w - SIB_GAP, NODE_W + 16);
  }

  function placeDescendants(parentIds, level, centerX, parentNodes) {
    if (level > gensDown) return;
    // Children of any of the parents (union).
    const seen = new Set();
    const kids = [];
    for (const pid of parentIds) {
      for (const c of childrenOf(pid)) {
        if (seen.has(c.id)) continue;
        seen.add(c.id);
        kids.push(c);
      }
    }
    if (!kids.length) return;
    const y = level * GEN_GAP;

    // Estimate widths
    const widths = kids.map(k => {
      const spouseW = (k.spouseIds || []).length * (NODE_W + COUPLE_GAP);
      return Math.max(descWidth(k.id, level + 1), NODE_W + 16) + spouseW;
    });
    const totalW = widths.reduce((a,b) => a + b, 0) + (kids.length - 1) * SIB_GAP;
    let x = centerX - totalW / 2;

    // Bus from parents
    const busY = y - GEN_GAP / 2 + 8;
    if (parentNodes && parentNodes.length) {
      const pMidX = parentNodes.reduce((a, n) => a + n.x, 0) / parentNodes.length;
      links.push({ from: { x: pMidX, y: parentNodes[0].y + NODE_H / 2 }, to: { x: pMidX, y: busY }, kind: "parent-bus" });
    }

    const childCenters = [];
    for (let i = 0; i < kids.length; i++) {
      const k = kids[i];
      const w = widths[i];
      const cx = x + w / 2;
      const childNode = { id: k.id, x: cx - ((k.spouseIds||[]).length * (NODE_W + COUPLE_GAP)) / 2, y, person: k, role: "descendant" };
      // Position the child to the LEFT of any inline spouses
      const spouseCount = (k.spouseIds || []).length;
      childNode.x = cx - (spouseCount * (NODE_W + COUPLE_GAP)) / 2;
      nodes.push(childNode);
      childCenters.push({ x: childNode.x, node: childNode });

      // Spouses inline
      const childSpouses = (k.spouseIds || []).map(byId).filter(Boolean);
      childSpouses.forEach((sp, idx) => {
        const sx = childNode.x + (idx + 1) * (NODE_W + COUPLE_GAP);
        const sn = { id: sp.id, x: sx, y, person: sp, role: "spouse" };
        nodes.push(sn);
        links.push({
          from: { x: childNode.x + NODE_W / 2, y: y + NODE_H / 2 },
          to:   { x: sx - NODE_W / 2, y: y + NODE_H / 2 },
          kind: "spouse",
          marriage: marriageBetween(k, sp),
        });
      });

      // Link from bus to child
      links.push({ from: { x: childNode.x, y: busY }, to: { x: childNode.x, y: y - 4 }, kind: "parent-bus" });

      // Recurse
      const coupleIds = [k.id, ...(k.spouseIds || [])];
      placeDescendants(coupleIds, level + 1, childNode.x, [childNode]);

      x += w + SIB_GAP;
    }

    // Horizontal bus connecting all child verticals
    if (childCenters.length > 1) {
      const minX = childCenters[0].x;
      const maxX = childCenters[childCenters.length - 1].x;
      links.push({ from: { x: minX, y: busY }, to: { x: maxX, y: busY }, kind: "parent-bus" });
    }
  }

  const coupleIds = [root.id, ...(root.spouseIds || [])];
  placeDescendants(coupleIds, 1, focusX, [focusNode]);

  // Compute bbox
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const n of nodes) {
    minX = Math.min(minX, n.x - NODE_W / 2 - 10);
    maxX = Math.max(maxX, n.x + NODE_W / 2 + 10);
    minY = Math.min(minY, n.y - 10);
    maxY = Math.max(maxY, n.y + NODE_H + 10);
  }
  if (!isFinite(minX)) { minX = -200; maxX = 200; minY = -100; maxY = 100; }

  return { nodes, links, bbox: { minX, maxX, minY, maxY } };
}

function drawTree(layout) {
  const svg = $("#tree-svg");
  svg.innerHTML = "";

  // Compute viewBox to fit
  const pad = 40;
  const { minX, maxX, minY, maxY } = layout.bbox;
  const w = maxX - minX + pad * 2;
  const h = maxY - minY + pad * 2;
  svg.setAttribute("viewBox", `${minX - pad} ${minY - pad} ${w} ${h}`);
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");

  // Group with transform for pan/zoom
  const g = document.createElementNS(SVG_NS, "g");
  g.setAttribute("transform", `translate(${State.tree.pan.x},${State.tree.pan.y}) scale(${State.tree.scale})`);
  svg.appendChild(g);

  // Defs (arrow markers if needed)
  // Links first
  for (const link of layout.links) {
    const path = document.createElementNS(SVG_NS, "path");
    const d = `M ${link.from.x} ${link.from.y} L ${link.to.x} ${link.to.y}`;
    path.setAttribute("d", d);
    path.setAttribute("class", "tree-link " + (link.kind === "spouse" ? "spouse" : ""));
    g.appendChild(path);
  }
  // Marriage data on the spouse lines: date above, place below.
  for (const link of layout.links) {
    if (link.kind !== "spouse" || !link.marriage) continue;
    const m = link.marriage;
    const date = formatLifeDate(m.dateFull, m.year);
    if (!date && !m.place) continue;
    const gap = Math.min(COUPLE_GAP, link.to.x - link.from.x);
    const cx = link.to.x - gap / 2;
    const cy = link.from.y;
    const title = document.createElementNS(SVG_NS, "title");
    title.textContent = "Boda: " + eventText(m.place, m.dateFull, m.year);
    const lg = document.createElementNS(SVG_NS, "g");
    lg.setAttribute("class", "marriage-label");
    lg.appendChild(title);
    const t1 = document.createElementNS(SVG_NS, "text");
    t1.setAttribute("x", cx); t1.setAttribute("y", cy - 6);
    t1.setAttribute("text-anchor", "middle");
    t1.textContent = "⚭ " + truncate(date || "", 12);
    lg.appendChild(t1);
    if (m.place) {
      const t2 = document.createElementNS(SVG_NS, "text");
      t2.setAttribute("x", cx); t2.setAttribute("y", cy + 13);
      t2.setAttribute("text-anchor", "middle");
      t2.textContent = truncate(m.place, 13);
      lg.appendChild(t2);
    }
    g.appendChild(lg);
  }
  // Nodes
  for (const node of layout.nodes) {
    const ng = document.createElementNS(SVG_NS, "g");
    ng.setAttribute("class", `tree-node ${node.role === "focus" ? "focus" : ""}`);
    ng.setAttribute("transform", `translate(${node.x - NODE_W/2}, ${node.y})`);
    ng.dataset.id = node.id;
    // A single click only selects the card and shows its data; the tree is
    // re-centred from the card's button, so nothing "disappears" by accident.
    ng.addEventListener("click", (e) => {
      e.stopPropagation();
      showTreeCard(node.id);
    });
    ng.addEventListener("dblclick", () => openDetail(node.id));

    const rect = document.createElementNS(SVG_NS, "rect");
    rect.setAttribute("width", NODE_W);
    rect.setAttribute("height", NODE_H);
    ng.appendChild(rect);

    // Branch stripe at top
    const branches = node.person.branches || [];
    if (branches.length) {
      const colors = branches.slice(0, 4).map(k => (State.branches.find(b => b.key === k) || {}).color || "#999");
      const sw = NODE_W / colors.length;
      colors.forEach((c, i) => {
        const stripe = document.createElementNS(SVG_NS, "rect");
        stripe.setAttribute("x", i * sw);
        stripe.setAttribute("y", 0);
        stripe.setAttribute("width", sw);
        stripe.setAttribute("height", 4);
        stripe.setAttribute("class", "branch-stripe");
        stripe.setAttribute("fill", c);
        ng.appendChild(stripe);
      });
    }

    const name = document.createElementNS(SVG_NS, "text");
    name.setAttribute("class", "name");
    name.setAttribute("x", NODE_W / 2);
    name.setAttribute("y", 20);
    name.setAttribute("text-anchor", "middle");
    name.textContent = truncate(node.person.firstName || "", 22);
    ng.appendChild(name);

    const sn = [node.person.surname1, node.person.surname2].filter(Boolean).join(" ");
    if (sn) {
      const sub = document.createElementNS(SVG_NS, "text");
      sub.setAttribute("class", "surname");
      sub.setAttribute("x", NODE_W / 2);
      sub.setAttribute("y", 34);
      sub.setAttribute("text-anchor", "middle");
      sub.textContent = truncate(sn, 26);
      ng.appendChild(sub);
    }

    const ls = lifeSpan(node.person);
    if (ls) {
      const t = document.createElementNS(SVG_NS, "text");
      t.setAttribute("class", "lifespan");
      t.setAttribute("x", NODE_W / 2);
      t.setAttribute("y", 48);
      t.setAttribute("text-anchor", "middle");
      t.textContent = ls;
      ng.appendChild(t);
    }

    g.appendChild(ng);
  }
}

function showTreeCard(id) {
  const p = byId(id);
  const card = $("#tree-card");
  $$("#tree-svg .tree-node.selected").forEach(n => n.classList.remove("selected"));
  if (!p) { card.classList.add("hidden"); return; }
  const el = $(`#tree-svg .tree-node[data-id="${id}"]`);
  if (el) el.classList.add("selected");
  const rows = [];
  const bt = eventText(p.birthPlace, p.birthDateFull, p.birthYear);
  if (bt) rows.push(`<div class="ev"><span class="ev-ico">★</span><span>${escapeHtml(bt)}</span></div>`);
  (p.marriages || []).forEach((m, i) => {
    const sp = m.spouseId ? byId(m.spouseId) : null;
    const mt = eventText(m.place, m.dateFull, m.year);
    if (!mt && !sp) return;
    rows.push(`<div class="ev"><span class="ev-ico" title="Boda ${i + 1}">⚭</span><span>${escapeHtml(mt || "Boda")}${sp ? `<span class="ev-with"> · amb ${escapeHtml(fullName(sp))}</span>` : ""}</span></div>`);
  });
  const dt = eventText(p.deathPlace, p.deathDateFull, p.deathYear);
  if (dt) rows.push(`<div class="ev"><span class="ev-ico">†</span><span>${escapeHtml(dt)}</span></div>`);
  const isFocus = State.tree.focusId === id;
  card.innerHTML = `
    <button type="button" class="tree-card-close" aria-label="Tancar">×</button>
    <div class="tree-card-name">${escapeHtml(fullName(p))}</div>
    <div class="events">${rows.join("") || '<div class="ev muted">Sense dates registrades</div>'}</div>
    <div class="tree-card-actions">
      ${isFocus ? "" : '<button type="button" class="primary" data-act="center">Centrar l\'arbre aquí</button>'}
      <button type="button" data-act="edit">Obrir fitxa</button>
    </div>`;
  card.querySelector(".tree-card-close").addEventListener("click", hideTreeCard);
  const c = card.querySelector('[data-act="center"]');
  if (c) c.addEventListener("click", () => {
    State.tree.focusId = id;
    State.tree.pan = { x: 0, y: 0 };
    hideTreeCard();
    renderTree();
  });
  card.querySelector('[data-act="edit"]').addEventListener("click", () => openDetail(id));
  card.classList.remove("hidden");
}
function hideTreeCard() {
  $("#tree-card").classList.add("hidden");
  $$("#tree-svg .tree-node.selected").forEach(n => n.classList.remove("selected"));
}

function truncate(s, n) { s = String(s||""); return s.length > n ? s.slice(0, n - 1) + "…" : s; }

/* Tree pan/zoom */
function wireTreeInteraction() {
  const canvas = $("#tree-canvas");
  const svg = $("#tree-svg");
  let isDown = false; let startX = 0, startY = 0; let pStart = { x: 0, y: 0 };
  canvas.addEventListener("click", (e) => {
    if (!e.target.closest(".tree-node") && !e.target.closest("#tree-card") && !moved) hideTreeCard();
  });
  let moved = false;
  canvas.addEventListener("mousedown", (e) => {
    if (e.target.closest(".tree-node") || e.target.closest("#tree-card")) return;
    moved = false;
    isDown = true; canvas.classList.add("dragging");
    startX = e.clientX; startY = e.clientY;
    pStart = { ...State.tree.pan };
  });
  window.addEventListener("mousemove", (e) => {
    if (!isDown) return;
    if (Math.abs(e.clientX - startX) + Math.abs(e.clientY - startY) > 3) moved = true;
    State.tree.pan.x = pStart.x + (e.clientX - startX);
    State.tree.pan.y = pStart.y + (e.clientY - startY);
    applyTreeTransform();
  });
  window.addEventListener("mouseup", () => { isDown = false; canvas.classList.remove("dragging"); });

  canvas.addEventListener("wheel", (e) => {
    if (State.view !== "tree") return;
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.1 : 0.9;
    State.tree.scale = Math.min(3, Math.max(0.3, State.tree.scale * factor));
    applyTreeTransform();
  }, { passive: false });

  // Touch pan
  let lastTouch = null;
  canvas.addEventListener("touchstart", (e) => {
    if (e.touches.length === 1) lastTouch = { x: e.touches[0].clientX, y: e.touches[0].clientY, pan: { ...State.tree.pan } };
  });
  canvas.addEventListener("touchmove", (e) => {
    if (e.touches.length === 1 && lastTouch) {
      State.tree.pan.x = lastTouch.pan.x + (e.touches[0].clientX - lastTouch.x);
      State.tree.pan.y = lastTouch.pan.y + (e.touches[0].clientY - lastTouch.y);
      applyTreeTransform();
      e.preventDefault();
    }
  }, { passive: false });
  canvas.addEventListener("touchend", () => { lastTouch = null; });
}

function applyTreeTransform() {
  const g = $("#tree-svg g");
  if (g) g.setAttribute("transform", `translate(${State.tree.pan.x},${State.tree.pan.y}) scale(${State.tree.scale})`);
}

/* ============== Map view ============== */

function ensureMap() {
  if (State.map.instance) {
    setTimeout(() => State.map.instance.invalidateSize(), 50);
    return;
  }
  const map = L.map("map-canvas", { worldCopyJump: true }).setView([41.45, 1.5], 7);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 18,
    attribution: "© OpenStreetMap",
  }).addTo(map);
  State.map.instance = map;
  State.map.cluster = L.markerClusterGroup({ maxClusterRadius: 45 });
  map.addLayer(State.map.cluster);

  // Populate branch select
  const sel = $("#map-branch");
  for (const b of State.branches) {
    const opt = document.createElement("option");
    opt.value = b.key; opt.textContent = b.label;
    sel.appendChild(opt);
  }
  sel.addEventListener("change", (e) => { State.map.branch = e.target.value; drawMap(); });
  $("#map-kind").addEventListener("change", (e) => { State.map.kind = e.target.value; drawMap(); });

  drawMap();
}

function drawMap() {
  if (!State.map.instance) return;
  State.map.cluster.clearLayers();

  // Build a place->people map.
  const places = {}; // place key -> { lat, lng, label, people: [{id, kind}] }
  for (const p of State.people) {
    if (State.map.branch && !(p.branches || []).includes(State.map.branch)) continue;
    const kinds = [];
    if (State.map.kind !== "death" && p.birthPlace) kinds.push({ key: placeKey(p.birthPlace), kind: "birth", raw: p.birthPlace });
    if (State.map.kind !== "birth" && p.deathPlace) kinds.push({ key: placeKey(p.deathPlace), kind: "death", raw: p.deathPlace });
    for (const k of kinds) {
      if (!k.key) continue;
      const coord = State.places[k.key];
      if (!coord) continue;
      const bucket = (places[k.key] ||= { lat: coord.lat, lng: coord.lng, label: coord.label || k.raw, people: [] });
      bucket.people.push({ id: p.id, kind: k.kind });
    }
  }

  let total = 0;
  for (const k in places) {
    const b = places[k];
    total += b.people.length;
    const marker = L.marker([b.lat, b.lng]);
    marker.bindPopup(() => buildPopup(b));
    State.map.cluster.addLayer(marker);
  }
  $("#map-stats").textContent = `${Object.keys(places).length} llocs · ${total} esdeveniments`;
}

function buildPopup(bucket) {
  const div = document.createElement("div");
  div.innerHTML = `<h4>${escapeHtml(bucket.label)}</h4>
    <div style="color:var(--text-soft);font-size:12px">${bucket.people.length} esdeveniments</div>
    <div class="popup-people"></div>`;
  const list = div.querySelector(".popup-people");
  // Group: show unique persons
  const seen = new Map();
  for (const item of bucket.people) {
    const p = byId(item.id);
    if (!p) continue;
    if (!seen.has(p.id)) seen.set(p.id, new Set());
    seen.get(p.id).add(item.kind);
  }
  for (const [id, kinds] of seen) {
    const p = byId(id);
    const row = document.createElement("div");
    row.className = "popup-person";
    const ks = [];
    if (kinds.has("birth")) ks.push("naixement");
    if (kinds.has("death")) ks.push("defunció");
    row.innerHTML = `${escapeHtml(fullName(p))} <span style="color:var(--text-soft);font-size:11px">${escapeHtml(ks.join(", "))}</span>`;
    row.addEventListener("click", () => openDetail(p.id));
    list.appendChild(row);
  }
  return div;
}

/* ============== Import / Export ============== */

async function exportJson() {
  let photos = {};
  try { photos = await PhotoDB.all(); } catch (e) { console.warn(e); }
  const blob = new Blob([JSON.stringify({
    people: State.people, branches: State.branches, places: State.places, photos,
  }, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const today = new Date().toISOString().slice(0, 10);
  a.href = url; a.download = `arbre-genealogic-${today}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
  const n = Object.keys(photos).length;
  toast(n ? `Exportat (amb ${n} fotos)` : "Exportat");
}

function importJson(file) {
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const parsed = JSON.parse(reader.result);
      if (!parsed || !Array.isArray(parsed.people)) throw new Error("Format invàlid");
      const photos = parsed.photos && typeof parsed.photos === "object" ? Object.entries(parsed.photos) : [];
      if (!confirm(`Importar ${parsed.people.length} persones${photos.length ? ` i ${photos.length} fotos` : ""}? Es substituirà les dades actuals.`)) return;
      State.people = parsed.people;
      if (Array.isArray(parsed.branches)) State.branches = parsed.branches;
      if (parsed.places && typeof parsed.places === "object") State.places = parsed.places;
      migratePeople();
      for (const [k, v] of photos) {
        if (typeof v === "string" && v.startsWith("data:image/")) await PhotoDB.put(k, v);
      }
      persist();
      renderAll();
      if (State.view === "tree") renderTree();
      if (State.view === "map") drawMap();
      toast(`Importades ${parsed.people.length} persones`);
    } catch (e) {
      alert("No s'ha pogut importar: " + e.message);
    }
  };
  reader.readAsText(file);
}

/* ---------- CSV (human-editable) ---------- */
// Columns: id, nom, cognom1, cognom2, naixement_lloc, naixement_data,
//          boda1_conjuge, boda1_lloc, boda1_data, boda2_conjuge, boda2_lloc,
//          boda2_data, defuncio_lloc, defuncio_data, branques, pare_id,
//          mare_id, conjuges, notes
// - Separator auto-detected (comma or semicolon).
// - Multi-value cells use the pipe '|' (e.g. "civit|vives").
// - Dates: "DD/MM/AAAA" or just "AAAA". Empty = unknown.
// - IDs are free text slugs; references must match another row's id.

const CSV_HEADER = ["id","nom","cognom1","cognom2","naixement_lloc","naixement_data",
  "boda1_conjuge","boda1_lloc","boda1_data","boda2_conjuge","boda2_lloc","boda2_data",
  "defuncio_lloc","defuncio_data","branques","pare_id","mare_id","conjuges","notes"];
const CSV_REQUIRED = ["id","nom","cognom1","cognom2","naixement_data"];

function csvEscape(v) {
  const s = String(v ?? "");
  return /[,;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function csvParse(text) {
  text = text.replace(/^﻿/, "");
  const head = text.split(/\r?\n/, 1)[0] || "";
  const sep = (head.match(/;/g) || []).length > (head.match(/,/g) || []).length ? ";" : ",";
  const rows = [];
  let cur = [""];
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"' && text[i+1] === '"') { cur[cur.length-1] += '"'; i++; }
      else if (c === '"') inQ = false;
      else cur[cur.length-1] += c;
    } else {
      if (c === '"' && cur[cur.length-1] === "") inQ = true;
      else if (c === sep) cur.push("");
      else if (c === "\n") { rows.push(cur); cur = [""]; }
      else if (c === "\r") {}
      else cur[cur.length-1] += c;
    }
  }
  if (cur.length > 1 || cur[0] !== "") rows.push(cur);
  return rows;
}

function slugify(s) {
  return fold(s).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function makeReadableId(p, used) {
  const parts = [p.surname1, p.surname2, p.firstName, p.birthYear].filter(Boolean);
  let base = slugify(parts.join(" ")) || "persona";
  let id = base, n = 1;
  while (used.has(id)) id = `${base}-${++n}`;
  used.add(id);
  return id;
}

function exportCsv() {
  const used = new Set();
  const idMap = new Map();
  for (const p of State.people) idMap.set(p.id, makeReadableId(p, used));
  const lines = [CSV_HEADER.join(",")];
  for (const p of State.people) {
    const fId = p.fatherId, mId = p.motherId;
    const bodes = [0, 1].flatMap(i => {
      const m = (p.marriages || [])[i];
      if (!m) return ["", "", ""];
      return [m.spouseId ? (idMap.get(m.spouseId) || "") : "", m.place || "", flexibleDateText(m.dateFull, m.year)];
    });
    const row = [
      idMap.get(p.id),
      p.firstName || "",
      p.surname1 || "",
      p.surname2 || "",
      p.birthPlace || "",
      p.birthDateFull || (p.birthYear != null ? String(p.birthYear) : ""),
      ...bodes,
      p.deathPlace || "",
      p.deathDateFull || (p.deathYear != null ? String(p.deathYear) : ""),
      (p.branches || []).join("|"),
      fId ? (idMap.get(fId) || "") : "",
      mId ? (idMap.get(mId) || "") : "",
      (p.spouseIds || []).map(id => idMap.get(id) || "").filter(Boolean).join("|"),
      p.notes || "",
    ];
    lines.push(row.map(csvEscape).join(","));
  }
  const blob = new Blob(["﻿" + lines.join("\n") + "\n"], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const today = new Date().toISOString().slice(0, 10);
  a.href = url; a.download = `arbre-genealogic-${today}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
  toast("CSV exportat");
}

function downloadCsvTemplate() {
  const sample = [
    CSV_HEADER.join(","),
    "joan-civit-1850,Joan,Civit,Vives,Cornudella,12/03/1850,anna-marti-1855,Reus,03/02/1875,,,,Reus,05/11/1920,civit|ld,pere-civit-1820,maria-vives-1825,anna-marti-1855,Exemple — esborra aquesta fila",
    "pere-civit-1820,Pere,Civit,,Cornudella,1820,maria-vives-1825,Cornudella,1845,,,,,,civit,,,maria-vives-1825,",
    "maria-vives-1825,Maria,Vives,,Reus,1825,pere-civit-1820,Cornudella,1845,,,,,,vives,,,pere-civit-1820,",
    "anna-marti-1855,Anna,Martí,,Reus,1855,joan-civit-1850,Reus,03/02/1875,,,,,,,,,joan-civit-1850,",
  ].join("\n");
  const blob = new Blob(["﻿" + sample + "\n"], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = "plantilla-genealogia.csv";
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
  toast("Plantilla descarregada");
}

function importCsv(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const rows = csvParse(reader.result).filter(r => r.some(c => c.trim() !== ""));
      if (!rows.length) throw new Error("CSV buit");
      const header = rows[0].map(h => h.trim().toLowerCase());
      const colIdx = Object.fromEntries(CSV_HEADER.map(k => [k, header.indexOf(k)]));
      const missing = CSV_REQUIRED.filter(k => colIdx[k] === -1);
      if (missing.length) throw new Error(`Falten columnes obligatòries: ${missing.join(", ")}`);

      const validBranches = new Set(State.branches.map(b => b.key));
      const peopleByCsvId = new Map();
      const people = [];
      const warnings = [];

      for (let r = 1; r < rows.length; r++) {
        const row = rows[r];
        const get = k => colIdx[k] >= 0 ? (row[colIdx[k]] || "").trim() : "";
        const rawId = get("id");
        if (!rawId && !get("nom") && !get("cognom1") && !get("cognom2")) continue;
        const id = rawId || `row-${r}`;
        if (peopleByCsvId.has(id)) { warnings.push(`Fila ${r+1}: id duplicat "${id}"`); continue; }
        const birthDate = get("naixement_data");
        const deathDate = get("defuncio_data");
        const birthY = /^\d{4}$/.test(birthDate) ? parseInt(birthDate, 10) : (parseDDMMYYYY(birthDate)?.y ?? null);
        const deathY = /^\d{4}$/.test(deathDate) ? parseInt(deathDate, 10) : (parseDDMMYYYY(deathDate)?.y ?? null);
        const branches = get("branques").split("|").map(s => s.trim()).filter(Boolean);
        for (const b of branches) if (!validBranches.has(b)) warnings.push(`Fila ${r+1}: branca desconeguda "${b}"`);
        const p = {
          id,
          firstName: get("nom"),
          surname1: get("cognom1"),
          surname2: get("cognom2"),
          birthDateFull: /^\d{2}\/\d{2}\/\d{4}$/.test(birthDate) ? birthDate : null,
          birthYear: birthY,
          birthPlace: get("naixement_lloc"),
          deathDateFull: /^\d{2}\/\d{2}\/\d{4}$/.test(deathDate) ? deathDate : null,
          deathYear: deathY,
          deathPlace: get("defuncio_lloc"),
          branches,
          notes: get("notes"),
          _pareId: get("pare_id"),
          _mareId: get("mare_id"),
          _conjuges: get("conjuges").split("|").map(s => s.trim()).filter(Boolean),
          _bodes: [1, 2].map(k => ({ spouse: get(`boda${k}_conjuge`), place: get(`boda${k}_lloc`), date: get(`boda${k}_data`), row: r + 1 })),
          fatherId: null,
          motherId: null,
          parentIds: [],
          spouseIds: [],
          marriages: [],
        };
        peopleByCsvId.set(id, p);
        people.push(p);
      }

      let brokenRefs = 0;
      for (const p of people) {
        if (p._pareId) {
          if (peopleByCsvId.has(p._pareId)) { p.fatherId = p._pareId; p.parentIds.push(p._pareId); }
          else { brokenRefs++; warnings.push(`"${p.id}": pare_id "${p._pareId}" no existeix`); }
        }
        if (p._mareId) {
          if (peopleByCsvId.has(p._mareId)) { p.motherId = p._mareId; p.parentIds.push(p._mareId); }
          else { brokenRefs++; warnings.push(`"${p.id}": mare_id "${p._mareId}" no existeix`); }
        }
        for (const b of p._bodes) {
          if (!b.spouse && !b.place && !b.date) continue;
          let spouseId = b.spouse || null;
          if (spouseId && !peopleByCsvId.has(spouseId)) {
            brokenRefs++; warnings.push(`"${p.id}": cònjuge de boda "${spouseId}" no existeix`); spouseId = null;
          }
          let dt = parseFlexibleDate(b.date);
          if (!dt) { warnings.push(`Fila ${b.row}: data de boda "${b.date}" no vàlida`); dt = { dateFull: null, year: null }; }
          p.marriages.push({ id: spouseId ? coupleMarriageId(p.id, spouseId) : newMarriageId(), spouseId, place: b.place, dateFull: dt.dateFull, year: dt.year });
        }
        for (const c of p._conjuges) {
          if (!peopleByCsvId.has(c)) { brokenRefs++; warnings.push(`"${p.id}": cònjuge "${c}" no existeix`); continue; }
          if (!p.marriages.some(m => m.spouseId === c)) p.marriages.push({ id: coupleMarriageId(p.id, c), spouseId: c, place: "", dateFull: null, year: null });
        }
        delete p._pareId; delete p._mareId; delete p._conjuges; delete p._bodes;
      }
      // Mirror every marriage on the other spouse (same id), filling gaps from whichever row has data.
      for (const p of people) {
        for (const m of p.marriages) {
          if (!m.spouseId) continue;
          const sp = peopleByCsvId.get(m.spouseId);
          const other = sp.marriages.find(x => x.spouseId === p.id);
          if (!other) { sp.marriages.push({ ...m, spouseId: p.id }); continue; }
          const place = m.place || other.place;
          const dateFull = m.dateFull || other.dateFull;
          const year = m.year ?? other.year;
          Object.assign(m, { place, dateFull, year });
          Object.assign(other, { id: m.id, place, dateFull, year });
        }
      }
      for (const p of people) p.spouseIds = spouseIdsOf(p);

      const summary = [
        `Importar ${people.length} persones?`,
        brokenRefs ? `${brokenRefs} referències invàlides (s'ignoraran).` : `Totes les referències són correctes.`,
        warnings.length > 8 ? warnings.slice(0, 8).join("\n") + `\n…i ${warnings.length-8} avisos més (consola).` : warnings.join("\n"),
        ``,
        `ATENCIÓ: això substituirà totes les dades actuals.`,
      ].filter(Boolean).join("\n\n");
      if (warnings.length) console.warn("Avisos d'import CSV:\n" + warnings.join("\n"));
      if (!confirm(summary)) return;

      State.people = people;
      // Recompute branch counts and places from imported data if needed (existing app will do this naturally on render).
      persist();
      renderAll();
      if (State.view === "tree") renderTree();
      if (State.view === "map") drawMap();
      toast(`Importades ${people.length} persones`);
    } catch (e) {
      alert("No s'ha pogut importar el CSV: " + e.message);
      console.error(e);
    }
  };
  reader.readAsText(file);
}

/* ============== Wiring ============== */

function renderAll() {
  renderBranchChips();
  renderPeopleList();
}

function wireEvents() {
  $("#search").addEventListener("input", (e) => { State.filter.query = e.target.value; renderPeopleList(); });
  $("#sort").addEventListener("change", (e) => { State.filter.sort = e.target.value; renderPeopleList(); });
  $("#only-rel").addEventListener("change", (e) => { State.filter.onlyRel = e.target.checked; renderPeopleList(); });
  $("#only-dates").addEventListener("change", (e) => { State.filter.onlyDates = e.target.checked; renderPeopleList(); });
  $("#today-anniv").addEventListener("change", (e) => { State.filter.todayAnniv = e.target.checked; renderPeopleList(); });

  $("#btn-add").addEventListener("click", () => openDetail(null));
  $("#btn-close-detail").addEventListener("click", () => closeDetail());
  $("#btn-cancel").addEventListener("click", () => closeDetail());
  $("#detail-form").addEventListener("submit", (e) => { e.preventDefault(); saveCurrent(false); });
  $("#btn-delete").addEventListener("click", deleteCurrent);
  $("#btn-show-in-tree").addEventListener("click", () => {
    if (!State.editingId) return;
    const id = State.editingId;
    closeDetail();
    State.tree.focusId = id;
    State.tree.pan = { x: 0, y: 0 };
    State.tree.scale = 1;
    switchView("tree");
  });

  $$("[data-add]").forEach(b => b.addEventListener("click", () => addRel(b.dataset.add)));
  $("#btn-add-marriage").addEventListener("click", () => {
    appendMarriageForm({ id: newMarriageId(), spouseId: null, place: "", dateFull: null, year: null }, State.editingId ? byId(State.editingId) : null);
  });
  $("#photo-close").addEventListener("click", closePhotoViewer);
  $("#photo-overlay").addEventListener("click", (e) => { if (e.target.id === "photo-overlay") closePhotoViewer(); });

  $("#picker-close").addEventListener("click", closePicker);
  $("#picker-overlay").addEventListener("click", (e) => { if (e.target.id === "picker-overlay") closePicker(); });
  $("#picker-search").addEventListener("input", (e) => renderPickerResults(e.target.value));

  $("#btn-export").addEventListener("click", exportJson);
  $("#btn-import").addEventListener("click", () => $("#file-import").click());
  $("#file-import").addEventListener("change", (e) => {
    if (e.target.files && e.target.files[0]) importJson(e.target.files[0]);
    e.target.value = "";
  });
  $("#btn-export-csv").addEventListener("click", exportCsv);
  $("#btn-import-csv").addEventListener("click", () => $("#file-import-csv").click());
  $("#file-import-csv").addEventListener("change", (e) => {
    if (e.target.files && e.target.files[0]) importCsv(e.target.files[0]);
    e.target.value = "";
  });
  $("#btn-csv-template").addEventListener("click", downloadCsvTemplate);
  $("#btn-reset").addEventListener("click", resetData);

  $$(".view-tabs .tab").forEach(t => t.addEventListener("click", () => switchView(t.dataset.view)));

  $("#tree-pick").addEventListener("click", () => {
    openPicker("Centrar l'arbre en…", (p) => {
      State.tree.focusId = p.id;
      State.tree.pan = { x: 0, y: 0 };
      State.tree.scale = 1;
      renderTree();
    });
  });
  $("#tree-gens-up").addEventListener("change", (e) => { State.tree.gensUp = parseInt(e.target.value, 10); renderTree(); });
  $("#tree-gens-down").addEventListener("change", (e) => { State.tree.gensDown = parseInt(e.target.value, 10); renderTree(); });
  $("#tree-fit").addEventListener("click", () => { State.tree.pan = { x: 0, y: 0 }; State.tree.scale = 1; renderTree(); });
  $("#tree-reset").addEventListener("click", () => { State.tree.scale = 1; applyTreeTransform(); });

  wireTreeInteraction();

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (!$("#photo-overlay").classList.contains("hidden")) closePhotoViewer();
      else if (State.picker.active) closePicker();
      else if (!$("#detail-panel").classList.contains("hidden")) closeDetail();
    }
  });
}

/* ============== Init ============== */

document.addEventListener("DOMContentLoaded", () => {
  load();
  wireEvents();
  renderAll();
  // Set a default tree focus: pick someone with relations.
  const focus = State.people.find(p => (p.parentIds && p.parentIds.length) && (childrenOf(p.id).length));
  if (focus) State.tree.focusId = focus.id;
  persist();
});
