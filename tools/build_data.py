#!/usr/bin/env python3
"""Build data/smithing.json from the KCD Roleplay wiki.

Usage:
  python3 -I tools/build_data.py WIKI_RECIPES_HTML [DANEK_DATA_JS] > data/smithing.json

WIKI_RECIPES_HTML  saved copy of https://wiki.kcdroleplay.com/recipes/
DANEK_DATA_JS      optional saved copy of https://danekkuznec.github.io/kcd2-rp-crafting/data.js,
                   used only for the Russian names of weapons and materials
"""
import html
import json
import re
import sys

# wiki ingredient name -> material id. Ids of goods are the realm API's ids (good:<id>).
GOODS = {
    "iron ore": "ore", "coal": "coal", "copper ore": "copperore", "silver ore": "silver", "gold ore": "gold",
    "logs": "logs", "pine resin": "resin", "hides": "hide", "antlers": "antler",
    "pure silver nuggets": "silvernugget", "meteoric iron": "meteoric", "fine silver": "finesilver",
    "hafts": "haft", "leather": "leather", "steel": "steel",
    "found horseshoes": "foundhorseshoe", "holy nails": "holynail", "broken crankshafts": "brokenrod",
    "ghostly horseshoes": "ghosthorseshoe",
    "Weapon stub": "relicstub", "Dragon claw": "relicclaw", "Broken axe": "relicaxe",
}
# rare finds and other crafts' goods the realm API does not list: priced by hand only
MANUAL = {
    "Exotic wood": ("exoticwood", "Экзотическая древесина"), "Coloured gold": ("colouredgold", "Цветное золото"),
    "Enamel powder": ("enamel", "Порошок эмали"), "Jasper": ("jasper", "Яшма"),
    "Acidum chloridum": ("acidum", "Acidum chloridum"), "Tincal": ("tincal", "Бура"),
    "Dogfish skin": ("dogfishskin", "Кожа акулы"), "Rock Pitch": ("rockpitch", "Каменная смола"),
}
# Russian names of goods (the realm API's auction names, capitalised)
GOOD_RU = {
    "ore": "Железная руда", "coal": "Уголь", "copperore": "Медная руда", "silver": "Серебряная руда",
    "gold": "Золотая руда", "logs": "Брёвна", "resin": "Сосновая смола", "hide": "Шкуры", "antler": "Рога",
    "silvernugget": "Самородки чистого серебра", "meteoric": "Метеоритное железо", "finesilver": "Чистое серебро",
    "haft": "Древки", "leather": "Кожа", "steel": "Сталь", "foundhorseshoe": "Найденные подковы",
    "holynail": "Святые гвозди", "brokenrod": "Сломанные железные стержни", "ghosthorseshoe": "Призрачные подковы",
    "relicstub": "Обломок оружия", "relicclaw": "Драконий коготь", "relicaxe": "Сломанный топор",
}
# smithing's own materials (recipes in the table) -> Russian
PART_RU = {
    "Iron": "Железо", "Scrap metal": "Железный лом", "Fastening material": "Крепёж", "Copper": "Медь",
    "Frankfurt steel": "Франкфуртская сталь", "Toledo steel": "Толедская сталь", "Sheet steel": "Листовая сталь",
    "Ordinary sword guard": "Обычная гарда", "Straight sword guard": "Прямая гарда",
    "Horned sword guard": "Рогатая гарда", "Reinforced sword guard": "Укреплённая гарда",
    "Coin sword pommel": "Плоское навершие меча", "Eight-sided sword pommel": "Восьмигранное навершие меча",
    "Pear sword pommel": "Грушевидное навершие меча", "Decorated sword pommel": "Украшенное навершие меча",
    "Antler shards": "Осколки рогов", "Pig skin": "Свиная кожа", "Cow skin": "Коровья шкура",
    "Deer skin": "Оленья шкура",
}
# names the matching cannot find
# and recipes with identical goods and fee, which the matching cannot tell apart
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
    "Knight shield": "Рыцарский щит", "Practice shield": "Тренировочный щит",
    "Bardiche": "Бердыш", "Voulge": "Вульж",
}
# recipes that are not rows of the smithing table (wiki: smithing "Its parts", tailoring, parts table)
EXTRA = [
    {"en": "steel", "craft": "smithing", "level": 2, "yield": 2, "items": {"iron ore": 3, "coal": 2}, "fee": 0},
    {"en": "found horseshoes", "craft": "smithing", "level": 1, "yield": 1, "items": {"Scrap metal": 1}, "fee": 0},
    {"en": "holy nails", "craft": "smithing", "level": 2, "yield": 1, "items": {"Iron": 1}, "fee": 0},
    {"en": "broken crankshafts", "craft": "smithing", "level": 2, "yield": 1, "items": {"Iron": 1, "Scrap metal": 1}, "fee": 0},
    {"en": "ghostly horseshoes", "craft": "smithing", "level": 6, "yield": 1, "items": {"Iron": 1, "silver ore": 1}, "fee": 0},
    {"en": "leather", "craft": "tailoring", "level": 1, "yield": 2, "items": {"hides": 1}, "fee": 0},
    {"en": "Pig skin", "craft": "tailoring", "level": 1, "yield": 1, "items": {"hides": 1}, "fee": 0},
    {"en": "Cow skin", "craft": "tailoring", "level": 1, "yield": 1, "items": {"hides": 2}, "fee": 0},
    {"en": "Deer skin", "craft": "tailoring", "level": 1, "yield": 1, "items": {"hides": 2, "pine resin": 1}, "fee": 0},
]


def text(s):
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", s))).strip()


