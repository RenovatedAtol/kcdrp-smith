#!/usr/bin/env python3
"""Build data/crafts.json - every craft's recipes and trade pack - from the KCD Roleplay wiki.

Usage:
  python3 -I tools/build_crafts.py WIKI_RECIPES_HTML REALM_JSON DANEK_DATA_JS DANEK_RICON_JS --icons data/icons > data/crafts.json

WIKI_RECIPES_HTML  saved https://wiki.kcdroleplay.com/recipes/
REALM_JSON         saved https://account.kcdroleplay.com/api/ucp/realm?world=ru (the goods' ids and names)
DANEK_DATA_JS      saved https://danekkuznec.github.io/kcd2-rp-crafting/data.js (Russian names, icons)
DANEK_RICON_JS     saved .../ricon.js (icons of raw goods)
"""
import base64
import hashlib
import html
import json
import os
import re
import sys

# ------------------------------------------------------------------ the crafts and their trade packs
# wiki "Trade packs" (crafters' packs) + the tip "smithing and armouring metal, tailoring and bowyery cloth and
# leather, carpentry timber, jewelling luxury, alchemy, cooking and brewing food". Stocks: 0 food, 1 timber and fuel,
# 2 metal, 3 cloth and leather, 4 luxury. Tailoring's pack is not in the wiki: read off the game (2026-11-25).
CRAFTS = [
    {"id": "smithing", "wiki": "Smithing", "ru": "Кузнечное дело", "danek": "w",
     "pack": {"ru": "Ящик железного товара", "worth": 450, "stock": 2, "fresh": "12 ч, потом −5% в час, не ниже 70%",
              "goods": ["iron ore", "coal", "copper ore", "steel", "hafts", "found horseshoes", "holy nails",
                        "broken crankshafts", "ghostly horseshoes"], "source": "wiki"}},
    {"id": "armouring", "wiki": "Armouring", "ru": "Бронное дело", "danek": "a",
     "pack": {"ru": "Ящик кольчуг", "worth": 450, "stock": 2, "fresh": "12 ч, потом −5% в час, не ниже 70%",
              "goods": ["iron ore", "coal", "copper ore", "steel", "hides", "padding"], "source": "wiki"}},
    {"id": "tailoring", "wiki": "Tailoring", "ru": "Портняжное дело", "danek": "t",
     "pack": {"ru": "Тюк портного", "worth": 400, "stock": 3, "fresh": "3 ч, потом −10% в час, не ниже 60%",
              "goods": ["linen strips", "suture kits", "padding", "hemp fibre", "flax", "hides", "leather",
                        "hanged man's nooses", "owl feathers", "linen"], "source": "game"}},
    {"id": "bowyery", "wiki": "Bowyery", "ru": "Лучное дело", "danek": "b",
     "pack": {"ru": "Груз лучника", "worth": 400, "stock": 3, "fresh": "не известно",
              "goods": ["hides", "leather", "bowstrings", "hafts", "logs", "pine resin", "hemp fibre", "linen",
                        "owl feathers"], "source": "guess"}},
    {"id": "jewelling", "wiki": "Jewelling", "ru": "Ювелирное дело", "danek": "j",
     "pack": {"ru": "Ларец ювелира", "worth": 1500, "stock": 4, "fresh": "12 ч, потом −5% в час, не ниже 70%",
              "goods": ["fine silver", "silver ore", "gold ore", "commemorative coins"], "source": "wiki"}},
    {"id": "alchemy", "wiki": "Alchemy", "ru": "Алхимия", "danek": "al",
     "pack": {"ru": "Сундук снадобий", "worth": 350, "stock": 0, "fresh": "1 ч, потом −10% каждые 15 мин, не ниже 50%",
              "goods": ["nettles", "sage", "chamomile", "belladonna", "mandrake root", "ginger", "elderberry leaves",
                        "cobwebs", "charcoal", "sulphur", "saltpetre", "charcoal water"], "source": "wiki"}},
    {"id": "cooking", "wiki": "Cooking", "ru": "Кулинария", "danek": "ck",
     "pack": {"ru": "Корзина провизии", "worth": 300, "stock": 0, "fresh": "30 мин, потом −10% каждые 10 мин, не ниже 50%",
              "goods": ["venison", "boar meat", "hare", "roach", "carp", "eel", "pike", "barley malt", "sage"],
              "source": "wiki"}},
    {"id": "brewing", "wiki": "Brewing", "ru": "Пивоварение", "danek": "br",
     "pack": {"ru": "Бочка эля и вина", "worth": 400, "stock": 0, "fresh": "3 ч, потом −10% в час, не ниже 60%",
              "goods": ["hops", "barley malt", "grapes", "honey", "plums"], "source": "wiki"}},
    {"id": "carpentry", "wiki": "Carpentry", "ru": "Плотницкое дело", "danek": "cp",
     "pack": {"ru": "Ящик столярки", "worth": 450, "stock": 1, "fresh": "12 ч, потом −5% в час, не ниже 70%",
              "goods": ["logs", "pine resin", "iron ore", "steel", "leather", "padding"], "source": "wiki"}},
]

