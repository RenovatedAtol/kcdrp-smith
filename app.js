"use strict";
// KCD Roleplay smithing -> trade pack calculator. Plain JS, no build step.

const PRICE_SOURCES = [
  // our own copy, refreshed every 30 minutes by .github/workflows/prices.yml
  { url: "https://raw.githubusercontent.com/RenovatedAtol/kcdrp-smith/prices/prices.json", kind: "own", label: "API сервера" },
  // fallback: DanekKuznec's hourly copy of the auction (no market prices in it)
  { url: "https://raw.githubusercontent.com/DanekKuznec/kcd2-rp-crafting/prices/auction.json", kind: "danek", label: "копия аукциона DanekKuznec" },
];
// pack prices of goods the auction has no "instant" figure for, read off the game's packing windows
// (2026-11-25). The API has no exact pack price: "instant" matches the smith's raw goods, not all goods.
const DEFAULT_PACK = { steel: 9.5, haft: 6, foundhorseshoe: 3, holynail: 4, brokenrod: 6, ghosthorseshoe: 38, leather: 6 };
// levels 9 and 10 are left out: every piece of theirs is worth several crates and would mostly burn
const MAX_LEVEL = 8;
const STORE = "kcdrp-smith-v1";
const DEFAULTS = {
  buySource: "avg", cap: 450, filler: "coal", ov: {}, excl: [], level: "all", search: "",
  onlyFit: false, hideNA: true, hideParts: false, sort: { key: "eff", dir: -1 }, cart: [],
};

let DATA = null;            // data/smithing.json
let SERVER = { market: {}, auction: {}, updated: null, label: "" };
let S = load();
let open = new Set();       // recipe ids with their breakdown open

function load() {
  try { return Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem(STORE) || "{}")); }
  catch { return Object.assign({}, DEFAULTS); }
}
function save() { localStorage.setItem(STORE, JSON.stringify(S)); }

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const num = (v) => (typeof v === "number" && isFinite(v) ? v : null);
function fmt(v, d = 1) {
  if (v == null || !isFinite(v)) return "—";
  const p = 10 ** d;
  return (Math.round(v * p) / p).toLocaleString("ru-RU");
}

// ---------------------------------------------------------------- prices
async function fetchPrices(bust) {
  const errors = [];
  for (const src of PRICE_SOURCES) {
    try {
      const r = await fetch(src.url + (bust ? `?t=${Date.now()}` : ""), { cache: "no-store" });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const d = await r.json();
      if (src.kind === "own") {
        SERVER = { market: d.market || {}, auction: d.auction || {}, updated: d.updated, label: src.label };
      } else {
        const auction = {};
        for (const a of (d.auction && d.auction.items) || []) {
          if (String(a.item).startsWith("good:")) auction[a.item.slice(5)] = a;
        }
        SERVER = { market: {}, auction, updated: d.updated, label: src.label };
      }
      return true;
    } catch (e) { errors.push(`${src.label}: ${e.message}`); }
  }
  throw new Error(errors.join("; "));
}

function showStatus(err) {
  const el = $("status");
  if (err) { el.className = "err"; el.textContent = "Не удалось загрузить цены (" + err + "). Считаю по вашим ценам."; return; }
  el.className = "";
  if (!SERVER.updated) { el.textContent = "Цены сервера не загружены"; return; }
  const t = new Date(SERVER.updated);
  const mins = Math.max(0, Math.round((Date.now() - t) / 60000));
  const ago = mins < 1 ? "только что" : mins < 60 ? `${mins} мин назад` : `${Math.floor(mins / 60)} ч ${mins % 60} мин назад`;
  el.textContent = `Цены от ${t.toLocaleString("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })} (${ago}) · ${SERVER.label}`;
}

// ---------------------------------------------------------------- model
const MAT = () => DATA.materials;
const ov = (k) => S.ov[k] || {};
function recipeOf(key) { return DATA.byName.get(key) || null; }

function serverAuction(id) {
  const a = SERVER.auction[id];
  if (!a) return null;
  const order = S.buySource === "low" ? ["low", "avg"] : ["avg", "low"];
  for (const f of order) if (num(a[f]) > 0) return a[f];
  return null;
}
function serverPack(id) {
  const a = SERVER.auction[id];
  if (a && num(a.instant) > 0) return a.instant;
  if (DEFAULT_PACK[id] != null) return DEFAULT_PACK[id];
  const m = SERVER.market[id];
  return m && num(m.price) > 0 ? m.price : null;
}
// the prices of a material: the user's number wins over the server's
function auctionPrice(key) {
  const m = MAT()[key], o = ov(key);
  if (num(o.buy) != null) return o.buy > 0 ? o.buy : null;
  return m.kind === "good" ? serverAuction(m.id) : null;
}
function packPrice(key) {
  const m = MAT()[key], o = ov(key);
  if (num(o.pack) != null) return o.pack;
  if (m.kind === "good") return serverPack(m.id);
  if (m.kind === "manual") return auctionPrice(key);   // unknown: assume it counts at what you paid
  return null;                                          // a craft's part: from its recipe
}

let memoCost, memoPack;
function resetMemo() { memoCost = new Map(); memoPack = new Map(); }

