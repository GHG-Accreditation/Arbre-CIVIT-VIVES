"use strict";

const STORAGE_KEY = "genealogyApp.v1";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const State = {
  people: [],
  branches: [],
  filter: { query: "", branches: new Set(), onlyRel: false, sort: "surname" },
  editingId: null,
  picker: { active: false, mode: null, onPick: null },
};

function safeStorage() {
  try {
    const t = "__t__";
    window.localStorage.setItem(t, t);
    window.localStorage.removeItem(t);
    return window.localStorage;
  } catch (_) {
    return null;
  }
}

function load() {
  const ls = safeStorage();
  const raw = ls ? ls.getItem(STORAGE_KEY) : null;
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.people) && Array.isArray(parsed.branches)) {
        State.people = parsed.people;
        State.branches = parsed.branches;
        return;
      }
    } catch (e) { console.warn("Bad stored data, falling back to preloaded.", e); }
  }
  const src = window.__PRELOADED_DATA__;
  State.people = src.people.map(p => ({ ...p }));
  State.branches = src.branches.slice();
}

function persist() {
  const ls = safeStorage();
  if (!ls) return;
  try {
    ls.setItem(STORAGE_KEY, JSON.stringify({
      people: State.people,
      branches: State.branches,
    }));
  } catch (e) {
    console.warn("Could not persist data:", e);
  }
}

function resetData() {
  if (!confirm("Tornar a les dades originals descartarà els canvis locals. Continuar?")) return;
  const ls = safeStorage();
  if (ls) ls.removeItem(STORAGE_KEY);
  load();
  renderAll();
  toast("Dades reiniciades");
}

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
  if (!p.birthYear && !p.deathYear) return "";
  return `${p.birthYear || "?"} – ${p.deathYear || ""}`.replace(/–\s*$/, "– …");
}

function childrenOf(id) {
  return State.people.filter(p => Array.isArray(p.parentIds) && p.parentIds.includes(id));
}

/* ============== Rendering ============== */

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
    const has = (Array.isArray(p.parentIds) && p.parentIds.length) ||
                (Array.isArray(p.spouseIds) && p.spouseIds.length) ||
                childrenOf(p.id).length > 0;
    if (!has) return false;
  }
  if (f.query) {
    const q = f.query.toLowerCase();
    const hay = `${p.firstName} ${p.surname1} ${p.surname2} ${p.birthPlace||""} ${p.deathPlace||""} ${p.birthYear||""} ${p.deathYear||""}`.toLowerCase();
    if (!hay.includes(q)) return false;
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
    case "surname":
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

  // Render incrementally via DocumentFragment to keep it fast on 1k+ items.
  const frag = document.createDocumentFragment();
  for (const p of filtered) {
    const card = document.createElement("article");
    card.className = "person-card";
    card.dataset.id = p.id;
    const names = `<div class="name">${escapeHtml(p.firstName || "(Sense nom)")}</div>`;
    const surnames = (p.surname1 || p.surname2)
      ? `<div class="surnames">${escapeHtml([p.surname1, p.surname2].filter(Boolean).join(" "))}</div>`
      : "";
    const span = lifeSpan(p);
    const places = [p.birthPlace, p.deathPlace].filter(Boolean).join(" → ");
    const dates = (span || places) ? `<div class="dates">${escapeHtml(span)}${span && places ? " · " : ""}${escapeHtml(places)}</div>` : "";
    const tags = (p.branches||[]).map(k => `<span class="branch-tag ${k}">${branchShort(k)}</span>`).join("");
    card.innerHTML = `${names}${surnames}${dates}${tags ? `<div class="branches">${tags}</div>` : ""}`;
    card.addEventListener("click", () => openDetail(p.id));
    frag.appendChild(card);
  }
  list.replaceChildren(frag);
}

function branchShort(key) {
  const b = State.branches.find(x => x.key === key);
  if (!b) return key;
  const m = /\b([A-Za-zÀ-ú]+)$/.exec(b.label);
  return m ? m[1] : b.label;
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
}