# wiki ingredient names the realm API calls otherwise
GOOD_ALIAS = {"broken crankshafts": "brokenrod", "found horseshoes": "foundhorseshoe", "holy nails": "holynail",
              "ghostly horseshoes": "ghosthorseshoe", "Weapon stub": "relicstub", "Dragon claw": "relicclaw",
              "Broken axe": "relicaxe"}
# realm good id -> key of the raw goods' icons in ricon.js
RICON = {"ore": "fe", "coal": "co", "copperore": "cuo", "silver": "ag", "gold": "au", "hide": "hd", "antler": "antl",
         "silvernugget": "nug", "meteoric": "met", "finesilver": "agp", "haft": "shaft", "steel": "steel",
         "nettle": "nettle", "flax": "flax", "honey": "honey", "pelt": "pelt", "tusk": "tusk", "beeswax": "wax",
         "crystal": "crystal", "bowstring": "bowstr", "padding": "pad"}
# Russian names the matching cannot find (identical recipes, missing in the name source)
RU_FIX = {
    "St. George's sword": "Меч Святого Георгия", "Lingua belli longsword": "Длинный меч Lingua belli",
    "jobtool:miner": "Кирка рудокопа", "Carpenter's axe": "Топор плотника",
    "Training bludgeon": "Тренировочная дубина", "Farmer Matthew's pitchfork": "Вилы крестьянина Матуша",
    "Training axe": "Тренировочный топор", "Training longsword (plain)": "Учебный длинный меч (простая версия)",
    "Staff": "Посох", "Training sword": "Тренировочный меч", "Torch": "Факел", "Club": "Дубинка",
    "Old dagger": "Старый кинжал", "Work axe": "Рабочий топор", "Knight's horseshoes": "Рыцарские подковы",
    "Common mace": "Обычная булава", "Bailiff's mace": "Булава рихтаржа",
    "Lord Capon's longsword": "Длинный меч пана Птачека", "Henry's longsword": "Длинный меч Индржиха",
    "Radzig Kobyla's longsword (Istvan)": "Длинный меч Рацека Кобылы",
    "Knight shield": "Рыцарский щит", "Practice shield": "Тренировочный щит", "Bardiche": "Бердыш", "Voulge": "Вульж",
}
PART_RU = {
    "Iron": "Железо", "Scrap metal": "Железный лом", "Fastening material": "Крепёж", "Copper": "Медь",
    "Frankfurt steel": "Франкфуртская сталь", "Toledo steel": "Толедская сталь", "Sheet steel": "Листовая сталь",
    "Ordinary sword guard": "Обычная гарда", "Straight sword guard": "Прямая гарда", "Horned sword guard": "Рогатая гарда",
    "Reinforced sword guard": "Укреплённая гарда", "Coin sword pommel": "Плоское навершие меча",
    "Eight-sided sword pommel": "Восьмигранное навершие меча", "Pear sword pommel": "Грушевидное навершие меча",
    "Decorated sword pommel": "Украшенное навершие меча", "Antler shards": "Осколки рогов",
    "Pig skin": "Свиная кожа", "Cow skin": "Коровья шкура", "Deer skin": "Оленья шкура",
}
# Russian names of game items used as ingredients (cooking, alchemy) and rare finds
MANUAL_RU = {
    "mint": "Мята", "wormwood": "Полынь", "thistle": "Чертополох", "dandelion": "Одуванчик", "valerian": "Валериана",
    "st john's wort": "Зверобой", "eyebright": "Очанка", "poppy": "Мак", "marigold": "Календула", "comfrey": "Окопник",
    "feverfew": "Пиретрум", "apple": "Яблоко", "boletus edulis": "Белый гриб", "lepiota": "Гриб-зонтик",
    "pear": "Груша", "beet": "Свёкла", "egg": "Яйцо", "pork": "Свинина", "milk": "Молоко", "horseradish": "Хрен",
    "chicken": "Курица", "mutton": "Баранина", "beef": "Говядина", "wolf meat": "Волчатина",
    "pork tenderloin": "Свиная вырезка", "sheep stomach": "Бараний желудок", "beef tenderloin": "Говяжья вырезка",
    "beef kidneys": "Говяжьи почки", "wolf heart": "Волчье сердце", "beef tongue": "Говяжий язык",
    "pork liver": "Свиная печень", "hare pelt": "Заячья шкурка", "cheese": "Сыр", "garlic": "Чеснок",
    "salami": "Салями", "exotic wood": "Экзотическая древесина", "tincal": "Бура", "dogfish skin": "Кожа акулы",
    "jasper": "Яшма", "coloured gold": "Цветное золото", "enamel powder": "Порошок эмали",
    "acidum chloridum": "Acidum chloridum", "rock pitch": "Каменная смола", "leached coal": "Щелочной уголь",
}
# danek's material codes of the weapons' and armours' recipes (they carry no English name)
DANEK_CODE = {"coal": "co", "steel": "steel", "logs": "log", "hides": "hd", "Iron": "iron", "copper ore": "cuo",
              "leather": "leather", "iron ore": "fe", "hafts": "shaft", "Scrap metal": "scrap",
              "Fastening material": "fast", "Toledo steel": "tol", "Frankfurt steel": "frank",
              "pure silver nuggets": "nug", "silver ore": "ag", "Copper": "cu", "meteoric iron": "met",
              "Coin sword pommel": "pflat", "Exotic wood": "exw", "pine resin": "resin", "gold ore": "au",
              "Cow skin": "cow", "Horned sword guard": "guard", "Deer skin": "deer", "Ordinary sword guard": "gcom",
              "Pig skin": "pig", "Straight sword guard": "gstr", "Coloured gold": "cgold",
              "Eight-sided sword pommel": "poct", "Enamel powder": "enam", "Acidum chloridum": "acid",
              "Tincal": "borax", "Dogfish skin": "shark", "Sheet steel": "sheet", "Decorated sword pommel": "porn",
              "Pear sword pommel": "ppear", "antlers": "horn", "Antler shards": "horn", "fine silver": "ag",
              "Reinforced sword guard": "gref", "Jasper": "jasp", "Broken axe": "baxe", "Dragon claw": "dclaw",
              "Rock Pitch": "stres", "Weapon stub": "wfrag", "Henry's longsword": "indr", "padding": "pad",
              "nettles": "nettle", "linen": "linen", "flax": "flax"}