// cheapest way to get one unit of a material: {v, src}
function costOf(key, depth = 0) {
  if (memoCost.has(key)) return memoCost.get(key);
  if (depth > 12) return { v: null, src: null };
  let mode = ov(key).mode || "auto";
  if (mode === "realm") mode = "auto";   // crown prices are not used any more (older saved settings)
  const opts = [];
  const a = auctionPrice(key), rec = MAT()[key].recipe ? recipeOf(key) : null;
  if ((mode === "auto" || mode === "auction") && a != null) opts.push({ v: a, src: MAT()[key].kind === "good" ? "auction" : "price" });
  if ((mode === "auto" || mode === "craft") && rec) {
    const c = recipeCost(rec, depth + 1);
    if (c != null) opts.push({ v: c, src: "craft" });
  }
  const best = opts.length ? opts.reduce((x, y) => (y.v < x.v ? y : x)) : { v: null, src: null };
  memoCost.set(key, best);
  return best;
}
// what one unit counts for inside a crafted piece
function packOf(key, depth = 0) {
  if (memoPack.has(key)) return memoPack.get(key);
  let v = packPrice(key);
  if (v == null) {
    const rec = MAT()[key].recipe ? recipeOf(key) : null;
    v = rec && depth < 12 ? recipePack(rec, depth + 1) : null;
  }
  memoPack.set(key, v);
  return v;
}
function recipeCost(r, depth = 0) {
  let t = r.fee;
  for (const [k, q] of Object.entries(r.items)) {
    const c = costOf(k, depth).v;
    if (c == null) return null;
    t += q * c;
  }
  return t / r.yield;
}
function recipePack(r, depth = 0) {
  let t = r.fee;
  for (const [k, q] of Object.entries(r.items)) {
    const p = packOf(k, depth);
    if (p == null) return null;
    t += q * p;
  }
  return t / r.yield;
}
// every material a recipe ends up using, following the parts you make yourself
function usedBy(r, depth = 0, acc = new Set()) {
  for (const k of Object.keys(r.items)) {
    acc.add(k);
    const c = costOf(k);
    if (c.src === "craft" && depth < 12) usedBy(recipeOf(k), depth + 1, acc);
  }
  return acc;
}

function filler() {
  const key = S.filler;
  if (!key || !MAT()[key]) return null;
  const c = costOf(key);
  if (c.v == null) return null;
  const p = packOf(key);
  return p > 0 ? { key, cost: c.v, pack: p } : null;
}

function evaluate(r, fill) {
  const M = recipeCost(r), P = recipePack(r);
  const res = { r, M, P, eff: M && P != null ? P / M : null, loss: M != null && P != null ? M - P : null };
  if (M == null || P == null || P <= 0) { res.na = true; return res; }
  const cap = S.cap;
  if (P > cap + 1e-9) {
    Object.assign(res, { fits: false, k: 1, n: 0, burn: P - cap, crate: M - cap });
  } else {
    const k = Math.floor(cap / P + 1e-9);
    const rest = cap - k * P;
    let n = 0, cost = k * M, value = k * P;
    if (fill && rest > 1e-9) { n = Math.ceil(rest / fill.pack - 1e-9); cost += n * fill.cost; value += n * fill.pack; }
    Object.assign(res, { fits: true, k, n, crate: cost - Math.min(cap, value), unfilled: Math.max(0, cap - value) });
  }
  return res;
}