function renderAll() {
  renderBranchChips();
  renderPeopleList();
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
  $("#f-deathPlace").value = p?.deathPlace || "";
  $("#f-deathYear").value = p?.deathYear || "";
  $("#f-notes").value = p?.notes || "";

  // Branches editor
  const br = $("#f-branches");
  br.innerHTML = "";
  const selected = new Set(p?.branches || []);
  for (const b of State.branches) {
    const c = document.createElement("span");
    c.className = `chip ${b.key}` + (selected.has(b.key) ? " active" : "");
    c.dataset.key = b.key;
    c.innerHTML = `<span class="dot" style="background:${b.color}"></span>${b.label}`;
    c.addEventListener("click", () => {
      c.classList.toggle("active");
    });
    br.appendChild(c);
  }

  renderRelLists(p);
  $("#btn-delete").style.display = p ? "" : "none";

  const panel = $("#detail-panel");
  panel.classList.remove("hidden");
  panel.setAttribute("aria-hidden", "false");
  setTimeout(() => $("#f-firstName").focus(), 50);
}

function closeDetail() {
  const panel = $("#detail-panel");
  panel.classList.add("hidden");
  panel.setAttribute("aria-hidden", "true");
  State.editingId = null;
}

function renderRelLists(p) {
  renderRelList("#f-parents", (p?.parentIds || []), "parents");
  renderRelList("#f-spouses", (p?.spouseIds || []), "spouses");
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
    item.addEventListener("click", () => { saveCurrent(true); openDetail(k.id); });
    childRoot.appendChild(item);
  }
}

function renderRelList(sel, ids, kind) {
  const root = $(sel);
  root.innerHTML = "";
  for (const id of ids) {
    const person = byId(id);
    if (!person) continue;
    const item = document.createElement("span");
    item.className = "rel-item linkable";
    item.innerHTML = `<span>${escapeHtml(fullName(person))}${person.birthYear ? " (" + person.birthYear + ")" : ""}</span>`;
    item.addEventListener("click", () => { saveCurrent(true); openDetail(person.id); });
    const x = document.createElement("button");
    x.type = "button"; x.textContent = "×"; x.title = "Treure";
    x.addEventListener("click", (e) => {
      e.stopPropagation();
      removeRel(kind, id);
    });
    item.appendChild(x);
    root.appendChild(item);
  }
  root.dataset.kind = kind;
  root.dataset.ids = JSON.stringify(ids);
}

function readRelIds(sel) {
  const root = $(sel);
  return JSON.parse(root.dataset.ids || "[]");
}

function removeRel(kind, id) {
  const sel = kind === "parents" ? "#f-parents" : "#f-spouses";
  const ids = readRelIds(sel).filter(x => x !== id);
  $(sel).dataset.ids = JSON.stringify(ids);
  renderRelList(sel, ids, kind);
}

