"use strict";
// KCD Roleplay crafts -> trade pack calculator. Plain JS, no build step.

const PRICE_SOURCES = [
  // our own copy, refreshed every 30 minutes by .github/workflows/prices.yml
  { url: "https://raw.githubusercontent.com/RenovatedAtol/kcdrp-smith/prices/prices.json", kind: "own", label: "API сервера" },
  // fallback: DanekKuznec's hourly copy of the auction (no market prices in it)
  { url: "https://raw.githubusercontent.com/DanekKuznec/kcd2-rp-crafting/prices/auction.json", kind: "danek", label: "копия аукциона DanekKuznec" },
];
// pack prices read off the game's packing windows (2026-11-25): the API has no exact pack price, and the auction's
// "instant" (the crown's Sell-now price) matches the smith's raw goods but not the tailor's. These win over it.
// They move with the auction: steel was 9.5 in the morning and 8 by evening, padding 3.2 then 3.8 - latest kept.
const DEFAULT_PACK = {
  steel: 8, haft: 6, foundhorseshoe: 3, holynail: 4, brokenrod: 6, ghosthorseshoe: 38, leather: 6,
  linenstrip: 1, suturekit: 2.3, padding: 3.8, hempfibre: 4, flax: 4, hide: 5, noose: 6.5, feather: 7, linen: 10,
  venison: 2.7, hare: 1.9, malt: 1.9, roach: 2, sage: 2, carp: 3, boarmeat: 3.9, eel: 4, pike: 4,
};
// the smith's raw goods whose auction "instant" was checked against the packing window
const INSTANT_CHECKED = new Set(["coal", "ore", "copperore", "logs"]);
// where a good's pack price comes from: "game" (read off the packing window), "est" (an estimate from the API)
function packSource(id) {
  if (DEFAULT_PACK[id] != null || INSTANT_CHECKED.has(id)) return "game";
  return "est";
}
const PACK_SRC_TAG = { game: '<span class="src-tag" title="Число из окна упаковки в игре">игра</span>',
  est: '<span class="tag na" title="Оценка по данным API: точной цены в грузе сервер не публикует. Посмотрите в игре («Что принести») и впишите своё число">оценка</span>' };
// level 1 is left out: it levels up quickly and its pieces tell little. Levels where no piece fits the pack are
// left out too (smithing 9-10: every piece is worth several crates and would mostly burn).
const MIN_LEVEL = 2, MAX_LEVEL = 10;
const STORE = "kcdrp-smith-v1";
const DEFAULTS = {
  buySource: "avg", craft: "smithing", caps: {}, fillers: {}, packFee: 10, ov: {}, excl: [], level: "all", search: "",
  onlyFit: false, hideNA: true, hideParts: false, sort: { key: "eff", dir: -1 }, cart: [], itemPack: {}, tab: "items", origin: "Kuttenberg", stock: 2, hire: false,
};

let DATA = null;            // data/crafts.json
let SERVER = { market: {}, auction: {}, towns: [], updated: null, label: "" };
let S = load();
let open = new Set();       // recipe ids with their breakdown open

