"use strict";

const STORAGE_KEY = "genealogyApp.v2";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const SVG_NS = "http://www.w3.org/2000/svg";

const State = {
  people: [],
  branches: [],
  places: {},
  filter: { query: "", branches: new Set(), onlyRel: false, sort: "surname" },
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
        return;
      }
    } catch (e) { console.warn("Bad stored data", e); }
  }
  const src = window.__PRELOADED_DATA__;
  State.people = src.people.map(p => ({ ...p }));
  State.branches = src.branches.slice();
  State.places = src.places || {};
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
  if (!p.birthYear && !p.deathYear) return "";
  return `${p.birthYear || "?"} – ${p.deathYear || ""}`.replace(/–\s*$/, "– …");
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
  $("#btn-delete").style.display = p ? "" : "none";
  $("#btn-show-in-tree").style.display = p ? "" : "none";

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
    x.addEventListener("click", (e) => { e.stopPropagation(); removeRel(kind, id); });
    item.appendChild(x);
    root.appendChild(item);
  }
  root.dataset.kind = kind;
  root.dataset.ids = JSON.stringify(ids);
}

function readRelIds(sel) { return JSON.parse($(sel).dataset.ids || "[]"); }

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
  if (State.view === "tree") renderTree();
  if (!silent) { toast("Desat"); closeDetail(); }
  return true;
}

function syncSpouses(person) {
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
  State.people = State.people.filter(x => x.id !== id);
  for (const x of State.people) {
    if (Array.isArray(x.parentIds)) x.parentIds = x.parentIds.filter(i => i !== id);
    if (Array.isArray(x.spouseIds)) x.spouseIds = x.spouseIds.filter(i => i !== id);
  }
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

const NODE_W = 160, NODE_H = 56, COUPLE_GAP = 18, SIB_GAP = 22, GEN_GAP = 92;

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
        kind: "spouse"
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
      kind: "spouse"
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
          kind: "spouse"
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
  // Nodes
  for (const node of layout.nodes) {
    const ng = document.createElementNS(SVG_NS, "g");
    ng.setAttribute("class", `tree-node ${node.role === "focus" ? "focus" : ""}`);
    ng.setAttribute("transform", `translate(${node.x - NODE_W/2}, ${node.y})`);
    ng.addEventListener("click", (e) => {
      e.stopPropagation();
      State.tree.focusId = node.id;
      State.tree.pan = { x: 0, y: 0 };
      renderTree();
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

function truncate(s, n) { s = String(s||""); return s.length > n ? s.slice(0, n - 1) + "…" : s; }

/* Tree pan/zoom */
function wireTreeInteraction() {
  const canvas = $("#tree-canvas");
  const svg = $("#tree-svg");
  let isDown = false; let startX = 0, startY = 0; let pStart = { x: 0, y: 0 };
  canvas.addEventListener("mousedown", (e) => {
    if (e.target.closest(".tree-node")) return;
    isDown = true; canvas.classList.add("dragging");
    startX = e.clientX; startY = e.clientY;
    pStart = { ...State.tree.pan };
  });
  window.addEventListener("mousemove", (e) => {
    if (!isDown) return;
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

function exportJson() {
  const blob = new Blob([JSON.stringify({
    people: State.people, branches: State.branches, places: State.places,
  }, null, 2)], { type: "application/json" });
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
      if (parsed.places && typeof parsed.places === "object") State.places = parsed.places;
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

/* ============== Wiring ============== */

function renderAll() {
  renderBranchChips();
  renderPeopleList();
}

function wireEvents() {
  $("#search").addEventListener("input", (e) => { State.filter.query = e.target.value; renderPeopleList(); });
  $("#sort").addEventListener("change", (e) => { State.filter.sort = e.target.value; renderPeopleList(); });
  $("#only-rel").addEventListener("change", (e) => { State.filter.onlyRel = e.target.checked; renderPeopleList(); });

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
  // Set a default tree focus: pick someone with relations.
  const focus = State.people.find(p => (p.parentIds && p.parentIds.length) && (childrenOf(p.id).length));
  if (focus) State.tree.focusId = focus.id;
});
