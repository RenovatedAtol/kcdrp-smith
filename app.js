"use strict";
// KCD Roleplay smithing -> trade pack calculator. Plain JS, no build step.

const PRICE_SOURCES = [
  // our own copy, refreshed every 30 minutes by .github/workflows/prices.yml
  { url: "https://raw.githubusercontent.com/RenovatedAtol/kcdrp-smith/prices/prices.json", kind: "own", label: "API сервера" },
  // fallback: DanekKuznec's hourly copy of the auction (no realm prices in it)
  { url: "https://raw.githubusercontent.com/DanekKuznec/kcd2-rp-crafting/prices/auction.json", kind: "danek", label: "копия DanekKuznec (без цен казны)" },
];
// pack prices of goods the auction has no "instant" figure for (from the game's packing window)
const DEFAULT_PACK = { steel: 9.5, haft: 6, foundhorseshoe: 3, holynail: 4, brokenrod: 6, ghosthorseshoe: 38 };
const STORE = "kcdrp-smith-v1";
const DEFAULTS = {
  buySource: "avg", cap: 450, filler: "coal", ov: {}, excl: [], level: "all", search: "",
  onlyFit: false, hideNA: true, hideParts: false, sort: { key: "eff", dir: -1 },
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
const serverRealm = (id) => (num((SERVER.market[id] || {}).buy) > 0 ? SERVER.market[id].buy : null);
function serverPack(id) {
  const a = SERVER.auction[id];
  if (a && num(a.instant) > 0) return a.instant;
  if (DEFAULT_PACK[id] != null) return DEFAULT_PACK[id];
  const m = SERVER.market[id];
  return m && num(m.price) > 0 ? m.price : null;
}
// the three prices of a material: the user's number wins over the server's
function auctionPrice(key) {
  const m = MAT()[key], o = ov(key);
  if (num(o.buy) != null) return o.buy > 0 ? o.buy : null;
  return m.kind === "good" ? serverAuction(m.id) : null;
}
function realmPrice(key) {
  const m = MAT()[key], o = ov(key);
  if (num(o.realm) != null) return o.realm > 0 ? o.realm : null;
  return m.kind === "good" ? serverRealm(m.id) : null;
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
  const mode = ov(key).mode || "auto";
  const opts = [];
  const a = auctionPrice(key), r = realmPrice(key), rec = MAT()[key].recipe ? recipeOf(key) : null;
  if ((mode === "auto" || mode === "auction") && a != null) opts.push({ v: a, src: MAT()[key].kind === "good" ? "auction" : "price" });
  if ((mode === "auto" || mode === "realm") && r != null) opts.push({ v: r, src: "realm" });
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
  // a good bought from the realm and packed as it is pays back what was paid
  const p = c.src === "realm" ? c.v : packOf(key);
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
  res.time = res.k * (r.secs || 0);
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
  const f = x.n ? ` + ${x.n} ${esc(MAT()[S.filler].ru.toLowerCase())}` : "";
  const un = x.unfilled > 0.5 ? ` <span class="tag na">не добит на ${fmt(x.unfilled, 0)}</span>` : "";
  return `${x.k} шт.${f}${un}`;
}
function nameCell(r) {
  const part = DATA.partNames.has(r.en) ? '<span class="tag part">материал</span>' : "";
  return `${esc(r.ru || r.en)}${part}<span class="en">${esc(r.en)}${r.yield > 1 ? ` · ×${r.yield}` : ""}</span>`;
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
  { key: "time", t: "Время", n: true, v: (x) => x.time },
];

function render() {
  resetMemo();
  const fill = filler();
  const excl = new Set(S.excl);
  const all = DATA.recipes.filter((r) => !r.aux).map((r) => evaluate(r, fill));
  for (const x of all) x.excluded = [...usedBy(x.r)].some((k) => excl.has(k));

  // best per level
  let bh = "<tr><th>Ур.</th><th>Предмет</th><th class='n'>Себестоимость</th><th class='n'>В груз</th><th class='n'>КПД</th><th class='n'>Потеря за шт.</th><th>Ящик</th><th class='n'>Потеря ящика</th></tr>";
  for (let L = 1; L <= 10; L++) {
    const c = all.filter((x) => x.r.level === L && !x.na && x.fits && !x.excluded && !x.r.en.startsWith("jobtool"));
    if (!c.length) { bh += `<tr class="na"><td class="n">${L}</td><td colspan="7">ни один доступный предмет не помещается в ящик</td></tr>`; continue; }
    c.sort((a, b) => b.eff - a.eff || b.P - a.P);
    const x = c[0];
    bh += `<tr><td class="n">${L}</td><td>${nameCell(x.r)}</td><td class="n">${fmt(x.M)}</td><td class="n">${fmt(x.P)}</td><td class="n ${effClass(x.eff)}">${fmt(x.eff * 100)}%</td><td class="n">${fmt(x.loss)}</td><td>${crateText(x)}</td><td class="n">${fmt(x.crate)}</td></tr>`;
  }
  if (fill) {
    const nb = Math.ceil(S.cap / fill.pack - 1e-9);
    bh += `<tr><td></td><td colspan="7" class="src-tag">Для сравнения: ящик из одного товара «${esc(MAT()[fill.key].ru)}» — ${nb} шт., потеря ${fmt(nb * fill.cost - S.cap)} гр.</td></tr>`;
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
  let h = "<tr>" + COLS.map((c) => `<th class="${c.n ? "n " : ""}${c.sortless ? "" : "sort"} ${S.sort.key === c.key ? (S.sort.dir > 0 ? "asc" : "desc") : ""}" data-k="${c.key}">${c.t}</th>`).join("") + "</tr>";
  for (const x of rows) {
    const na = x.na ? ' <span class="tag na">нет цены</span>' : "";
    h += `<tr class="r${x.na ? " na" : ""}" data-id="${esc(x.r.id)}">
      <td class="n">${x.r.level}</td><td>${nameCell(x.r)}${na}</td><td class="mats">${esc(matsText(x.r))}</td>
      <td class="n">${fmt(x.r.fee / x.r.yield)}</td><td class="n">${fmt(x.M)}</td><td class="n">${fmt(x.P)}</td>
      <td class="n ${effClass(x.eff)}">${x.eff != null ? fmt(x.eff * 100) + "%" : "—"}</td><td class="n">${fmt(x.loss)}</td>
      <td>${crateText(x)}</td><td class="n">${fmt(x.crate)}</td><td class="n">${x.time ? fmtTime(x.time) : "—"}</td></tr>`;
    if (open.has(x.r.id)) h += `<tr class="detail"><td></td><td colspan="${COLS.length - 1}">${breakdown(x.r)}</td></tr>`;
  }
  if (!rows.length) h += `<tr><td colspan="${COLS.length}" class="src-tag">Нет рецептов под эти фильтры.</td></tr>`;
  $("recipes").innerHTML = h;

  $("excluded").innerHTML = S.excl.map((k) => `<span class="chip x" data-k="${esc(k)}">${esc(MAT()[k] ? MAT()[k].ru : k)}</span>`).join("");
  renderPrices();
}

function fmtTime(s) { return s >= 60 ? `${Math.floor(s / 60)} мин ${s % 60 ? (s % 60) + " с" : ""}` : `${s} с`; }
const SRC = { auction: "аукцион", realm: "казна", craft: "сделать", price: "ваша цена" };

function breakdown(r) {
  let h = `<table class="sub-table"><tr><th>Материал</th><th class="n">Кол-во</th><th>Откуда</th><th class="n">Цена за шт.</th><th class="n">Себестоимость</th><th class="n">В груз за шт.</th><th class="n">В груз</th></tr>`;
  for (const [k, q] of Object.entries(r.items)) {
    const c = costOf(k), p = packOf(k);
    h += `<tr><td>${esc(MAT()[k].ru)}</td><td class="n">${q}</td><td class="src-tag">${c.src ? SRC[c.src] : "нет цены"}</td>
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
  if (m.kind === "good") o.push(["realm", "казна"]);
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
  let g = `<tr><th>Товар</th><th class="n">Аукцион ср.</th><th class="n">Аукцион мин.</th><th class="n">Продано</th><th class="n">Покупка</th><th class="n">В груз</th><th class="n">Казна</th><th>Способ</th><th class="n">Итого за шт.</th><th>искл.</th></tr>`;
  for (const k of goods) {
    const m = MAT()[k], a = SERVER.auction[m.id] || {}, c = costOf(k);
    g += `<tr><td>${esc(m.ru)}</td><td class="n">${fmt(a.avg, 2)}</td><td class="n">${fmt(a.low, 2)}</td><td class="n">${a.sold != null ? fmt(a.sold, 0) : "—"}</td>
      <td class="n">${priceInput(k, "buy", serverAuction(m.id))}</td><td class="n">${priceInput(k, "pack", serverPack(m.id))}</td>
      <td class="n">${priceInput(k, "realm", serverRealm(m.id))}</td><td>${modeSelect(k)}</td>
      <td class="n">${fmt(c.v, 2)} <span class="src-tag">${c.src ? SRC[c.src] : ""}</span></td><td>${exclBox(k)}</td></tr>`;
  }
  $("goods").innerHTML = g;
  let p = `<tr><th>Материал</th><th>Рецепт</th><th class="n">Сделать за шт.</th><th class="n">Купить за шт.</th><th class="n">В груз</th><th>Способ</th><th class="n">Итого за шт.</th><th>искл.</th></tr>`;
  for (const k of parts) {
    const r = recipeOf(k), c = costOf(k);
    const craft = r ? recipeCost(r) : null;
    p += `<tr><td>${esc(MAT()[k].ru)}</td><td class="mats">${r ? esc(matsText(r)) + (r.yield > 1 ? ` → ${r.yield} шт.` : "") : "—"}</td>
      <td class="n">${fmt(craft, 2)}</td><td class="n">${priceInput(k, "buy", null)}</td><td class="n">${priceInput(k, "pack", r ? recipePack(r) : null)}</td>
      <td>${modeSelect(k)}</td><td class="n">${fmt(c.v, 2)} <span class="src-tag">${c.src ? SRC[c.src] : ""}</span></td><td>${exclBox(k)}</td></tr>`;
  }
  $("parts").innerHTML = p;
  let mh = `<tr><th>Материал</th><th class="n">Покупка</th><th class="n">В груз</th><th class="n">Итого за шт.</th><th>искл.</th></tr>`;
  for (const k of manual) {
    const c = costOf(k);
    mh += `<tr><td>${esc(MAT()[k].ru)}</td><td class="n">${priceInput(k, "buy", null)}</td><td class="n">${priceInput(k, "pack", null)}</td>
      <td class="n">${c.v != null ? fmt(c.v, 2) : '<span class="tag na">нет в наличии</span>'}</td><td>${exclBox(k)}</td></tr>`;
  }
  $("manual").innerHTML = mh;
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
  const lv = ["all", 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
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
    const th = e.target.closest("th.sort");
    if (th) { const k = th.dataset.k; S.sort = { key: k, dir: S.sort.key === k ? -S.sort.dir : (k === "name" || k === "level" ? 1 : -1) }; save(); render(); return; }
    const tr = e.target.closest("tr.r");
    if (tr) { const id = tr.dataset.id; open.has(id) ? open.delete(id) : open.add(id); render(); }
  };
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