function load() {
  let s;
  try { s = Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem(STORE) || "{}")); }
  catch { s = Object.assign({}, DEFAULTS); }
  // the packing fee was 25 by mistake: a 25 nobody typed in becomes the real 10
  if (!s.packFeeSet && s.packFee === 25) s.packFee = DEFAULTS.packFee;
  // settings of the smithing-only version: one crate size and one filler
  if (s.filler !== undefined) { s.fillers = Object.assign({ smithing: s.filler }, s.fillers); delete s.filler; }
  if (s.cap !== undefined) { if (s.cap !== 450) s.caps = Object.assign({ smithing: s.cap }, s.caps); delete s.cap; }
  return s;
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
function auctionFromMirror(d) {
  const auction = {};
  for (const a of (d.auction && d.auction.items) || []) {
    const id = String(a.item || "");
    if (id) auction[id.startsWith("good:") ? id.slice(5) : id] = a;
  }
  return auction;
}
async function getJson(url, bust) {
  const r = await fetch(url + (bust ? `?t=${Date.now()}` : ""), { cache: "no-store" });
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.json();
}
// our own copy first; when it is older than this, the auction comes from DanekKuznec's hourly copy if that is newer
const STALE_MS = 90 * 60 * 1000;
async function fetchPrices(bust) {
  const [own, mirror] = PRICE_SOURCES;
  let ownData = null, err = [];
  try { ownData = await getJson(own.url, bust); } catch (e) { err.push(`${own.label}: ${e.message}`); }
  const ownAge = ownData && ownData.updated ? Date.now() - new Date(ownData.updated) : Infinity;
  let mirrorData = null;
  if (ownAge > STALE_MS) {
    try { mirrorData = await getJson(mirror.url, bust); } catch (e) { err.push(`${mirror.label}: ${e.message}`); }
  }
  if (!ownData && !mirrorData) throw new Error(err.join("; "));
  SERVER = ownData
    ? { market: ownData.market || {}, auction: ownData.auction || {}, towns: ownData.towns || [], updated: ownData.updated, townsUpdated: ownData.updated, label: own.label }
    : { market: {}, auction: {}, towns: [], updated: null, townsUpdated: null, label: "" };
  if (mirrorData && (!ownData || new Date(mirrorData.updated) > new Date(ownData.updated))) {
    const fresh = auctionFromMirror(mirrorData);
    for (const [id, a] of Object.entries(fresh)) SERVER.auction[id] = Object.assign({}, SERVER.auction[id], a);
    SERVER.updated = mirrorData.updated;
    SERVER.label = ownData ? "аукцион — копия DanekKuznec, склады и рыночные цены — " + own.label : mirror.label;
  }
  return true;
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
const craftOf = (id) => DATA.crafts.find((c) => c.id === id) || DATA.crafts[0];
const CRAFT = () => craftOf(S.craft);
const capOf = (cid = S.craft) => { const v = S.caps && S.caps[cid]; return num(v) > 0 ? v : craftOf(cid).pack.worth; };
const recipesOf = (key) => DATA.byName.get(key) || [];
// the recipe a material is made by: the cheapest of its recipes
function recipeOf(key) { const c = costOf(key); return c.rec || recipesOf(key)[0] || null; }

function serverAuction(id) {
  const a = SERVER.auction[id];
  if (!a) return null;
  const order = S.buySource === "low" ? ["low", "avg"] : ["avg", "low"];
  for (const f of order) if (num(a[f]) > 0) return a[f];
  return null;
}
function serverPack(id) {
  if (DEFAULT_PACK[id] != null) return DEFAULT_PACK[id];
  const a = SERVER.auction[id];
  if (a && num(a.instant) > 0) return a.instant;
  const m = SERVER.market[id];
  return m && num(m.price) > 0 ? m.price : null;
}
// the prices of a material: the user's number wins over the server's
function auctionPrice(key) {
  const m = MAT()[key], o = ov(key);
  if (num(o.buy) != null) return o.buy > 0 ? o.buy : null;
  if (m.kind === "good") return serverAuction(m.id);
  return m.auctionItem ? serverAuction(m.auctionItem) : null;   // a game item on sale (Comfrey, Chicken, Egg...)
}
// wild herbs and mushrooms anyone picks by hand (wiki "Gathering"): not sold, so not in the realm's data
const WILD = ["mint", "valerian", "eyebright", "St John's wort", "marigold", "poppy", "comfrey", "thistle", "dandelion",
  "wormwood", "feverfew", "Boletus edulis", "Lepiota"];
function packPrice(key) {
  const m = MAT()[key], o = ov(key);
  if (num(o.pack) != null) return o.pack;
  if (m.kind === "good") return serverPack(m.id);
  if (o.mode === "self") return 0;                      // picked yourself: what the server counts it at is unknown
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
  memoCost.set(key, { v: null, src: null });   // a guard against recipes that loop back
  const m = MAT()[key], a = auctionPrice(key);
  if (mode === "self") opts.push({ v: 0, src: "self" });
  if ((mode === "auto" || mode === "auction") && a != null)
    opts.push({ v: a, src: m.kind === "good" || (m.auctionItem && num(ov(key).buy) == null) ? "auction" : "price" });
  if ((mode === "auto" || mode === "craft") && m.recipe) {
    for (const rec of recipesOf(key)) {
      const c = recipeCost(rec, depth + 1);
      if (c != null) opts.push({ v: c, src: "craft", rec });
    }
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
    memoPack.set(key, null);
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
// how many times the bench fee counts in a trade pack. The wiki says once; the game's packing window (2026-11-25)
// agrees for smithing levels 1-3 (Old dagger 3, Pitchfork 5, Broad axe 84.5) and cooking levels 5 and 7 (Cooked roe
// deer loin 4.7, Cooked deer ribs 6.7), but counts it twice for smithing level 4 (Rider's war hammer 100.5, Flanged
// mace 145.5). Everything else: once, and pieces of level 4+ that were not checked carry an "unchecked" mark.
const FEE_CHECKED = { smithing: { 1: 1, 2: 1, 3: 1, 4: 2 }, cooking: { 5: 1, 7: 1 } };
const FEE_IN_PACK = (r) => ((FEE_CHECKED[r.craft] || {})[r.level] || 1);
const feeChecked = (r) => (FEE_CHECKED[r.craft] || {})[r.level] != null;
const packFeeOf = (r) => r.fee * FEE_IN_PACK(r);
const GUESS_TAG = '<span class="tag na" title="Сколько этот предмет засчитывается в груз, в игре не проверено: у кузнеца 4-го уровня сервер засчитывает плату станка дважды, у других уровней и ремёсел — один раз. Проверьте: положите предмет в груз и впишите число из «Будет взято» в его расчёт.">не проверено</span>';
function recipePack(r, depth = 0) {
  if (depth === 0 && num(S.itemPack && S.itemPack[r.id]) != null) return S.itemPack[r.id];   // the value read in the game
  let t = packFeeOf(r);
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

// what tops a craft's pack up: the player's choice, or the pack's good that loses least
function fillerFor(cid) {
  const goods = craftOf(cid).pack.goods.filter((k) => MAT()[k]);
  let key = S.fillers ? S.fillers[cid] : undefined;
  if (key === undefined) {
    let best = null;
    const cap = capOf(cid);
    for (const k of goods) {
      const c = costOf(k), p = packOf(k);
      if (!(c.v > 0) || !(p > 0)) continue;
      // bought at auction: only if enough is on offer to fill a whole pack (a thin market's average misleads)
      const a = SERVER.auction[MAT()[k].id];
      if (c.src === "auction" && !(a && a.qty >= Math.ceil(cap / p))) continue;
      const r = p / c.v;
      if (!best || r > best.r + 1e-9 || (Math.abs(r - best.r) < 1e-9 && p < best.p)) best = { k, r, p };
    }
    key = best && best.k;
  }
  if (!key || !MAT()[key]) return null;
  const c = costOf(key);
  if (c.v == null) return null;
  const p = packOf(key);
  return p > 0 ? { key, cost: c.v, pack: p } : null;
}
const filler = () => fillerFor(S.craft);

function evaluate(r, fill, cap = capOf(r.craft)) {
  const M = recipeCost(r), P = recipePack(r);
  const res = { r, M, P, eff: M && P != null ? P / M : null, loss: M != null && P != null ? M - P : null };
  // levels 5+ count the bench fee twice by assumption only, unless the player typed the game's value
  res.guess = r.fee > 0 && r.level >= 4 && !feeChecked(r) && num(S.itemPack && S.itemPack[r.id]) == null;
  res.fillKey = fill ? fill.key : null;
  res.selfPicked = [...usedBy(r)].some((k) => ov(k).mode === "self" && num(ov(k).pack) == null);
  if (res.selfPicked) res.guess = true;
  if (M == null || P == null || P <= 0) { res.na = true; return res; }
  const fee = packFee();
  if (P > cap + 1e-9) {
    Object.assign(res, { fits: false, k: 1, n: 0, burn: P - cap, cost: M + fee, worth: cap });
  } else {
    const k = Math.floor(cap / P + 1e-9);
    const rest = cap - k * P;
    let n = 0, cost = k * M, value = k * P;
    if (fill && rest > 1e-9) { n = Math.ceil(rest / fill.pack - 1e-9); cost += n * fill.cost; value += n * fill.pack; }
    Object.assign(res, { fits: true, k, n, cost: cost + fee, worth: Math.min(cap, value), unfilled: Math.max(0, cap - value) });
  }
  res.crate = res.cost - res.worth;      // what you pay above the crate's worth, packing included
  res.sellAt = res.cost;                 // the sale that pays it all back
  return res;
}
const packFee = () => (num(S.packFee) != null && S.packFee >= 0 ? S.packFee : DEFAULTS.packFee);
// a crate sells for its worth + 25 gr a km (in a straight line, at an ordinary need, fresh), 150 gr at most
const GAIN_PER_KM = 25, GAIN_MAX = 150;
function sellAtHtml(cost, worth) {
  if (cost == null) return "—";
  const need = cost - worth;
  let sub;
  if (need <= 0.05) sub = "окупится в любом городе";
  else if (need > GAIN_MAX) sub = `+${fmt(need, 0)} — больше, чем даёт любой путь (до ${GAIN_MAX})`;
  else sub = `+${fmt(need, 0)} · ≈ ${fmt(need / GAIN_PER_KM, 1)} км`;
  return `${fmt(cost, 0)} гр.<span class="en">${sub}</span>`;
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
  const f = x.n && x.fillKey ? ` + ${esc(MAT()[x.fillKey].ru.toLowerCase())} ×${x.n}` : "";
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
  { key: "sellAt", t: "Продать ящик от", n: true, v: (x) => x.sellAt },
];

function render() {
  resetMemo();
  const C = CRAFT(), fill = filler(), cap = capOf();
  const excl = new Set(S.excl);
  const inCraft = DATA.recipes.filter((r) => r.craft === C.id && !r.aux && r.level >= MIN_LEVEL && r.level <= MAX_LEVEL).map((r) => evaluate(r, fill, cap));
  // levels where at least one piece fits the pack
  const levels = [...new Set(inCraft.filter((x) => !x.na && x.fits).map((x) => x.r.level))].sort((a, b) => a - b);
  const all = inCraft.filter((x) => levels.includes(x.r.level));
  for (const x of all) x.excluded = [...usedBy(x.r)].some((k) => excl.has(k));
  // the materials this craft uses (the prices tab and the prices window show only them)
  const used = new Set(C.pack.goods.filter((k) => MAT()[k]));
  for (const x of inCraft) for (const k of usedBy(x.r)) used.add(k);
  DATA.used = used;
  renderHead(C, cap, fill, levels);

  // best per level
  let bh = "<tr><th></th><th>Ур.</th><th>Предмет</th><th class='n'>Себестоимость</th><th class='n'>В груз</th><th class='n'>КПД</th><th class='n'>Потеря за шт.</th><th>Ящик</th><th class='n'>Потеря ящика</th><th class='n'>Продать ящик от</th></tr>";
  for (const L of levels) {
    const c = all.filter((x) => x.r.level === L && !x.na && x.fits && !x.excluded && !x.r.en.startsWith("jobtool"));
    if (!c.length) { bh += `<tr class="na"><td></td><td class="n">${L}</td><td colspan="8">ни один доступный предмет не помещается в ящик</td></tr>`; continue; }
    c.sort((a, b) => b.eff - a.eff || b.P - a.P);
    const x = c[0];
    bh += `<tr><td>${addBtn(x)}</td><td class="n">${L}</td><td>${nameCell(x.r)}</td><td class="n">${fmt(x.M)}</td><td class="n">${fmt(x.P)}${x.guess ? " " + GUESS_TAG : ""}</td><td class="n ${effClass(x.eff)}">${fmt(x.eff * 100)}%</td><td class="n">${fmt(x.loss)}</td><td>${crateText(x)}</td><td class="n">${fmt(x.crate)}</td><td class="n">${sellAtHtml(x.sellAt, x.worth)}</td></tr>`;
  }
  if (!levels.length) bh += `<tr class="na"><td colspan="10">Нет цен на материалы этого ремесла — впишите их на вкладке «Материалы и цены».</td></tr>`;
  if (fill) {
    const nb = Math.ceil(cap / fill.pack - 1e-9), fc = nb * fill.cost + packFee();
    bh += `<tr><td></td><td></td><td colspan="8" class="src-tag">Для сравнения: груз из одного товара «${esc(MAT()[fill.key].ru)}» — ${nb} шт., потеря ${fmt(fc - cap)} гр. с упаковкой, продать от ${fmt(fc, 0)} гр.</td></tr>`;
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
      <td class="n">${fmt(x.r.fee / x.r.yield)}</td><td class="n">${fmt(x.M)}</td><td class="n">${fmt(x.P)}${x.guess ? " " + GUESS_TAG : ""}</td>
      <td class="n ${effClass(x.eff)}">${x.eff != null ? fmt(x.eff * 100) + "%" : "—"}</td><td class="n">${fmt(x.loss)}</td>
      <td>${crateText(x)}</td><td class="n">${fmt(x.crate)}</td><td class="n">${x.na ? "—" : sellAtHtml(x.sellAt, x.worth)}</td></tr>`;
    if (open.has(x.r.id)) h += `<tr class="detail"><td></td><td></td><td colspan="${COLS.length - 1}">${breakdown(x.r)}</td></tr>`;
  }
  if (!rows.length) h += `<tr><td colspan="${COLS.length + 1}" class="src-tag">Нет рецептов под эти фильтры.</td></tr>`;
  $("recipes").innerHTML = h;

  // recipes hidden for want of a price, and the materials to blame
  const hidden = all.filter((x) => x.na && !x.excluded);
  let hint = "";
  if (hidden.length) {
    const miss = new Map();
    for (const x of hidden) for (const k of usedBy(x.r)) if (costOf(k).v == null && !(MAT()[k].recipe)) miss.set(k, (miss.get(k) || 0) + 1);
    const list = [...miss.entries()].sort((a, b) => b[1] - a[1]);
    const wild = list.filter(([k]) => WILD.includes(k) && ov(k).mode !== "self");
    hint = `<b>${hidden.length} рецепт(ов) без цены</b>${S.hideNA ? " скрыто" : ""}: нет цены на ${esc(list.slice(0, 10).map(([k]) => MAT()[k].ru.toLowerCase()).join(", "))}${list.length > 10 ? "…" : ""}. ` +
      `Впишите цены на вкладке «Материалы и цены»${S.hideNA ? " или снимите галочку «скрыть недоступные»" : ""}.` +
      (wild.length ? ` <button type="button" id="wildSelf">Дикие травы — собираю сам (0 гр.)</button>` : "");
  }
  $("naHint").innerHTML = hint;
  $("naHint").hidden = !hint;
  $("excluded").innerHTML = S.excl.filter((k) => used.has(k)).map((k) => `<span class="chip x" data-k="${esc(k)}">${esc(MAT()[k] ? MAT()[k].ru : k)}</span>`).join("");
  renderPrices();
  renderCart();
  renderRoute(fill, cap);
}

const STOCK_RU = ["еда", "древесина и топливо", "металл", "ткань и кожа", "роскошь"];
function renderHead(C, cap, fill, levels) {
  const sel = $("craft");
  const opts = DATA.crafts.map((c) => `<option value="${c.id}">${esc(c.ru)}</option>`).join("");
  if (sel.dataset.opts !== opts) { sel.innerHTML = opts; sel.dataset.opts = opts; }
  sel.value = C.id;
  document.title = `${C.ru} → торговый груз · KCD Roleplay`;
  const lvTxt = levels.length ? `${levels[0]}–${levels[levels.length - 1]}` : "—";
  $("craftSub").textContent = `Себестоимость каждого предмета ремесла «${C.ru}» ${lvTxt} уровней, сколько он засчитывается в груз «${C.pack.ru}» и сколько вы теряете, если добивать груз самым выгодным товаром. Сервер: KCD Roleplay [RU].`;
  const src = { wiki: "по вики сервера", game: "по окну упаковки в игре", guess: "<b>не проверено</b>: в вики этого груза нет, состав и стоимость — предположение" }[C.pack.source] || "";
  $("packInfo").innerHTML = `<b>${esc(C.pack.ru)}</b>: ${fmt(C.pack.worth, 0)} гр. · пополняет склад «${STOCK_RU[C.pack.stock]}» · свежесть: ${esc(C.pack.fresh)} · ${src}.` +
    `<span class="en">Принимает: ${esc(C.pack.goods.filter((k) => MAT()[k]).map((k) => MAT()[k].ru.toLowerCase()).join(", "))} и предметы этого ремесла.</span>`;
  // the level chips: only levels that have a piece that fits
  if (S.level !== "all" && !levels.includes(+S.level)) S.level = "all";
  $("levels").innerHTML = ["all", ...levels].map((l) => `<span class="chip${String(S.level) === String(l) ? " on" : ""}" data-l="${l}">${l === "all" ? "все уровни" : l}</span>`).join("");
  // the crate size and the filler of this craft
  $("cap").value = cap;
  const goods = C.pack.goods.filter((k) => MAT()[k]).sort((a, b) => MAT()[a].ru.localeCompare(MAT()[b].ru, "ru"));
  const auto = S.fillers[C.id] === undefined;
  const fo = `<option value="__auto">авто${auto && fill ? ": " + esc(MAT()[fill.key].ru.toLowerCase()) : ""}</option><option value="">ничем</option>` +
    goods.map((k) => `<option value="${esc(k)}">${esc(MAT()[k].ru)}</option>`).join("");
  $("filler").innerHTML = fo;
  $("filler").value = auto ? "__auto" : S.fillers[C.id];
}

const SRC = { auction: "аукцион", craft: "сделать", price: "ваша цена", self: "собрать самому" };

function breakdown(r) {
  let h = `<table class="sub-table"><tr><th>Материал</th><th class="n">Кол-во</th><th>Откуда</th><th class="n">Цена за шт.</th><th class="n">Себестоимость</th><th class="n">В груз за шт.</th><th class="n">В груз</th></tr>`;
  for (const [k, q] of Object.entries(r.items)) {
    const c = costOf(k), p = packOf(k);
    h += `<tr><td>${matName(k)}</td><td class="n">${q}</td><td class="src-tag">${c.src ? SRC[c.src] : "нет цены"}</td>
      <td class="n">${fmt(c.v, 2)}</td><td class="n">${fmt(c.v != null ? c.v * q : null)}</td><td class="n">${fmt(p, 2)}</td><td class="n">${fmt(p != null ? p * q : null)}</td></tr>`;
  }
  const fm = FEE_IN_PACK(r);
  h += `<tr><td>Плата станка</td><td></td><td></td><td></td><td class="n">${fmt(r.fee)}</td><td class="n src-tag">${fm > 1 ? "×" + fm : ""}</td><td class="n">${fmt(packFeeOf(r))}</td></tr>`;
  if (fm > 1) h += `<tr><td colspan="7" class="src-tag">У кузнечных предметов 4-го уровня сервер засчитывает плату станка в груз дважды (проверено в игре).</td></tr>`;
  if (r.yield > 1) h += `<tr><td colspan="7" class="src-tag">Выход ${r.yield} шт. — итог делится на ${r.yield}.</td></tr>`;
  const own = S.itemPack && S.itemPack[r.id];
  h += `<tr><td colspan="7" class="item-pack">В груз по игре за 1 шт.: <input type="number" step="0.5" min="0" data-ipack="${esc(r.id)}" value="${own != null ? own : ""}" placeholder="как в «Будет взято»"> <span class="src-tag">${own != null ? "сайт считает этот предмет по вашему числу — очистите поле, чтобы вернуть расчёт" : "впишите, если в игре другое число"}</span></td></tr>`;
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
  if (m.kind === "manual") o.push(["self", "собрать самому (0 гр.)"]);
  return `<select data-k="${esc(key)}" data-f="mode">${o.map(([v, t]) => `<option value="${v}"${v === cur ? " selected" : ""}>${t}</option>`).join("")}</select>`;
}
function exclBox(key) { return `<input type="checkbox" data-k="${esc(key)}" data-f="excl"${S.excl.includes(key) ? " checked" : ""}>`; }

function renderPrices() {
  const keys = Object.keys(MAT()).filter((k) => !DATA.used || DATA.used.has(k)).sort((a, b) => MAT()[a].ru.localeCompare(MAT()[b].ru, "ru"));
  const goods = keys.filter((k) => MAT()[k].kind === "good");
  const parts = keys.filter((k) => MAT()[k].kind === "part");
  const manual = keys.filter((k) => MAT()[k].kind === "manual");
  let g = `<tr><th>Товар</th><th class="n">Аукцион ср.</th><th class="n">Аукцион мин.</th><th class="n">Продано</th><th class="n">Покупка</th><th class="n">В груз</th><th>Способ</th><th class="n">Итого за шт.</th><th>искл.</th></tr>`;
  for (const k of goods) {
    const m = MAT()[k], a = SERVER.auction[m.id] || {}, c = costOf(k);
    g += `<tr><td>${matName(k)}</td><td class="n">${fmt(a.avg, 2)}</td><td class="n">${fmt(a.low, 2)}</td><td class="n">${a.sold != null ? fmt(a.sold, 0) : "—"}</td>
      <td class="n">${priceInput(k, "buy", serverAuction(m.id))}</td><td class="n">${priceInput(k, "pack", serverPack(m.id))} ${num(ov(k).pack) != null ? '<span class="src-tag">ваша</span>' : PACK_SRC_TAG[packSource(m.id)]}</td>
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
  let mh = `<tr><th>Материал</th><th class="n">Аукцион ср.</th><th class="n">Покупка</th><th class="n">В груз</th><th class="n">Итого за шт.</th><th>искл.</th></tr>`;
  for (const k of manual) {
    const c = costOf(k), m = MAT()[k], a = m.auctionItem ? SERVER.auction[m.auctionItem] || {} : {};
    mh += `<tr><td>${matName(k)}</td><td class="n">${fmt(a.avg, 2)}</td><td class="n">${priceInput(k, "buy", m.auctionItem ? serverAuction(m.auctionItem) : null)}</td><td class="n">${priceInput(k, "pack", null)}</td>
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
  const r = recipeById(id), x = r && evaluate(r, fillerFor(r.craft));
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

function cartPlan() {
  const lines = [], crates = [], crafts = [], demand = new Map();
  const add = (k, q) => demand.set(k, (demand.get(k) || 0) + q);
  let fees = 0, missing = [];
  for (const l of S.cart) {
    const r = recipeById(l.id);
    if (!r) continue;
    // each piece goes into its own craft's pack, topped up with that pack's filler
    const fill = fillerFor(r.craft), cap = capOf(r.craft);
    const x = evaluate(r, fill, cap), qty = Math.max(0, Math.floor(l.qty) || 0);
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
      crates.push({ id: l.id, r, items, fill: fillN, fillKey: fill ? fill.key : null, fillCost: fill ? fill.cost : 0, cap,
        value: Math.min(cap, value + fillN * (fill ? fill.pack : 0)), burn: x.fits ? 0 : value - cap,
        cost: items * x.M + (fill ? fillN * fill.cost : 0) + packFee() });
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
  // the fillers, by good
  const fills = new Map();
  for (const c of crates) if (c.fill && c.fillKey) {
    const f = fills.get(c.fillKey) || { n: 0, cost: c.fillCost };
    f.n += c.fill; fills.set(c.fillKey, f);
  }
  const fillTotal = [...fills.values()].reduce((t, f) => t + f.n, 0);
  const buy = [...demand.entries()].map(([k, q]) => ({ k, q, c: costOf(k) }))
    .sort((a, b) => MAT()[a.k].ru.localeCompare(MAT()[b.k].ru, "ru"));
  let cost = fees;
  for (const b of buy) cost += b.c.v != null ? b.c.v * b.q : 0;
  for (const f of fills.values()) cost += f.n * f.cost;
  const packing = crates.length * packFee();
  cost += packing;
  const value = crates.reduce((t, c) => t + c.value, 0);
  return { lines, crates, crafts, buy, fees, fills, fillTotal, packing, cost, value, missing };
}

function renderCart() {
  const box = $("cart");
  $("cartCount").textContent = S.cart.length ? `Корзина: ${S.cart.length}` : "Корзина пуста";
  if (!S.cart.length) { box.innerHTML = '<p class="hint">Нажмите «+» у предмета в таблицах ниже — он добавится на один ящик. Количество можно поменять здесь.</p>'; return; }
  const p = cartPlan();
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
    const isFill = p.fills.has(b.k);
    h += `<tr><td>${matName(b.k, isFill ? " <span class='src-tag'>(в рецепты)</span>" : "")}</td><td class="n">${fmt(b.q, 2)}</td>
      <td class="src-tag">${b.c.src ? SRC[b.c.src] : '<span class="tag na">нет цены</span>'}</td><td class="n">${fmt(b.c.v, 2)}</td><td class="n">${fmt(b.c.v != null ? b.c.v * b.q : null)}</td></tr>`;
  }
  for (const [fk, f] of p.fills) {
    h += `<tr><td>${matName(fk, ' <span class="src-tag">(добивка ящиков)</span>')}</td><td class="n">${f.n}</td><td class="src-tag">${SRC[costOf(fk).src] || ""}</td><td class="n">${fmt(f.cost, 2)}</td><td class="n">${fmt(f.cost * f.n)}</td></tr>`;
    const inRec = (p.buy.find((b) => b.k === fk) || {}).q || 0;
    if (inRec) h += `<tr class="total"><td>${esc(MAT()[fk].ru)} всего</td><td class="n">${fmt(inRec + f.n, 2)}</td><td colspan="3"></td></tr>`;
  }
  h += `<tr><td>Плата станков</td><td></td><td></td><td></td><td class="n">${fmt(p.fees)}</td></tr>`;
  if (p.crates.length) h += `<tr><td>Упаковка ящиков</td><td class="n">${p.crates.length}</td><td></td><td class="n">${fmt(packFee())}</td><td class="n">${fmt(p.packing)}</td></tr>`;
  h += `</table>`;
  // totals
  const loss = p.cost - p.value;
  h += `<table class="sub-table totals"><tr><td>Ящиков</td><td class="n">${p.crates.length}</td></tr>
    <tr><td>Потратите всего</td><td class="n">${fmt(p.cost)} гр.</td></tr>
    <tr><td>Засчитается в грузы</td><td class="n">${fmt(p.value)} гр.</td></tr>
    <tr><td>Потеря без учёта прибыли с дороги</td><td class="n ${loss > 0.5 ? "bad" : "good"}">${fmt(loss)} гр.</td></tr>
    <tr><td>Продать все ящики минимум за</td><td class="n">${fmt(p.cost, 0)} гр.</td></tr></table>`;
  if (p.missing.length) h += `<p class="hint bad">Нет цены для: ${esc(p.missing.join(", "))} — они не посчитаны.</p>`;
  h += `</div></div>`;
  // crates
  h += `<h3>По ящикам</h3><ol class="crates">`;
  p.crates.forEach((c, i) => {
    h += `<li><button type="button" class="crate-del" data-crdel="${esc(c.id)}" data-items="${c.items}" title="Убрать этот ящик">×</button><span class="crate-no">${i + 1}.</span> ${esc(c.r.ru || c.r.en)} ×${c.items}${c.fill ? ` + ${esc(MAT()[c.fillKey].ru.toLowerCase())} ×${c.fill}` : ""} — ${fmt(c.value)} гр. в грузе, <b>продать от ${fmt(c.cost, 0)}</b> <span class="src-tag">(${c.cost - c.value > GAIN_MAX ? `+${fmt(c.cost - c.value, 0)}, дорога столько не даст` : `+${fmt(Math.max(0, c.cost - c.value), 0)} ≈ ${fmt(Math.max(0, c.cost - c.value) / GAIN_PER_KM, 1)} км`})</span>${c.burn > 0 ? ` <span class="tag burn">сгорит ${fmt(c.burn, 0)}</span>` : ""}</li>`;
  });
  h += `</ol><p class="cart-actions"><button type="button" id="cartCopy">Скопировать список</button> <button type="button" class="ghost" id="cartClear">Очистить корзину</button> <span id="cartMsg" class="src-tag"></span></p>`;
  box.innerHTML = h;
  box.dataset.text = cartText(p);
}

function cartText(p) {
  const L = [];
  L.push("Сделать:");
  for (const { r, qty } of p.lines) L.push(`  ${r.ru || r.en} — ${qty} шт.`);
  const inner = p.crafts.filter((c) => !c.top);
  if (inner.length) { L.push("По пути:"); for (const c of inner.slice().reverse()) L.push(`  ${MAT()[c.key].ru} — ${c.n} раз (${c.made} шт.)`); }
  L.push("Взять:");
  for (const b of p.buy) L.push(`  ${MAT()[b.k].ru}${p.fills.has(b.k) ? " (в рецепты)" : ""} — ${fmt(b.q, 2)}`);
  for (const [fk, f] of p.fills) L.push(`  ${MAT()[fk].ru} (добивка) — ${f.n}`);
  L.push(`Плата станков: ${fmt(p.fees)} гр. · Упаковка: ${fmt(p.packing)} гр. · Потратите: ${fmt(p.cost)} гр. · Ящиков: ${p.crates.length}`);
  L.push("По ящикам:");
  p.crates.forEach((c, i) => L.push(`  ${i + 1}. ${c.r.ru || c.r.en} ×${c.items}${c.fill ? ` + ${MAT()[c.fillKey].ru.toLowerCase()} ×${c.fill}` : ""} — продать от ${fmt(c.cost, 0)} гр.`));
  return L.join("\n");
}


// ---------------------------------------------------------------- market prices window
function renderPricesDialog() {
  const q = $("pricesSearch").value.trim().toLowerCase();
  const smith = $("pricesSmith").checked;
  const used = DATA.used || new Set(Object.keys(MAT()));
  const smithIds = new Set([...used].map((k) => MAT()[k]).filter((m) => m && (m.kind === "good" || m.auctionItem)).map((m) => (m.kind === "good" ? m.id : m.auctionItem)));
  const ids = new Set([...Object.keys(SERVER.market), ...Object.keys(SERVER.auction)]);
  const ruOf = (id) => {
    const m = Object.values(MAT()).find((x) => (x.kind === "good" && x.id === id) || x.auctionItem === id);
    const a = SERVER.auction[id];
    const n = m ? m.ru : a && a.name ? a.name : id;
    return n.charAt(0).toUpperCase() + n.slice(1);
  };
  const iconOf = (id) => (Object.values(MAT()).find((x) => (x.kind === "good" && x.id === id) || x.auctionItem === id) || {}).icon;
  let rows = [...ids].map((id) => ({ id, ru: ruOf(id), m: SERVER.market[id] || {}, a: SERVER.auction[id] || {} }))
    .filter((x) => (!smith || smithIds.has(x.id)) && (!q || x.ru.toLowerCase().includes(q) || x.id.includes(q)))
    .sort((x, y) => x.ru.localeCompare(y.ru, "ru"));
  let h = `<tr><th>Товар</th><th class="n">Рыночная цена</th><th class="n">Аукцион ср.</th><th class="n">Аукцион мин.</th><th class="n">В груз*</th><th class="n">Выставлено</th><th class="n">Продано</th></tr>`;
  for (const x of rows) {
    const pack = serverPack(x.id);
    h += `<tr><td><span class="mn">${iconHtml(iconOf(x.id), x.ru, "ico sm")}<span>${esc(x.ru)}</span></span></td><td class="n">${fmt(num(x.m.price) > 0 ? x.m.price : null, 2)}</td>
      <td class="n">${fmt(num(x.a.avg) > 0 ? x.a.avg : null, 2)}</td><td class="n">${fmt(num(x.a.low) > 0 ? x.a.low : null, 2)}</td><td class="n">${fmt(pack, 2)}${pack != null ? " " + PACK_SRC_TAG[packSource(x.id)] : ""}</td>
      <td class="n">${x.a.qty != null ? fmt(x.a.qty, 0) : "—"}</td><td class="n">${x.a.sold != null ? fmt(x.a.sold, 0) : "—"}</td></tr>`;
  }
  if (!rows.length) h += `<tr><td colspan="7" class="src-tag">Ничего не найдено.</td></tr>`;
  $("pricesTable").innerHTML = h;
  $("pricesInfo").innerHTML = (SERVER.updated ? `Данные сервера от ${new Date(SERVER.updated).toLocaleString("ru-RU")} · ${esc(SERVER.label)}. ` : "Цены сервера не загружены. ") +
    "<b>«Аукцион»</b> — цены игроков (средняя за неделю и самая низкая сейчас). <b>«Рыночная цена»</b> — оценка сервера, как он её считает, не описано. <b>«В груз»</b> — сколько одна штука засчитывается в стоимость торгового ящика. " +
    "* Точной цены в грузе API сервера не даёт: здесь оценка (поле <code>instant</code> аукциона или значение из окна упаковки, иначе рыночная цена). " +
    "Для кузнечного сырья она совпадает с игрой, для товаров других ремёсел может отличаться — точное число видно в окне упаковки («Что принести»). «—» — нет данных. Цены сервера без ваших правок.";
}


// ---------------------------------------------------------------- where to take the crates
const TOWN_RU = {
  "Kuttenberg": "Кутна-Гора", "Suchdol": "Сухдол", "Miskowitz": "Мышковицы", "Grund": "Грунта", "Pschitoky": "Пржитоки",
  "Sigismund's camp": "Лагерь Сигизмунда", "Maleshov": "Малешов", "Bylany": "Биланы", "Raborsch": "Ратборж",
  "Opatowitz": "Опатовицы", "Devil's Den": "Чёртово логово", "Old Kutna": "Стара-Кутна", "Bohunowitz": "Богуновице",
  "Wysoka": "Высока", "Horschan": "Горжаны",
};
const STOCKS = ["еда", "древесина и топливо", "металл", "ткань и кожа", "роскошь"];
const townRu = (n) => TOWN_RU[n] || n;
// the wiki gives three points: an empty stock x1.4, half full about x0.85, full x0.6; this curve passes through them
const needOf = (lv) => { const x = Math.min(1, Math.max(0, lv / 100)); return 1.4 - 1.4 * x + 0.6 * x * x; };
const MIN_KM = 1.5;

function routeGain(km, lv) {
  return Math.min(GAIN_MAX, GAIN_PER_KM * km * needOf(lv));
}

// one route: from the packing town to a selling town
function routeEval(from, to, k, cut, plan, crates) {
  const km = Math.hypot(to.x - from.x, to.y - from.y) / 1000;
  const lv = to.lv ? to.lv[k] : null;
  const noStore = !to.lv || to.lv.every((v) => !v);       // a camp without a warehouse
  const ok = to.name !== from.name && km >= MIN_KM && !to.paused && !noStore;
  const gain = ok ? routeGain(km, lv) * cut : null;
  let profit = null;
  if (ok && plan && crates.length) {
    // a crate worth under 300 gr earns its gain in proportion
    profit = crates.reduce((s, c) => s + c.value + gain * Math.min(1, c.value / 300), 0) - plan.cost;
  }
  const why = to.name === from.name ? "город упаковки" : noStore ? "склад не ведётся" : to.paused ? "не покупает" : km < MIN_KM ? `ближе ${MIN_KM} км` : "";
  return { from, t: to, km, lv, noStore, ok, gain, profit, why };
}

function routeCard(title, list, coalCost, hasCart, cap, fillName) {
  if (!list.length) return `<div class="rb-card"><h4>${title}</h4><p class="src-tag">Нет маршрутов, где можно продать.</p></div>`;
  const li = list.map((x, i) => {
    const coal = coalCost != null ? cap + x.gain - coalCost : null;
    return `<li><span class="rb-no">${i + 1}</span><div><b>${esc(townRu(x.from.name))} → ${esc(townRu(x.t.name))}</b>
      <span class="en">${fmt(x.km, 1)} км · склад ${fmt(x.lv, 0)}% · нужда ×${fmt(needOf(x.lv), 2)}</span>
      <span class="rb-nums">+${fmt(x.gain, 0)} гр. за ящик${coal != null ? ` · груз «${esc(fillName)}» <span class="${coal >= 0 ? "good" : "bad"}">${coal >= 0 ? "+" : ""}${fmt(coal, 0)}</span>` : ""}${hasCart ? ` · корзина <span class="${x.profit >= 0 ? "good" : "bad"}">${x.profit >= 0 ? "+" : ""}${fmt(x.profit, 0)}</span>` : ""}</span></div></li>`;
  }).join("");
  return `<div class="rb-card"><h4>${title}</h4><ol>${li}</ol></div>`;
}

function renderRoute(fill, cap) {
  const towns = SERVER.towns || [];
  const sel = $("routeOrigin");
  if (!towns.length) {
    $("route").innerHTML = "";
    $("routeBest").innerHTML = "";
    $("routeInfo").textContent = "Данных о городах в загруженных ценах нет — нажмите «Обновить цены» чуть позже.";
    return;
  }
  const names = towns.map((t) => t.name);
  if (!names.includes(S.origin)) S.origin = names[0];
  const opts = towns.slice().sort((a, b) => townRu(a.name).localeCompare(townRu(b.name), "ru"))
    .map((t) => `<option value="${esc(t.name)}"${t.name === S.origin ? " selected" : ""}>${esc(townRu(t.name))}</option>`).join("");
  if (sel.dataset.opts !== opts) { sel.innerHTML = opts; sel.dataset.opts = opts; }
  sel.value = S.origin;
  $("routeStock").value = String(S.stock);
  $("routeHire").checked = !!S.hire;

  const o = towns.find((t) => t.name === S.origin);
  const k = +S.stock, cut = S.hire ? 0.85 : 1;
  const plan = S.cart.length ? cartPlan() : null;
  const crates = plan ? plan.crates.filter((c) => c.value > 0) : [];
  const hasCart = !!(plan && crates.length);
  const better = (a, b) => (b.ok - a.ok) || (hasCart ? (b.profit ?? -1e9) - (a.profit ?? -1e9) : (b.gain ?? -1) - (a.gain ?? -1)) || a.km - b.km;
  const rows = towns.map((t) => routeEval(o, t, k, cut, plan, crates));
  rows.sort(better);

  const coalCost = fill ? Math.ceil(cap / fill.pack - 1e-9) * fill.cost + packFee() : null;
  const fillName = fill ? MAT()[fill.key].ru.toLowerCase() : "";
  // the three best routes between any two towns that keep a warehouse
  const all = [];
  for (const a of towns) {
    if (!a.lv || a.lv.every((v) => !v)) continue;
    for (const b of towns) { const x = routeEval(a, b, k, cut, plan, crates); if (x.ok) all.push(x); }
  }
  all.sort(better);
  $("routeBest").innerHTML = routeCard("Лучшие 3 маршрута", all.slice(0, 3), coalCost, hasCart, cap, fillName);
  let h = `<tr><th>Город</th><th class="n">Расстояние</th><th class="n">Склад «${esc(STOCKS[k])}»</th><th class="n">Нужда ≈</th><th class="n">Прибыль с дороги за ящик</th><th class="n">Заплатят за полный груз (${fmt(cap, 0)})</th>`;
  if (coalCost != null) h += `<th class="n">Груз «${esc(fillName)}»: итог</th>`;
  if (hasCart) h += `<th class="n">Ваша корзина (${crates.length} ящ.): итог</th>`;
  h += `</tr>`;
  for (const x of rows) {
    const need = x.lv != null && !x.noStore ? needOf(x.lv) : null;
    const lvCls = x.lv == null || x.noStore ? "" : x.lv < 34 ? "good" : x.lv < 67 ? "mid" : "bad";
    h += `<tr class="${x.ok ? "" : "na"}"><td>${esc(townRu(x.t.name))}${x.why ? ` <span class="tag na">${esc(x.why)}</span>` : ""}${x.t.needs && x.t.needs.length ? `<span class="en">нуждается: ${esc(x.t.needs.map((n) => ({ food: "еда", timber: "древесина", metal: "металл", cloth: "ткань и кожа", luxury: "роскошь" }[n] || n)).join(", "))}</span>` : ""}</td>
      <td class="n">${x.t.name === S.origin ? "—" : fmt(x.km, 1) + " км"}</td>
      <td class="n ${lvCls}">${x.noStore ? "—" : fmt(x.lv, 0) + "%"}</td><td class="n">${need != null ? "×" + fmt(need, 2) : "—"}</td>
      <td class="n">${x.ok ? "+" + fmt(x.gain, 0) + " гр." + (x.gain >= GAIN_MAX * cut - 0.5 ? ' <span class="src-tag">(максимум)</span>' : "") : "—"}</td>
      <td class="n">${x.ok ? fmt(cap + x.gain, 0) + " гр." : "—"}</td>`;
    if (coalCost != null) {
      const v = x.ok ? cap + x.gain - coalCost : null;
      h += `<td class="n ${v == null ? "" : v >= 0 ? "good" : "bad"}">${v == null ? "—" : (v >= 0 ? "+" : "") + fmt(v, 0)}</td>`;
    }
    if (hasCart) h += `<td class="n ${x.profit == null ? "" : x.profit >= 0 ? "good" : "bad"}">${x.profit == null ? "—" : (x.profit >= 0 ? "+" : "") + fmt(x.profit, 0) + " гр."}</td>`;
    h += `</tr>`;
  }
  $("route").innerHTML = h;
  $("routeInfo").innerHTML =
    `Склады — данные сервера на ${SERVER.townsUpdated ? new Date(SERVER.townsUpdated).toLocaleString("ru-RU", { hour: "2-digit", minute: "2-digit", day: "numeric", month: "short" }) : "—"}, расстояния — по прямой между центрами городов. ` +
    `«Итог» — сколько вы заработаете после продажи: стоимость ящиков + прибыль с дороги − все затраты (материалы, станки, добивка, упаковка ${fmt(packFee(), 0)} гр.). ` +
    (hasCart ? "" : "Добавьте предметы в корзину, чтобы увидеть итог по ним. ") +
    `Склад и груз — для ремесла «${esc(CRAFT().ru)}». Не учтено: маршрут дня (×1,1), свежесть груза, дневной лимит прибыли, точное место вашего верстака. Множитель нужды — оценка по вики.`;
}

// ---------------------------------------------------------------- tabs
const TABS = ["items", "prices", "route"];
function showTab(t, push = true) {
  if (!TABS.includes(t)) t = "items";
  S.tab = t; save();
  for (const x of TABS) {
    $("tab-" + x).hidden = x !== t;
    const b = document.querySelector(`.tab[data-tab="${x}"]`);
    if (b) { b.classList.toggle("on", x === t); b.setAttribute("aria-selected", x === t ? "true" : "false"); }
  }
  if (push && location.hash !== "#" + t) history.replaceState(null, "", "#" + t);
}

// ---------------------------------------------------------------- events
function bind() {
  const fromHash = location.hash.slice(1);
  showTab(TABS.includes(fromHash) ? fromHash : S.tab, false);
  for (const b of document.querySelectorAll(".tab")) b.onclick = () => showTab(b.dataset.tab);
  window.addEventListener("hashchange", () => showTab(location.hash.slice(1), false));
  $("cartCount").onclick = () => showTab("items");
  $("routeOrigin").onchange = (e) => { S.origin = e.target.value; save(); render(); };
  $("routeStock").onchange = (e) => { S.stock = +e.target.value; save(); render(); };
  $("routeHire").onchange = (e) => { S.hire = e.target.checked; save(); render(); };
  $("buySource").value = S.buySource;
  $("packFee").value = packFee();
  $("search").value = S.search;
  $("onlyFit").checked = S.onlyFit;
  $("hideNA").checked = S.hideNA;
  $("hideParts").checked = S.hideParts;
  $("craft").onchange = (e) => {
    S.craft = e.target.value;
    S.stock = CRAFT().pack.stock;   // the route tab follows the craft's pack
    S.level = "all"; open = new Set();
    save(); render();
  };

  const set = (k, v) => { S[k] = v; save(); render(); };
  $("buySource").onchange = (e) => set("buySource", e.target.value);
  $("cap").onchange = (e) => {
    const v = Math.max(1, +e.target.value || 0);
    S.caps = Object.assign({}, S.caps);
    if (!v || v === CRAFT().pack.worth) delete S.caps[S.craft]; else S.caps[S.craft] = v;
    save(); render();
  };
  $("packFee").onchange = (e) => { S.packFeeSet = true; set("packFee", Math.max(0, +e.target.value || 0)); };
  $("filler").onchange = (e) => {
    S.fillers = Object.assign({}, S.fillers);
    if (e.target.value === "__auto") delete S.fillers[S.craft]; else S.fillers[S.craft] = e.target.value;
    save(); render();
  };
  $("search").oninput = (e) => set("search", e.target.value);
  $("onlyFit").onchange = (e) => set("onlyFit", e.target.checked);
  $("hideNA").onchange = (e) => set("hideNA", e.target.checked);
  $("hideParts").onchange = (e) => set("hideParts", e.target.checked);
  $("levels").onclick = (e) => { const l = e.target.dataset.l; if (l) { S.level = l; save(); render(); } };
  $("excluded").onclick = (e) => { const k = e.target.dataset.k; if (k) set("excl", S.excl.filter((x) => x !== k)); };
  $("recipes").addEventListener("change", (e) => {
    const id = e.target.dataset.ipack;
    if (id == null) return;
    S.itemPack = Object.assign({}, S.itemPack);
    if (e.target.value === "") delete S.itemPack[id]; else S.itemPack[id] = Math.max(0, +e.target.value);
    save(); render();
  });
  $("recipes").onclick = (e) => {
    if (e.target.dataset.ipack != null) return;
    if (onAdd(e)) return;
    const th = e.target.closest("th.sort");
    if (th) { const k = th.dataset.k; S.sort = { key: k, dir: S.sort.key === k ? -S.sort.dir : (k === "name" || k === "level" ? 1 : -1) }; save(); render(); return; }
    const tr = e.target.closest("tr.r");
    if (tr) { const id = tr.dataset.id; open.has(id) ? open.delete(id) : open.add(id); render(); }
  };
  const onAdd = (e) => { const b = e.target.closest("button[data-add]"); if (b) { addToCart(b.dataset.add); return true; } return false; };
  $("best").onclick = (e) => { onAdd(e); };
  $("naHint").onclick = (e) => {
    if (e.target.id !== "wildSelf") return;
    for (const k of WILD) if (MAT()[k]) S.ov[k] = Object.assign({}, S.ov[k], { mode: "self" });
    save(); render();
  };
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
  const r = await fetch("data/crafts.json");
  DATA = await r.json();
  DATA.byName = new Map();
  for (const x of DATA.recipes) { if (!DATA.byName.has(x.en)) DATA.byName.set(x.en, []); DATA.byName.get(x.en).push(x); }
  if (!DATA.crafts.some((c) => c.id === S.craft)) S.craft = DATA.crafts[0].id;
  DATA.partNames = new Set(Object.entries(DATA.materials).filter(([, m]) => m.kind === "part" || m.recipe).map(([k]) => k));
  bind();
  await refresh(false);
  setInterval(() => refresh(true), 10 * 60 * 1000);   // the copy changes every 30 minutes
  setInterval(showStatus, 60 * 1000);
}
main();