// ---------------------------------------------------------------- render
function effClass(e) { return e == null ? "" : e >= 0.95 ? "good" : e >= 0.85 ? "mid" : "bad"; }
function matsText(r) {
  const parts = Object.entries(r.items).map(([k, q]) => `${q} ${MAT()[k].ru.toLowerCase()}`);
  return parts.join(", ") + (r.fee ? ` + ${r.fee} гр.` : "");
}
function crateText(x) {
  if (x.na) return "—";
  if (!x.fits) return `1 шт. <span class="tag burn">сгорит ${fmt(x.burn, 0)}</span>`;
  const f = x.n ? ` + ${esc(MAT()[S.filler].ru.toLowerCase())} ×${x.n}` : "";
  const un = x.unfilled > 0.5 ? ` <span class="tag na">не добит на ${fmt(x.unfilled, 0)}</span>` : "";
  return `${x.k} шт.${f}${un}`;
}
// item pictures: game icons (data/icons), or the name's first letters where there is none
function iconHtml(src, label, cls = "ico") {
  if (src) return `<img class="${cls}" src="${esc(src)}" alt="" loading="lazy">`;
  const ini = String(label || "?").split(/[\s«»()-]+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
  return `<span class="${cls} none" aria-hidden="true">${esc(ini)}</span>`;
}
function matName(key, extra = "") {
  const m = MAT()[key] || { ru: key };
  return `<span class="mn">${iconHtml(m.icon, m.ru, "ico sm")}<span>${esc(m.ru)}${extra}</span></span>`;
}
function nameCell(r, extra = "") {
  const part = DATA.partNames.has(r.en) ? '<span class="tag part">материал</span>' : "";
  return `<div class="nm">${iconHtml(r.icon, r.ru || r.en)}<div>${esc(r.ru || r.en)}${part}${extra}<span class="en">${esc(r.en)}${r.yield > 1 ? ` · ×${r.yield}` : ""}</span></div></div>`;
}

const COLS = [
  { key: "level", t: "Ур.", n: true, v: (x) => x.r.level },
  { key: "name", t: "Предмет", v: (x) => (x.r.ru || x.r.en).toLowerCase() },
  { key: "mats", t: "Материалы", sortless: true },
  { key: "fee", t: "Станок", n: true, v: (x) => x.r.fee / x.r.yield },
  { key: "M", t: "Себестоимость", n: true, v: (x) => x.M },
  { key: "P", t: "В груз", n: true, v: (x) => x.P },
  { key: "eff", t: "КПД", n: true, v: (x) => x.eff },
  { key: "loss", t: "Потеря за шт.", n: true, v: (x) => x.loss },
  { key: "crateTxt", t: "В ящик", sortless: true },
  { key: "crate", t: "Потеря ящика", n: true, v: (x) => x.crate },
];

function render() {
  resetMemo();
  const fill = filler();
  const excl = new Set(S.excl);
  const all = DATA.recipes.filter((r) => !r.aux && r.level <= MAX_LEVEL).map((r) => evaluate(r, fill));
  for (const x of all) x.excluded = [...usedBy(x.r)].some((k) => excl.has(k));

  // best per level
  let bh = "<tr><th></th><th>Ур.</th><th>Предмет</th><th class='n'>Себестоимость</th><th class='n'>В груз</th><th class='n'>КПД</th><th class='n'>Потеря за шт.</th><th>Ящик</th><th class='n'>Потеря ящика</th></tr>";
  for (let L = 1; L <= MAX_LEVEL; L++) {
    const c = all.filter((x) => x.r.level === L && !x.na && x.fits && !x.excluded && !x.r.en.startsWith("jobtool"));
    if (!c.length) { bh += `<tr class="na"><td></td><td class="n">${L}</td><td colspan="7">ни один доступный предмет не помещается в ящик</td></tr>`; continue; }
    c.sort((a, b) => b.eff - a.eff || b.P - a.P);
    const x = c[0];
    bh += `<tr><td>${addBtn(x)}</td><td class="n">${L}</td><td>${nameCell(x.r)}</td><td class="n">${fmt(x.M)}</td><td class="n">${fmt(x.P)}</td><td class="n ${effClass(x.eff)}">${fmt(x.eff * 100)}%</td><td class="n">${fmt(x.loss)}</td><td>${crateText(x)}</td><td class="n">${fmt(x.crate)}</td></tr>`;
  }
  if (fill) {
    const nb = Math.ceil(S.cap / fill.pack - 1e-9);
    bh += `<tr><td></td><td></td><td colspan="7" class="src-tag">Для сравнения: ящик из одного товара «${esc(MAT()[fill.key].ru)}» — ${nb} шт., потеря ${fmt(nb * fill.cost - S.cap)} гр.</td></tr>`;
  }
  $("best").innerHTML = bh;

  // recipes table
  const q = S.search.trim().toLowerCase();
  let rows = all.filter((x) =>
    (S.level === "all" || x.r.level === +S.level) &&
    (!q || (x.r.ru || "").toLowerCase().includes(q) || x.r.en.toLowerCase().includes(q)) &&
    (!S.onlyFit || x.fits) && (!S.hideNA || !x.na) && !x.excluded &&
    (!S.hideParts || !DATA.partNames.has(x.r.en)));
  const col = COLS.find((c) => c.key === S.sort.key) || COLS[6];
  rows.sort((a, b) => {
    const va = col.v(a), vb = col.v(b);
    if (va == null && vb == null) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;
    return (va < vb ? -1 : va > vb ? 1 : 0) * S.sort.dir || a.r.level - b.r.level;
  });
  let h = "<tr><th></th>" + COLS.map((c) => `<th class="${c.n ? "n " : ""}${c.sortless ? "" : "sort"} ${S.sort.key === c.key ? (S.sort.dir > 0 ? "asc" : "desc") : ""}" data-k="${c.key}">${c.t}</th>`).join("") + "</tr>";
  for (const x of rows) {
    const na = x.na ? ' <span class="tag na">нет цены</span>' : "";
    h += `<tr class="r${x.na ? " na" : ""}" data-id="${esc(x.r.id)}">
      <td>${addBtn(x)}</td><td class="n">${x.r.level}</td><td>${nameCell(x.r, na)}</td><td class="mats">${esc(matsText(x.r))}</td>
      <td class="n">${fmt(x.r.fee / x.r.yield)}</td><td class="n">${fmt(x.M)}</td><td class="n">${fmt(x.P)}</td>
      <td class="n ${effClass(x.eff)}">${x.eff != null ? fmt(x.eff * 100) + "%" : "—"}</td><td class="n">${fmt(x.loss)}</td>
      <td>${crateText(x)}</td><td class="n">${fmt(x.crate)}</td></tr>`;
    if (open.has(x.r.id)) h += `<tr class="detail"><td></td><td></td><td colspan="${COLS.length - 1}">${breakdown(x.r)}</td></tr>`;
  }
  if (!rows.length) h += `<tr><td colspan="${COLS.length + 1}" class="src-tag">Нет рецептов под эти фильтры.</td></tr>`;
  $("recipes").innerHTML = h;

  $("excluded").innerHTML = S.excl.map((k) => `<span class="chip x" data-k="${esc(k)}">${esc(MAT()[k] ? MAT()[k].ru : k)}</span>`).join("");
  renderPrices();
  renderCart(fill);
}

const SRC = { auction: "аукцион", craft: "сделать", price: "ваша цена" };

function breakdown(r) {
  let h = `<table class="sub-table"><tr><th>Материал</th><th class="n">Кол-во</th><th>Откуда</th><th class="n">Цена за шт.</th><th class="n">Себестоимость</th><th class="n">В груз за шт.</th><th class="n">В груз</th></tr>`;
  for (const [k, q] of Object.entries(r.items)) {
    const c = costOf(k), p = packOf(k);
    h += `<tr><td>${matName(k)}</td><td class="n">${q}</td><td class="src-tag">${c.src ? SRC[c.src] : "нет цены"}</td>
      <td class="n">${fmt(c.v, 2)}</td><td class="n">${fmt(c.v != null ? c.v * q : null)}</td><td class="n">${fmt(p, 2)}</td><td class="n">${fmt(p != null ? p * q : null)}</td></tr>`;
  }
  h += `<tr><td>Плата станка</td><td></td><td></td><td></td><td class="n">${fmt(r.fee)}</td><td></td><td class="n">${fmt(r.fee)}</td></tr>`;
  if (r.yield > 1) h += `<tr><td colspan="7" class="src-tag">Выход ${r.yield} шт. — итог делится на ${r.yield}.</td></tr>`;
  return h + "</table>";
}

function priceInput(key, field, placeholder) {
  const v = ov(key)[field];
  return `<input type="number" step="0.1" min="0" data-k="${esc(key)}" data-f="${field}" value="${v != null ? v : ""}" placeholder="${placeholder != null ? fmt(placeholder, 2) : "—"}">`;
}
function modeSelect(key) {
  const m = MAT()[key], cur = ov(key).mode || "auto";
  const o = [["auto", "авто"]];
  if (m.kind !== "part") o.push(["auction", m.kind === "good" ? "аукцион" : "по цене"]);
  if (m.recipe) o.push(["craft", "сделать"]);
  if (m.kind === "part") o.push(["auction", "купить по цене"]);
  return `<select data-k="${esc(key)}" data-f="mode">${o.map(([v, t]) => `<option value="${v}"${v === cur ? " selected" : ""}>${t}</option>`).join("")}</select>`;
}
function exclBox(key) { return `<input type="checkbox" data-k="${esc(key)}" data-f="excl"${S.excl.includes(key) ? " checked" : ""}>`; }

function renderPrices() {
  const keys = Object.keys(MAT()).sort((a, b) => MAT()[a].ru.localeCompare(MAT()[b].ru, "ru"));
  const goods = keys.filter((k) => MAT()[k].kind === "good");
  const parts = keys.filter((k) => MAT()[k].kind === "part");
  const manual = keys.filter((k) => MAT()[k].kind === "manual");
  let g = `<tr><th>Товар</th><th class="n">Аукцион ср.</th><th class="n">Аукцион мин.</th><th class="n">Продано</th><th class="n">Покупка</th><th class="n">В груз</th><th>Способ</th><th class="n">Итого за шт.</th><th>искл.</th></tr>`;
  for (const k of goods) {
    const m = MAT()[k], a = SERVER.auction[m.id] || {}, c = costOf(k);
    g += `<tr><td>${matName(k)}</td><td class="n">${fmt(a.avg, 2)}</td><td class="n">${fmt(a.low, 2)}</td><td class="n">${a.sold != null ? fmt(a.sold, 0) : "—"}</td>
      <td class="n">${priceInput(k, "buy", serverAuction(m.id))}</td><td class="n">${priceInput(k, "pack", serverPack(m.id))}</td>
      <td>${modeSelect(k)}</td>
      <td class="n">${fmt(c.v, 2)} <span class="src-tag">${c.src ? SRC[c.src] : ""}</span></td><td>${exclBox(k)}</td></tr>`;
  }
  $("goods").innerHTML = g;
  let p = `<tr><th>Материал</th><th>Рецепт</th><th class="n">Сделать за шт.</th><th class="n">Купить за шт.</th><th class="n">В груз</th><th>Способ</th><th class="n">Итого за шт.</th><th>искл.</th></tr>`;
  for (const k of parts) {
    const r = recipeOf(k), c = costOf(k);
    const craft = r ? recipeCost(r) : null;
    p += `<tr><td>${matName(k)}</td><td class="mats">${r ? esc(matsText(r)) + (r.yield > 1 ? ` → ${r.yield} шт.` : "") : "—"}</td>
      <td class="n">${fmt(craft, 2)}</td><td class="n">${priceInput(k, "buy", null)}</td><td class="n">${priceInput(k, "pack", r ? recipePack(r) : null)}</td>
      <td>${modeSelect(k)}</td><td class="n">${fmt(c.v, 2)} <span class="src-tag">${c.src ? SRC[c.src] : ""}</span></td><td>${exclBox(k)}</td></tr>`;
  }
  $("parts").innerHTML = p;
  let mh = `<tr><th>Материал</th><th class="n">Покупка</th><th class="n">В груз</th><th class="n">Итого за шт.</th><th>искл.</th></tr>`;
  for (const k of manual) {
    const c = costOf(k);
    mh += `<tr><td>${matName(k)}</td><td class="n">${priceInput(k, "buy", null)}</td><td class="n">${priceInput(k, "pack", null)}</td>
      <td class="n">${c.v != null ? fmt(c.v, 2) : '<span class="tag na">нет в наличии</span>'}</td><td>${exclBox(k)}</td></tr>`;
  }
  $("manual").innerHTML = mh;
}


// ---------------------------------------------------------------- cart
const recipeById = (id) => DATA.recipes.find((r) => r.id === id) || null;
function addBtn(x) {
  const inCart = S.cart.some((l) => l.id === x.r.id);
  return `<button class="add${inCart ? " in" : ""}" type="button" data-add="${esc(x.r.id)}" title="${inCart ? "Ещё один ящик в корзину" : "В корзину"}"${x.na ? " disabled" : ""}>+</button>`;
}
function addToCart(id) {
  resetMemo();
  const r = recipeById(id), x = r && evaluate(r, filler());
  if (!x || x.na) return;
  const per = x.fits ? x.k : 1;                  // one crate's worth
  const line = S.cart.find((l) => l.id === id);
  if (line) line.qty += per; else S.cart.push({ id, qty: per });
  save(); render();
}

// materials that are made from other made materials come first, so every demand is known before it is expanded
function craftDepth(key, seen = new Set()) {
  if (seen.has(key) || costOf(key).src !== "craft") return 0;
  seen.add(key);
  const r = recipeOf(key);
  let d = 0;
  for (const k of Object.keys(r.items)) d = Math.max(d, craftDepth(k, seen));
  seen.delete(key);
  return d + 1;
}

function cartPlan(fill) {
  const cap = S.cap, lines = [], crates = [], crafts = [], demand = new Map();
  const add = (k, q) => demand.set(k, (demand.get(k) || 0) + q);
  let fees = 0, missing = [];
  for (const l of S.cart) {
    const r = recipeById(l.id);
    if (!r) continue;
    const x = evaluate(r, fill), qty = Math.max(0, Math.floor(l.qty) || 0);
    lines.push({ l, r, x, qty });
    if (x.na) { missing.push(r.ru || r.en); continue; }
    if (!qty) continue;
    const n = Math.ceil(qty / r.yield);
    crafts.push({ r, n, made: n * r.yield, top: true });
    fees += n * r.fee;
    for (const [k, q] of Object.entries(r.items)) add(k, q * n);
    // packing: one kind of piece per crate, the rest topped up with the filler
    const per = x.fits ? x.k : 1;
    for (let left = qty; left > 0; left -= per) {
      const items = Math.min(per, left), value = items * x.P;
      let fillN = 0;
      if (x.fits && fill && cap - value > 1e-9) fillN = Math.ceil((cap - value) / fill.pack - 1e-9);
      crates.push({ id: l.id, r, items, fill: fillN, value: Math.min(cap, value + fillN * (fill ? fill.pack : 0)), burn: x.fits ? 0 : value - cap });
    }
  }
  // expand the materials you make yourself, deepest first
  const made = [...demand.keys()].filter((k) => costOf(k).src === "craft");
  const queue = new Set(made);
  while (queue.size) {
    const key = [...queue].sort((a, b) => craftDepth(b) - craftDepth(a))[0];
    queue.delete(key);
    const need = demand.get(key);
    if (!need) continue;
    const r = recipeOf(key), n = Math.ceil(need / r.yield - 1e-9);
    crafts.push({ r, n, made: n * r.yield, need, key });
    fees += n * r.fee;
    demand.delete(key);
    for (const [k, q] of Object.entries(r.items)) {
      add(k, q * n);
      if (costOf(k).src === "craft") queue.add(k);
    }
  }
  const fillTotal = crates.reduce((t, c) => t + c.fill, 0);
  const buy = [...demand.entries()].map(([k, q]) => ({ k, q, c: costOf(k) }))
    .sort((a, b) => MAT()[a.k].ru.localeCompare(MAT()[b.k].ru, "ru"));
  let cost = fees;
  for (const b of buy) cost += b.c.v != null ? b.c.v * b.q : 0;
  if (fill) cost += fillTotal * fill.cost;
  const value = crates.reduce((t, c) => t + c.value, 0);
  return { lines, crates, crafts, buy, fees, fillTotal, cost, value, missing };
}

function renderCart(fill) {
  const box = $("cart");
  $("cartCount").textContent = S.cart.length ? `Корзина: ${S.cart.length}` : "Корзина пуста";
  if (!S.cart.length) { box.innerHTML = '<p class="hint">Нажмите «+» у предмета в таблицах ниже — он добавится на один ящик. Количество можно поменять здесь.</p>'; return; }
  const p = cartPlan(fill);
  const fk = fill && fill.key, fname = fk ? MAT()[fk].ru.toLowerCase() : "";
  let h = `<div class="cart-grid"><div>`;
  // what to craft
  h += `<h3>Что сделать</h3><table class="sub-table"><tr><th>Предмет</th><th class="n">Штук</th><th class="n">Ящиков</th><th class="n">В груз</th><th></th></tr>`;
  for (const { l, r, x, qty } of p.lines) {
    const nCr = x.na ? 0 : Math.ceil(qty / (x.fits ? x.k : 1));
    h += `<tr><td><span class="mn">${iconHtml(r.icon, r.ru || r.en, "ico sm")}<span>${esc(r.ru || r.en)}${x.na ? ' <span class="tag na">нет цены</span>' : ""}${x.fits === false ? ' <span class="tag burn">не влезает</span>' : ""}</span></span></td>
      <td class="n"><input type="number" min="0" step="1" data-cq="${esc(l.id)}" value="${qty}"></td><td class="n">${nCr}</td>
      <td class="n">${fmt(x.P != null ? x.P * qty : null)}</td>
      <td><button type="button" class="ghost" data-cplus="${esc(l.id)}" title="ещё ящик">+ ящик</button> <button type="button" class="ghost" data-cdel="${esc(l.id)}" title="убрать">×</button></td></tr>`;
  }
  h += `</table>`;
  // intermediate crafts
  const inner = p.crafts.filter((c) => !c.top);
  if (inner.length) {
    h += `<h3>Сделать по пути</h3><table class="sub-table"><tr><th>Материал</th><th class="n">Раз</th><th class="n">Получится</th><th class="n">Нужно</th></tr>`;
    for (const c of inner.slice().reverse()) {
      h += `<tr><td>${matName(c.key)}</td><td class="n">${c.n}</td><td class="n">${c.made}</td><td class="n">${fmt(c.need, 2)}${c.made - c.need > 0.01 ? ` <span class="src-tag">(останется ${fmt(c.made - c.need, 2)})</span>` : ""}</td></tr>`;
    }
    h += `</table>`;
  }
  h += `</div><div>`;
  // shopping list
  h += `<h3>Взять с собой</h3><table class="sub-table"><tr><th>Материал</th><th class="n">Кол-во</th><th>Откуда</th><th class="n">Цена</th><th class="n">Сумма</th></tr>`;
  for (const b of p.buy) {
    const isFill = b.k === fk;
    h += `<tr><td>${matName(b.k, isFill ? " <span class='src-tag'>(в рецепты)</span>" : "")}</td><td class="n">${fmt(b.q, 2)}</td>
      <td class="src-tag">${b.c.src ? SRC[b.c.src] : '<span class="tag na">нет цены</span>'}</td><td class="n">${fmt(b.c.v, 2)}</td><td class="n">${fmt(b.c.v != null ? b.c.v * b.q : null)}</td></tr>`;
  }
  if (fill && p.fillTotal) {
    h += `<tr><td>${matName(fk, ' <span class="src-tag">(добивка ящиков)</span>')}</td><td class="n">${p.fillTotal}</td><td class="src-tag">${SRC[costOf(fk).src] || ""}</td><td class="n">${fmt(fill.cost, 2)}</td><td class="n">${fmt(fill.cost * p.fillTotal)}</td></tr>`;
    const inRec = (p.buy.find((b) => b.k === fk) || {}).q || 0;
    if (inRec) h += `<tr class="total"><td>${esc(MAT()[fk].ru)} всего</td><td class="n">${fmt(inRec + p.fillTotal, 2)}</td><td colspan="3"></td></tr>`;
  }
  h += `<tr><td>Плата станков</td><td></td><td></td><td></td><td class="n">${fmt(p.fees)}</td></tr></table>`;
  // totals
  const loss = p.cost - p.value;
  h += `<table class="sub-table totals"><tr><td>Ящиков</td><td class="n">${p.crates.length}</td></tr>
    <tr><td>Потратите всего</td><td class="n">${fmt(p.cost)} гр.</td></tr>
    <tr><td>Засчитается в грузы</td><td class="n">${fmt(p.value)} гр.</td></tr>
    <tr><td>Потеря</td><td class="n ${loss > 0.5 ? "bad" : "good"}">${fmt(loss)} гр.</td></tr></table>`;
  if (p.missing.length) h += `<p class="hint bad">Нет цены для: ${esc(p.missing.join(", "))} — они не посчитаны.</p>`;
  h += `</div></div>`;
  // crates
  h += `<h3>По ящикам</h3><ol class="crates">`;
  p.crates.forEach((c, i) => {
    h += `<li><button type="button" class="crate-del" data-crdel="${esc(c.id)}" data-items="${c.items}" title="Убрать этот ящик">×</button><span class="crate-no">${i + 1}.</span> ${esc(c.r.ru || c.r.en)} ×${c.items}${c.fill ? ` + ${esc(fname)} ×${c.fill}` : ""} — ${fmt(c.value)} гр.${c.burn > 0 ? ` <span class="tag burn">сгорит ${fmt(c.burn, 0)}</span>` : ""}</li>`;
  });
  h += `</ol><p class="cart-actions"><button type="button" id="cartCopy">Скопировать список</button> <button type="button" class="ghost" id="cartClear">Очистить корзину</button> <span id="cartMsg" class="src-tag"></span></p>`;
  box.innerHTML = h;
  box.dataset.text = cartText(p, fill);
}

function cartText(p, fill) {
  const fk = fill && fill.key, L = [];
  L.push("Сделать:");
  for (const { r, qty } of p.lines) L.push(`  ${r.ru || r.en} — ${qty} шт.`);
  const inner = p.crafts.filter((c) => !c.top);
  if (inner.length) { L.push("По пути:"); for (const c of inner.slice().reverse()) L.push(`  ${MAT()[c.key].ru} — ${c.n} раз (${c.made} шт.)`); }
  L.push("Взять:");
  for (const b of p.buy) L.push(`  ${MAT()[b.k].ru}${b.k === fk ? " (в рецепты)" : ""} — ${fmt(b.q, 2)}`);
  if (fill && p.fillTotal) L.push(`  ${MAT()[fk].ru} (добивка) — ${p.fillTotal}`);
  L.push(`Плата станков: ${fmt(p.fees)} гр. · Потратите: ${fmt(p.cost)} гр. · Ящиков: ${p.crates.length}`);
  L.push("По ящикам:");
  p.crates.forEach((c, i) => L.push(`  ${i + 1}. ${c.r.ru || c.r.en} ×${c.items}${c.fill ? ` + ${MAT()[fk].ru.toLowerCase()} ×${c.fill}` : ""}`));
  return L.join("\n");
}


// ---------------------------------------------------------------- market prices window
function renderPricesDialog() {
  const q = $("pricesSearch").value.trim().toLowerCase();
  const smith = $("pricesSmith").checked;
  const smithIds = new Set(Object.values(MAT()).filter((m) => m.kind === "good").map((m) => m.id));
  const ids = new Set([...Object.keys(SERVER.market), ...Object.keys(SERVER.auction)]);
  const ruOf = (id) => {
    const m = Object.values(MAT()).find((x) => x.kind === "good" && x.id === id);
    const a = SERVER.auction[id];
    const n = m ? m.ru : a && a.name ? a.name : id;
    return n.charAt(0).toUpperCase() + n.slice(1);
  };
  const iconOf = (id) => (Object.values(MAT()).find((x) => x.kind === "good" && x.id === id) || {}).icon;
  let rows = [...ids].map((id) => ({ id, ru: ruOf(id), m: SERVER.market[id] || {}, a: SERVER.auction[id] || {} }))
    .filter((x) => (!smith || smithIds.has(x.id)) && (!q || x.ru.toLowerCase().includes(q) || x.id.includes(q)))
    .sort((x, y) => x.ru.localeCompare(y.ru, "ru"));
  let h = `<tr><th>Товар</th><th class="n">Рыночная цена</th><th class="n">Аукцион ср.</th><th class="n">Аукцион мин.</th><th class="n">В груз*</th><th class="n">Выставлено</th><th class="n">Продано</th></tr>`;
  for (const x of rows) {
    const pack = serverPack(x.id);
    h += `<tr><td><span class="mn">${iconHtml(iconOf(x.id), x.ru, "ico sm")}<span>${esc(x.ru)}</span></span></td><td class="n">${fmt(num(x.m.price) > 0 ? x.m.price : null, 2)}</td>
      <td class="n">${fmt(num(x.a.avg) > 0 ? x.a.avg : null, 2)}</td><td class="n">${fmt(num(x.a.low) > 0 ? x.a.low : null, 2)}</td><td class="n">${fmt(pack, 2)}</td>
      <td class="n">${x.a.qty != null ? fmt(x.a.qty, 0) : "—"}</td><td class="n">${x.a.sold != null ? fmt(x.a.sold, 0) : "—"}</td></tr>`;
  }
  if (!rows.length) h += `<tr><td colspan="7" class="src-tag">Ничего не найдено.</td></tr>`;
  $("pricesTable").innerHTML = h;
  $("pricesInfo").innerHTML = (SERVER.updated ? `Данные сервера от ${new Date(SERVER.updated).toLocaleString("ru-RU")} · ${esc(SERVER.label)}. ` : "Цены сервера не загружены. ") +
    "<b>«Аукцион»</b> — цены игроков (средняя за неделю и самая низкая сейчас). <b>«Рыночная цена»</b> — оценка сервера, как он её считает, не описано. <b>«В груз»</b> — сколько одна штука засчитывается в стоимость торгового ящика. " +
    "* Точной цены в грузе API сервера не даёт: здесь оценка (поле <code>instant</code> аукциона или значение из окна упаковки, иначе рыночная цена). " +
    "Для кузнечного сырья она совпадает с игрой, для товаров других ремёсел может отличаться — точное число видно в окне упаковки («Что принести»). «—» — нет данных. Цены сервера без ваших правок.";
}

// ---------------------------------------------------------------- events
function bind() {
  $("buySource").value = S.buySource;
  $("cap").value = S.cap;
  $("search").value = S.search;
  $("onlyFit").checked = S.onlyFit;
  $("hideNA").checked = S.hideNA;
  $("hideParts").checked = S.hideParts;
  const goods = Object.keys(MAT()).filter((k) => MAT()[k].kind === "good").sort((a, b) => MAT()[a].ru.localeCompare(MAT()[b].ru, "ru"));
  $("filler").innerHTML = '<option value="">ничем</option>' + goods.map((k) => `<option value="${esc(k)}">${esc(MAT()[k].ru)}</option>`).join("");
  $("filler").value = S.filler;
  const lv = ["all", ...Array.from({ length: MAX_LEVEL }, (_, i) => i + 1)];
  if (S.level !== "all" && +S.level > MAX_LEVEL) S.level = "all";
  const drawLevels = () => ($("levels").innerHTML = lv.map((l) => `<span class="chip${String(S.level) === String(l) ? " on" : ""}" data-l="${l}">${l === "all" ? "все уровни" : l}</span>`).join(""));
  drawLevels();

  const set = (k, v) => { S[k] = v; save(); render(); };
  $("buySource").onchange = (e) => set("buySource", e.target.value);
  $("cap").onchange = (e) => set("cap", Math.max(1, +e.target.value || 450));
  $("filler").onchange = (e) => set("filler", e.target.value);
  $("search").oninput = (e) => set("search", e.target.value);
  $("onlyFit").onchange = (e) => set("onlyFit", e.target.checked);
  $("hideNA").onchange = (e) => set("hideNA", e.target.checked);
  $("hideParts").onchange = (e) => set("hideParts", e.target.checked);
  $("levels").onclick = (e) => { const l = e.target.dataset.l; if (l) { S.level = l; save(); drawLevels(); render(); } };
  $("excluded").onclick = (e) => { const k = e.target.dataset.k; if (k) set("excl", S.excl.filter((x) => x !== k)); };
  $("recipes").onclick = (e) => {
    if (onAdd(e)) return;
    const th = e.target.closest("th.sort");
    if (th) { const k = th.dataset.k; S.sort = { key: k, dir: S.sort.key === k ? -S.sort.dir : (k === "name" || k === "level" ? 1 : -1) }; save(); render(); return; }
    const tr = e.target.closest("tr.r");
    if (tr) { const id = tr.dataset.id; open.has(id) ? open.delete(id) : open.add(id); render(); }
  };
  const onAdd = (e) => { const b = e.target.closest("button[data-add]"); if (b) { addToCart(b.dataset.add); return true; } return false; };
  $("best").onclick = (e) => { onAdd(e); };
  $("cart").addEventListener("change", (e) => {
    const id = e.target.dataset.cq;
    if (id == null) return;
    const line = S.cart.find((l) => l.id === id);
    if (line) { line.qty = Math.max(0, Math.floor(+e.target.value) || 0); save(); render(); }
  });
  $("cart").addEventListener("click", async (e) => {
    const t = e.target;
    if (t.dataset.cdel) { S.cart = S.cart.filter((l) => l.id !== t.dataset.cdel); save(); render(); }
    else if (t.dataset.crdel) {
      // one crate less: its pieces come off that line of the cart
      const line = S.cart.find((l) => l.id === t.dataset.crdel);
      if (line) {
        line.qty = Math.max(0, line.qty - (+t.dataset.items || 0));
        if (!line.qty) S.cart = S.cart.filter((l) => l !== line);
        save(); render();
      }
    }
    else if (t.dataset.cplus) addToCart(t.dataset.cplus);
    else if (t.id === "cartClear") { if (confirm("Очистить корзину?")) { S.cart = []; save(); render(); } }
    else if (t.id === "cartCopy") {
      try { await navigator.clipboard.writeText($("cart").dataset.text || ""); $("cartMsg").textContent = "скопировано"; }
      catch { $("cartMsg").textContent = "не удалось скопировать"; }
    }
  });
  $("pricesBtn").onclick = () => { renderPricesDialog(); $("pricesDlg").showModal(); };
  $("pricesClose").onclick = () => $("pricesDlg").close();
  $("pricesDlg").addEventListener("click", (e) => { if (e.target === $("pricesDlg")) $("pricesDlg").close(); });
  $("pricesSearch").oninput = renderPricesDialog;
  $("pricesSmith").onchange = renderPricesDialog;
  $("resetAll").onclick = () => {
    if (confirm("Сбросить все ваши цены, способы и исключения к данным сервера?")) { S.ov = {}; S.excl = []; save(); render(); }
  };
  $("refresh").onclick = () => refresh(true);
  for (const id of ["goods", "parts", "manual"]) {
    $(id).addEventListener("change", (e) => {
      const t = e.target, k = t.dataset.k, f = t.dataset.f;
      if (!k || !f) return;
      if (f === "excl") {
        S.excl = t.checked ? [...new Set([...S.excl, k])] : S.excl.filter((x) => x !== k);
      } else {
        const o = Object.assign({}, S.ov[k]);
        if (f === "mode") { if (t.value === "auto") delete o.mode; else o.mode = t.value; }
        else if (t.value === "") delete o[f];
        else o[f] = Math.max(0, +t.value);
        if (Object.keys(o).length) S.ov[k] = o; else delete S.ov[k];
      }
      save(); render();
    });
  }
}

async function refresh(bust) {
  $("refresh").disabled = true;
  $("status").textContent = "Загрузка цен…";
  try { await fetchPrices(bust); showStatus(); }
  catch (e) { showStatus(e.message); }
  $("refresh").disabled = false;
  render();
  if ($("pricesDlg").open) renderPricesDialog();
}

async function main() {
  const r = await fetch("data/smithing.json");
  DATA = await r.json();
  DATA.byName = new Map();
  for (const x of DATA.recipes) if (!DATA.byName.has(x.en)) DATA.byName.set(x.en, x);
  DATA.partNames = new Set(Object.entries(DATA.materials).filter(([, m]) => m.kind === "part" || m.recipe).map(([k]) => k));
  bind();
  await refresh(false);
  setInterval(() => refresh(true), 10 * 60 * 1000);   // the copy changes every 30 minutes
  setInterval(showStatus, 60 * 1000);
}
main();