def text(s):
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", s))).strip()


def parse_needs(s):
    fee = 0
    m = re.search(r"\+ (\d+) gr\.", s)
    if m:
        fee = int(m.group(1))
        s = s[:m.start()]
    items = {}
    for it in s.split(", "):
        mm = re.match(r"(\d+) (.+)", it.strip())
        if mm:
            items[mm.group(2).strip()] = items.get(mm.group(2).strip(), 0) + int(mm.group(1))
    return items, fee


def craft_sections(page):
    """{wiki craft name: (html of its section, flat text of it)}"""
    page = re.sub(r"<script.*?</script>|<style.*?</style>", "", page, flags=re.S)
    parts = re.split(r"(<h[23][^>]*>.*?</h[23]>)", page, flags=re.S)
    out, cur = {}, None
    for p in parts:
        if re.match(r"<h[23]", p):
            m = re.match(r"(\w+) at an? ", text(p))
            cur = m.group(1) if m else (cur if not re.match(r"<h2", p) else None)
            if m:
                out[cur] = ""
            continue
        if cur:
            out[cur] += p
    return out


def recipes_of(craft, sec):
    flat = text(sec)
    rows = []
    for tbl in re.findall(r"<table.*?</table>", sec, flags=re.S):
        head = [text(c) for c in re.findall(r"<th[^>]*>(.*?)</th>", tbl, flags=re.S)]
        for row in re.findall(r"<tr.*?</tr>", tbl, flags=re.S):
            cells = [text(c) for c in re.findall(r"<td[^>]*>(.*?)</td>", row, flags=re.S)]
            if len(cells) >= 4:
                rows.append((head, cells))
    levels = [(int(a), int(b)) for a, b in re.findall(r"Level (\d+) - (\d+) pieces", flat)]
    out = []
    if rows and rows[0][0] and rows[0][0][0] == "Level":
        seq = [int(c[0]) for _, c in rows]
        rows = [(h, c[1:]) for h, c in rows]
    else:
        if sum(n for _, n in levels) != len(rows):
            sys.exit(f"{craft}: level counts {sum(n for _, n in levels)} != rows {len(rows)}")
        seq = [lv for lv, n in levels for _ in range(n)]
    for lv, (head, cells) in zip(seq, rows):
        # columns by their names: smithing has Makes|Needs|Time|Worth, carpentry Piece|Kind|Size|Needs|Time
        h = head[1:] if head and head[0] == "Level" else head
        col = {name: i for i, name in enumerate(h)}
        ni, ti, wi = col.get("Needs", 1), col.get("Time", 2), col.get("Worth")
        cells = [cells[0], cells[ni] if ni < len(cells) else "", cells[ti] if ti < len(cells) else "",
                 cells[wi] if wi is not None and wi < len(cells) else ""]
        mk = cells[0]
        m = re.match(r"(.+?) ×(\d+)\b", mk)
        name, yld = (m.group(1), int(m.group(2))) if m else (mk, 1)
        name = re.sub(r" \d+ variants$", "", name)
        name = re.sub(r" \((Smithing|Armouring|Tailoring|Bowyery|Jewelling|Carpentry)\)$", "", name)
        items, fee = parse_needs(cells[1])
        out.append({"en": name, "level": lv, "yield": yld, "items": items, "fee": fee,
                    "secs": int(re.sub(r"\D", "", cells[2]) or 0), "worth": int(re.sub(r"\D", "", cells[3]) or 0)})
    # the craft's parts, written as a sentence: "steel ×2 from level 2 (3 iron ore, 2 coal); ..."
    pm = re.search(r"Its parts: (.*?)\.(?: Level|$)", flat)
    if pm:
        for name, y, lv, needs in re.findall(r"([A-Za-z][\w' -]*?) ×(\d+) from level (\d+) \(([^)]*)\)", pm.group(1)):
            items, fee = parse_needs(needs)
            out.append({"en": name.strip(), "level": int(lv), "yield": int(y), "items": items, "fee": fee,
                        "secs": 0, "worth": 0, "aux": True})
    return out