def smithing_rows(page):
    page = re.sub(r"<script.*?</script>|<style.*?</style>", "", page, flags=re.S)
    flat = text(page)
    start = flat.index("Smithing at a")
    nxt = re.search(r"(Armouring|Tailoring|Bowyery|Jewelling|Carpentry|Alchemy|Cooking|Brewing) at a", flat[start + 20:])
    section = flat[start:start + 20 + nxt.start()] if nxt else flat[start:]
    levels = [(int(a), int(b)) for a, b in re.findall(r"Level (\d+) - (\d+) pieces", section)]
    # the tables of the smithing section, in page order
    parts = re.split(r"(<h[23][^>]*>.*?</h[23]>)", page, flags=re.S)
    craft, cells_list = None, []
    for p in parts:
        if re.match(r"<h[23]", p):
            m = re.match(r"(\w+) at ", text(p))
            if m:
                craft = m.group(1)
            continue
        if craft != "Smithing":
            continue
        for tbl in re.findall(r"<table.*?</table>", p, flags=re.S):
            for row in re.findall(r"<tr.*?</tr>", tbl, flags=re.S):
                cells = [text(c) for c in re.findall(r"<t[dh][^>]*>(.*?)</t[dh]>", row, flags=re.S)]
                if len(cells) >= 4 and cells[0] != "Makes":
                    cells_list.append(cells)
    if sum(n for _, n in levels) != len(cells_list):
        sys.exit(f"level counts {levels} do not match {len(cells_list)} rows")
    rows, i = [], 0
    for lv, n in levels:
        for _ in range(n):
            rows.append((lv, cells_list[i]))
            i += 1
    return rows


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
            items[mm.group(2)] = items.get(mm.group(2), 0) + int(mm.group(1))
    return items, fee


def danek_names(path):
    """weapons: (level, sorted recipe, fee) -> Russian name; their material codes -> our wiki names"""
    if not path:
        return {}
    t = open(path, encoding="utf-8", errors="replace").read()
    code = {"coal": "co", "steel": "steel", "logs": "log", "hides": "hd", "Iron": "iron", "copper ore": "cuo",
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
            "Rock Pitch": "stres", "Weapon stub": "wfrag", "Henry's longsword": "indr"}
    out = {}
    pat = r'\{"s":"w","l":(\d+),"c":"[^"]*","n":"([^"]+)","r":\{([^}]*)\},"b":(\d+)'
    for m in re.finditer(pat, t):
        r = tuple(sorted((k, int(v)) for k, v in re.findall(r'"(\w+)":(\d+)', m.group(3))))
        out.setdefault((int(m.group(1)), r, int(m.group(4))), []).append(m.group(2))
    return {"by_sig": out, "code": code}


def main():
    page = open(sys.argv[1], encoding="utf-8", errors="replace").read()
    dn = danek_names(sys.argv[2] if len(sys.argv) > 2 else None)
    recipes, seen, used = [], {}, {}
    for lv, cells in smithing_rows(page):
        mk = cells[0]
        m = re.match(r"(.+?) ×(\d+)$", mk)
        name, yld = (m.group(1), int(m.group(2))) if m else (mk, 1)
        name = re.sub(r" \d+ variants$", "", name)
        name = re.sub(r" \(Smithing\)$", "", name)
        items, fee = parse_needs(cells[1])
        worth = int(re.sub(r"\D", "", cells[3]) or 0)
        secs = int(re.sub(r"\D", "", cells[2]) or 0)
        ru = PART_RU.get(name) or RU_FIX.get(name)
        if not ru and dn:
            sig = tuple(sorted((dn["code"].get(k, k), q) for k, q in items.items()))
            group = dn["by_sig"].get((lv, sig, fee))
            if group:
                # recipes with the same goods and fee: both lists follow the game's order
                k = used.get((lv, sig, fee), 0)
                ru = group[k] if k < len(group) else None
                used[(lv, sig, fee)] = k + 1
        rid = name if name not in seen else f"{name} ({seen[name] + 1})"
        seen[name] = seen.get(name, 0) + 1
        recipes.append({"id": rid, "en": name, "ru": ru, "craft": "smithing", "level": lv, "yield": yld,
                        "items": items, "fee": fee, "secs": secs, "worth": worth})
    for e in EXTRA:
        recipes.append({"id": e["en"], "en": e["en"], "ru": PART_RU.get(e["en"]) or GOOD_RU.get(GOODS.get(e["en"], "")),
                        "craft": e["craft"], "level": e["level"], "yield": e["yield"], "items": e["items"],
                        "fee": e["fee"], "secs": 0, "worth": 0, "aux": True})
    # material table: every name used as an ingredient
    materials = {}
    produced = {r["en"] for r in recipes}
    for r in recipes:
        for k in r["items"]:
            if k in materials:
                continue
            if k in GOODS:
                gid = GOODS[k]
                materials[k] = {"kind": "good", "id": gid, "ru": GOOD_RU.get(gid, k), "recipe": k in produced}
            elif k in MANUAL:
                gid, ru = MANUAL[k]
                materials[k] = {"kind": "manual", "id": gid, "ru": ru, "recipe": False}
            elif k in produced:
                materials[k] = {"kind": "part", "id": k, "ru": PART_RU.get(k) or next(
                    (x["ru"] for x in recipes if x["en"] == k and x["ru"]), k), "recipe": True}
            else:
                sys.exit(f"unknown ingredient: {k}")
    json.dump({"source": "https://wiki.kcdroleplay.com/recipes/", "materials": materials, "recipes": recipes},
              sys.stdout, ensure_ascii=False, indent=1)


if __name__ == "__main__":
    main()