function addRel(kind) {
  const max = kind === "parents" ? 2 : Infinity;
  const sel = kind === "parents" ? "#f-parents" : "#f-spouses";
  const existing = readRelIds(sel);
  if (existing.length >= max) { toast("Màxim 2 pares"); return; }
  openPicker(kind === "parents" ? "Triar pare/mare" : "Triar cònjuge", (chosen) => {
    if (existing.includes(chosen.id)) return;
    if (State.editingId && chosen.id === State.editingId) { toast("No es pot enllaçar amb un mateix"); return; }
    const next = [...existing, chosen.id];
    $(sel).dataset.ids = JSON.stringify(next);
    renderRelList(sel, next, kind);
  });
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
  const query = q.trim().toLowerCase();
  const filtered = State.people
    .filter(p => {
      if (State.editingId && p.id === State.editingId) return false;
      if (!query) return true;
      return `${p.firstName} ${p.surname1} ${p.surname2}`.toLowerCase().includes(query);
    })
    .sort(compareForSort)
    .slice(0, 80);
  root.innerHTML = "";
  if (!filtered.length) {
    root.innerHTML = `<div class="empty">Sense resultats</div>`;
    return;
  }
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

/* ============== Form save/delete ============== */

function saveCurrent(silent = false) {
  const id = $("#f-id").value || null;
  const data = {
    firstName: $("#f-firstName").value.trim(),
    surname1: $("#f-surname1").value.trim(),
    surname2: $("#f-surname2").value.trim(),
    birthPlace: $("#f-birthPlace").value.trim(),
    birthYear: intOrNull($("#f-birthYear").value),
    deathPlace: $("#f-deathPlace").value.trim(),
    deathYear: intOrNull($("#f-deathYear").value),
    notes: $("#f-notes").value.trim(),
    branches: $$("#f-branches .chip.active").map(c => c.dataset.key),
    parentIds: readRelIds("#f-parents"),
    spouseIds: readRelIds("#f-spouses"),
  };
  if (!data.firstName && !data.surname1 && !data.surname2) {
    if (!silent) toast("Cal almenys un nom o cognom");
    return false;
  }
  if (id) {
    const p = byId(id);
    Object.assign(p, data);
    // Keep spouse symmetry
    syncSpouses(p);
  } else {
    const newP = { id: nextId(), ...data };
    State.people.push(newP);
    syncSpouses(newP);
    State.editingId = newP.id;
    $("#f-id").value = newP.id;
  }
  persist();
  renderPeopleList();
  if (!silent) {
    toast("Desat");
    closeDetail();
  }
  return true;
}

function syncSpouses(person) {
  // Ensure each spouse links back; remove broken back-links handled lazily on save of others.
  for (const sid of person.spouseIds || []) {
    const sp = byId(sid);
    if (!sp) continue;
    sp.spouseIds = sp.spouseIds || [];
    if (!sp.spouseIds.includes(person.id)) sp.spouseIds.push(person.id);
  }
}

function deleteCurrent() {
  const id = State.editingId;
  if (!id) { closeDetail(); return; }
  const p = byId(id);
  if (!p) { closeDetail(); return; }
  if (!confirm(`Eliminar "${fullName(p)}"? Aquesta acció no es pot desfer.`)) return;
  // Unlink from others
  State.people = State.people.filter(x => x.id !== id);
  for (const x of State.people) {
    if (Array.isArray(x.parentIds)) x.parentIds = x.parentIds.filter(i => i !== id);
    if (Array.isArray(x.spouseIds)) x.spouseIds = x.spouseIds.filter(i => i !== id);
  }
  persist();
  closeDetail();
  renderPeopleList();
  toast("Eliminat");
}

function intOrNull(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

/* ============== Import / Export ============== */

function exportJson() {
  const blob = new Blob([JSON.stringify({ people: State.people, branches: State.branches }, null, 2)],
    { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const today = new Date().toISOString().slice(0, 10);
  a.href = url; a.download = `arbre-genealogic-${today}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
  toast("Exportat");
}

function importJson(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = JSON.parse(reader.result);
      if (!parsed || !Array.isArray(parsed.people)) throw new Error("Format invàlid");
      if (!confirm(`Importar ${parsed.people.length} persones? Es substituirà les dades actuals.`)) return;
      State.people = parsed.people;
      if (Array.isArray(parsed.branches)) State.branches = parsed.branches;
      persist();
      renderAll();
      toast(`Importades ${parsed.people.length} persones`);
    } catch (e) {
      alert("No s'ha pogut importar: " + e.message);
    }
  };
  reader.readAsText(file);
}

/* ============== Toast ============== */

let toastTimer = null;
function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), 1600);
}

/* ============== Wiring ============== */

function wireEvents() {
  $("#search").addEventListener("input", (e) => {
    State.filter.query = e.target.value;
    renderPeopleList();
  });
  $("#sort").addEventListener("change", (e) => {
    State.filter.sort = e.target.value;
    renderPeopleList();
  });
  $("#only-rel").addEventListener("change", (e) => {
    State.filter.onlyRel = e.target.checked;
    renderPeopleList();
  });

  $("#btn-add").addEventListener("click", () => openDetail(null));
  $("#btn-close-detail").addEventListener("click", () => closeDetail());
  $("#btn-cancel").addEventListener("click", () => closeDetail());
  $("#detail-form").addEventListener("submit", (e) => { e.preventDefault(); saveCurrent(false); });
  $("#btn-delete").addEventListener("click", deleteCurrent);

  $$("[data-add]").forEach(b => b.addEventListener("click", () => addRel(b.dataset.add)));

  $("#picker-close").addEventListener("click", closePicker);
  $("#picker-overlay").addEventListener("click", (e) => { if (e.target.id === "picker-overlay") closePicker(); });
  $("#picker-search").addEventListener("input", (e) => renderPickerResults(e.target.value));

  $("#btn-export").addEventListener("click", exportJson);
  $("#btn-import").addEventListener("click", () => $("#file-import").click());
  $("#file-import").addEventListener("change", (e) => {
    if (e.target.files && e.target.files[0]) importJson(e.target.files[0]);
    e.target.value = "";
  });
  $("#btn-reset").addEventListener("click", resetData);

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (State.picker.active) closePicker();
      else if (!$("#detail-panel").classList.contains("hidden")) closeDetail();
    }
  });
}

/* ============== Init ============== */

document.addEventListener("DOMContentLoaded", () => {
  load();
  wireEvents();
  renderAll();
});