def json_object_after(t, key):
    i = t.index(key)
    j = t.index("{", i)
    depth = 0
    for k in range(j, len(t)):
        depth += {"{": 1, "}": -1}.get(t[k], 0)
        if depth == 0:
            return json.loads(t[j:k + 1])
    raise ValueError(key)


def save_icon(uri, folder):
    head, b64 = uri.split(",", 1)
    ext = "webp" if "webp" in head else "png" if "png" in head else "jpg"
    raw = base64.b64decode(b64)
    name = hashlib.sha1(raw).hexdigest()[:12] + "." + ext
    path = os.path.join(folder, name)
    if not os.path.exists(path):
        with open(path, "wb") as f:
            f.write(raw)
    return path.replace(os.sep, "/")


def main():
    args = sys.argv[1:]
    icons_dir = None
    if "--icons" in args:
        i = args.index("--icons")
        icons_dir = args[i + 1]
        del args[i:i + 2]
    page = open(args[0], encoding="utf-8", errors="replace").read()
    realm = json.load(open(args[1], encoding="utf-8"))
    dj = open(args[2], encoding="utf-8", errors="replace").read()
    ricon = dict(re.findall(r'"(\w+)":\s*"(data:image/[^"]+)"', open(args[3], encoding="utf-8").read()))

    # realm goods: English market name -> id, id -> Russian auction name
    good_by_en = {e["name"].lower(): e["id"] for e in realm["market"]}
    ru_by_id, item_by_en = {}, {}
    for a in realm["auction"]["items"]:
        if a["item"].startswith("good:"):
            ru_by_id[a["item"][5:]] = a["name"]
        else:
            item_by_en[a["name"].lower()] = a["item"]        # game items on sale: Comfrey, Chicken, Egg...

    # danek: Russian names and icons
    icons = json_object_after(dj, '"icons":')
    dn_en, dn_sig, dn_icon_lv, dn_icon = {}, {}, {}, {}
    pat = r'\{"s":"(\w+)","l":(\d+),"c":"[^"]*","n":"([^"]+)"(?:,"en":"([^"]+)")?[^{}]*?(?:,"r":\{([^}]*)\})?[^{}]*?,"b":(\d+)[^{}]*?"ic":"([^"]*)"'
    for m in re.finditer(pat, dj):
        s, lv, ru, en, r, fee, ic = m.groups()
        lv, fee = int(lv), int(fee)
        if en:
            dn_en.setdefault((s, en), ru)
        if r is not None:
            sig = tuple(sorted((k, int(v)) for k, v in re.findall(r'"(\w+)":(\d+)', r)))
            dn_sig.setdefault((s, lv, sig, fee), []).append(ru)
        if ic in icons:
            dn_icon_lv.setdefault((s, lv, ru), icons[ic])
            dn_icon.setdefault(ru, icons[ic])
    mats_ru = dict(re.findall(r'"(\w+)":\{"n":"([^"]+)","inp"', dj))

    sections = craft_sections(page)
    recipes, materials, seen_ids = [], {}, set()
    produced = {}
    for c in CRAFTS:
        sec = sections.get(c["wiki"])
        if sec is None:
            sys.exit(f"no wiki section for {c['wiki']}")
        rs = recipes_of(c["wiki"], sec)
        used = {}
        for r in rs:
            r["craft"] = c["id"]
            # Russian name
            gid = GOOD_ALIAS.get(r["en"]) or good_by_en.get(r["en"].lower())
            ru = PART_RU.get(r["en"]) or RU_FIX.get(r["en"]) or dn_en.get((c["danek"], r["en"])) or (
                ru_by_id.get(gid, "").capitalize() if gid else None) or None
            if not ru and not r.get("aux"):
                sig = tuple(sorted((DANEK_CODE.get(k, k), q) for k, q in r["items"].items()))
                key = (c["danek"], r["level"], sig, r["fee"])
                group = dn_sig.get(key)
                if group:
                    k = used.get(key, 0)
                    ru = group[k] if k < len(group) else None
                    used[key] = k + 1
            r["ru"] = ru
            base = r["en"] if c["id"] == "smithing" else f"{c['id']}:{r['en']}"
            rid, n = base, 1
            while rid in seen_ids:
                n += 1
                rid = f"{base} ({n})"
            seen_ids.add(rid)
            r["id"] = rid
            produced.setdefault(r["en"], []).append(r)
            recipes.append(r)

    # materials: every ingredient name
    for r in recipes:
        for k in r["items"]:
            if k in materials:
                continue
            gid = GOOD_ALIAS.get(k) or good_by_en.get(k.lower())
            if gid:
                ru = ru_by_id.get(gid) or k
                materials[k] = {"kind": "good", "id": gid, "ru": ru[:1].upper() + ru[1:], "recipe": k in produced}
            elif k in produced:
                ru = PART_RU.get(k) or next((x["ru"] for x in produced[k] if x["ru"]), None) or k
                materials[k] = {"kind": "part", "id": k, "ru": ru, "recipe": True}
            else:
                item = item_by_en.get(k.lower())
                ru = MANUAL_RU.get(k.lower()) or next((v for (s, en), v in dn_en.items() if en.lower() == k.lower()), None)
                materials[k] = {"kind": "manual", "id": item or re.sub(r"\W+", "", k.lower()), "auctionItem": item,
                                "ru": ru or k[:1].upper() + k[1:], "recipe": False}
    # pack goods must be materials too (they can fill a pack without being in a recipe)
    for c in CRAFTS:
        for g in c["pack"]["goods"]:
            if g not in materials:
                gid = GOOD_ALIAS.get(g) or good_by_en.get(g.lower())
                if not gid:
                    sys.exit(f"pack good without a realm id: {g}")
                ru = ru_by_id.get(gid) or g
                materials[g] = {"kind": "good", "id": gid, "ru": ru[:1].upper() + ru[1:], "recipe": g in produced}

    if icons_dir:
        os.makedirs(icons_dir, exist_ok=True)
        alias = {"Рогатая гарда": "Гарда", "Осколки рогов": "Оленьи рога"}
        code = {c["id"]: c["danek"] for c in CRAFTS}
        for r in recipes:
            ru = r["ru"]
            uri = dn_icon_lv.get((code[r["craft"]], r["level"], ru)) or dn_icon.get(ru) or dn_icon.get(alias.get(ru, ""))
            if uri:
                r["icon"] = save_icon(uri, icons_dir)
        for k, m in materials.items():
            uri = ricon.get(RICON.get(m["id"], "")) or dn_icon.get(m["ru"]) or dn_icon.get(alias.get(m["ru"], ""))
            if not uri and m["recipe"]:
                rec = next((x for x in produced[k] if x.get("icon")), None)
                if rec:
                    m["icon"] = rec["icon"]
                    continue
            if uri:
                m["icon"] = save_icon(uri, icons_dir)

    crafts = [{"id": c["id"], "ru": c["ru"], "pack": c["pack"]} for c in CRAFTS]
    stats = {c["id"]: (sum(1 for r in recipes if r["craft"] == c["id"] and not r.get("aux")),
                       sum(1 for r in recipes if r["craft"] == c["id"] and not r.get("aux") and r["ru"]),
                       sum(1 for r in recipes if r["craft"] == c["id"] and not r.get("aux") and r.get("icon")))
             for c in CRAFTS}
    print("recipes (all, ru, icon):", stats, file=sys.stderr)
    print("materials:", {k: sum(1 for m in materials.values() if m["kind"] == k) for k in ("good", "part", "manual")},
          file=sys.stderr)
    json.dump({"source": "https://wiki.kcdroleplay.com/recipes/", "crafts": crafts, "materials": materials,
               "recipes": recipes}, sys.stdout, ensure_ascii=False, indent=1)


if __name__ == "__main__":
    main()
