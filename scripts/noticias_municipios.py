#!/usr/bin/env python3
"""Para cada município da lista, procura notícias do último ano sobre festas com shows.

Entrada: scratchpad/src/abaixo_brasilia.json  (lista [nome, uf, pop])
Saída:   scripts/noticias_municipios.json  (categorias encontradas + manchete de prova)

Categorias:
  aniv   aniversário de município com show/atração cultural
  feriado festa de Natal, Carnaval ou Réveillon com show
  expo   expo agropecuária ou de negócios com shows nacionais
  rodeio rodeio ou festa cultural com shows nacionais
"""
import json, re, sys, time, unicodedata
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from verificar_datas import fetch, norm

SRC = Path(sys.argv[1])
OUT = Path(__file__).resolve().parent / "noticias_municipios.json"
CATS = {
    "aniv": (r"anivers[aá]rio|anos de (funda|emancipa|hist)|\d{2,3} anos de", r"show|shows|atra[cç][aã]o|programa[cç][aã]o|festa|cantor|banda"),
    "feriado": (r"natal|carnaval|r[eé]veillon|virada", r"show|shows|atra[cç][aã]o|programa[cç][aã]o|cantor|banda|festa"),
    "expo": (r"expo|feira agropecu|exposi[cç][aã]o agropecu|agroneg[oó]cio|feira de neg[oó]cios", r"show|shows|atra[cç][aã]o|cantor|sertanejo|nacional"),
    "rodeio": (r"rodeio|festa do pe[aã]o|festa cultural|festival|vaquejada|cavalgada", r"show|shows|atra[cç][aã]o|cantor|nacional|sertanejo"),
}
PATS = {k: (re.compile(a, re.I), re.compile(b, re.I)) for k, (a, b) in CATS.items()}


def classify(title):
    t = norm(title)
    hits = []
    for k, (a, b) in PATS.items():
        if a.search(t) and b.search(t):
            hits.append(k)
    return hits


def main():
    mun = json.loads(SRC.read_text(encoding="utf-8"))
    res = {}
    if OUT.exists():
        res = json.loads(OUT.read_text(encoding="utf-8"))
    for i, (nome, uf, pop) in enumerate(mun, 1):
        key = f"{nome}|{uf}"
        if key in res:
            continue
        q = f'"{nome}" (aniversário OR natal OR carnaval OR réveillon OR expo OR rodeio OR festa) show'
        found = {}
        try:
            items = fetch(q)
        except Exception:
            items = []
        nn = norm(nome)
        for it in items:
            if it["pub"].timestamp() < time.time() - 365 * 86400:
                continue
            t = norm(it["title"])
            if nn not in t:
                continue
            for c in classify(it["title"]):
                found.setdefault(c, {"titulo": it["title"], "data": it["pub"].strftime("%Y-%m-%d"), "link": it["link"]})
        res[key] = {"nome": nome, "uf": uf, "pop": pop, "categorias": sorted(found), "provas": found}
        if i % 25 == 0:
            OUT.write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
            print(f"{i}/{len(mun)}", flush=True)
        time.sleep(1.5)
    OUT.write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
    hit = [r for r in res.values() if r["categorias"]]
    print(f"Concluído: {len(hit)} de {len(res)} com notícia em alguma categoria", flush=True)


if __name__ == "__main__":
    main()
