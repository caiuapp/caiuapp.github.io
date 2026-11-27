#!/usr/bin/env python3
"""Verifica a data de cada evento de dados.js contra notícias dos últimos 12 meses (Google News RSS).

Uso:
  python3 scripts/verificar_datas.py                 # gera relatorio_datas.json/.md
  python3 scripts/verificar_datas.py --apply         # também corrige dados.js (só alta confiança)
  python3 scripts/verificar_datas.py --only "Festa da Uva"
"""
import argparse, json, re, sys, time, unicodedata, urllib.parse, urllib.request
from collections import Counter
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DADOS = ROOT / "cloudflare" / "dados.js"
MESES = ["janeiro","fevereiro","março","abril","maio","junho","julho","agosto","setembro","outubro","novembro","dezembro"]
MES_RE = "|".join(MESES + ["marco"])
CULTURAL = re.compile(r"\b(show|shows|programa[cç][aã]o|atra[cç][oõ]es|festa|festival|apresenta|cantor|cantora|dupla|banda|palco|rodeio|desfile|celebra|comemora)", re.I)
ROW = re.compile(r'\["([^"]+)","([A-Z]{2})",(\d+),(\d+),"(\w+)","([^"]*)",(\d),"([^"]*)"\]')


def norm(s):
    return unicodedata.normalize("NFD", s.lower()).encode("ascii", "ignore").decode()


def fetch(query):
    url = "https://news.google.com/rss/search?" + urllib.parse.urlencode(
        {"q": query + " when:1y", "hl": "pt-BR", "gl": "BR", "ceid": "BR:pt-419"})
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (verificador-eventos)"})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                xml = r.read().decode("utf-8", "replace")
            break
        except Exception:
            time.sleep(3 * (attempt + 1))
    else:
        return []
    out = []
    for item in re.findall(r"<item>(.*?)</item>", xml, re.S):
        t = re.search(r"<title>(.*?)</title>", item, re.S)
        d = re.search(r"<pubDate>(.*?)</pubDate>", item)
        l = re.search(r"<link>(.*?)</link>", item)
        if not (t and d):
            continue
        try:
            pub = parsedate_to_datetime(d.group(1))
        except Exception:
            continue
        title = re.sub(r"<!\[CDATA\[|\]\]>", "", t.group(1)).replace("&amp;", "&").replace("&quot;", '"')
        out.append({"title": title, "pub": pub, "link": l.group(1) if l else ""})
    return out


def explicit_dates(title, pub):
    """Datas citadas no título: '9 de março', 'dia 9', 'neste domingo (9)'."""
    found = []
    t = norm(title)
    for d, m in re.findall(r"\b(\d{1,2}) de (" + norm(MES_RE) + r")\b", t):
        mi = 3 if m in ("marco", "março") else MESES.index(m) + 1 if m in MESES else None
        if mi is None:
            mi = [norm(x) for x in MESES].index(m) + 1
        if 1 <= int(d) <= 31:
            found.append((int(d), mi))
    for d in re.findall(r"\((\d{1,2})\)", t) + re.findall(r"\bdia (\d{1,2})\b", t):
        d = int(d)
        if 1 <= d <= 31:
            # o dia citado é o mais próximo da data de publicação (mesmo mês ou o seguinte)
            m = pub.month if d >= pub.day - 3 else pub.month % 12 + 1
            found.append((d, m))
    return found


def doy(d, m):
    return datetime(2001, m, min(d, 28 if m == 2 else d)).timetuple().tm_yday


def circ_dist(a, b):
    x = abs(a - b) % 365
    return min(x, 365 - x)


def analyse(row):
    cidade, uf, dia, mes, tipo, evento = row[0], row[1], int(row[2]), int(row[3]), row[4], row[5]
    if tipo == "aniv":
        queries = [f'"aniversário de {cidade}"', f'"{cidade}" aniversário da cidade show']
    else:
        queries = [f'"{evento}" {cidade}', f'"{evento}" programação']
    items, seen = [], set()
    for q in queries:
        for it in fetch(q):
            if it["link"] in seen:
                continue
            seen.add(it["link"])
            items.append(it)
        time.sleep(1.2)

    cutoff = datetime.now(timezone.utc) - timedelta(days=365)
    ncid = norm(cidade)
    key = norm(evento) if tipo != "aniv" else None
    rel = []
    for it in items:
        if it["pub"] < cutoff:
            continue
        nt = norm(it["title"])
        generic = key and re.search(r"\b(festa d|expo |sao joao|carnaval|reveillon|rodeio|vaquejada|festival|micareta|arraia)", key)
        if ncid not in nt and not (key and key in nt and not generic):
            continue
        if tipo == "aniv" and "anivers" not in nt and "anos" not in nt:
            continue
        rel.append(it)
    cultural = [it for it in rel if CULTURAL.search(it["title"])]

    votes = Counter()
    for it in cultural:
        for dm in explicit_dates(it["title"], it["pub"]):
            votes[dm] += 3
    # pico de publicações: cada notícia vota no seu dia de publicação (peso 1)
    pub_doys = [it["pub"].timetuple().tm_yday for it in cultural]

    cur = doy(dia, mes)
    result = {"cidade": cidade, "uf": uf, "tipo": tipo, "evento": evento or f"Aniversário de {cidade}",
              "atual": f"{dia:02d}/{mes:02d}", "noticias": len(rel), "culturais": len(cultural),
              "exemplos": [{"titulo": i["title"], "data": i["pub"].strftime("%Y-%m-%d"), "link": i["link"]} for i in cultural[:4]]}

    if not cultural:
        result.update(status="sem_noticia_cultural", confianca="—")
        return result

    if votes and votes.most_common(1)[0][1] >= 6:
        (bd, bm), score = votes.most_common(1)[0]
        if tipo != "aniv":
            # evento de vários dias: usa a data de início (a mais antiga citada perto do pico)
            best = doy(bd, bm)
            near_dates = [dm for dm in votes if circ_dist(doy(*dm), best) <= 12]
            bd, bm = min(near_dates, key=lambda dm: (doy(*dm) - best + 182) % 365)
        result["sugerida"] = f"{bd:02d}/{bm:02d}"
        agree = sum(v for (d, m), v in votes.items() if circ_dist(doy(d, m), doy(bd, bm)) <= (1 if tipo == 'aniv' else 12))
        dist = circ_dist(doy(bd, bm), cur)
        if dist <= 2:
            result.update(status="ok", confianca="alta" if agree >= 6 else "média")
        else:
            result.update(status="divergente", confianca="alta" if agree >= 6 and score >= 6 else "média" if agree >= 3 else "baixa",
                          diferenca_dias=dist)
        return result

    # sem data explícita confiável: usa o pico de publicações (janela de ±7 dias)
    peak = max(range(1, 366), key=lambda c: sum(1 for p in pub_doys if circ_dist(p, c) <= 7))
    in_peak = sum(1 for p in pub_doys if circ_dist(p, peak) <= 7)
    pd = datetime(2001, 1, 1) + timedelta(days=peak - 1)
    result["pico"] = f"{pd.day:02d}/{pd.month:02d}"
    near = sum(1 for p in pub_doys if circ_dist(p, cur) <= 20)
    if near / len(pub_doys) >= 0.4 or circ_dist(peak, cur) <= 20:
        result.update(status="ok", confianca="média" if len(pub_doys) >= 3 else "baixa")
    else:
        result.update(status="divergente", confianca="média" if in_peak >= 4 else "baixa",
                      mes_sugerido=MESES[pd.month - 1], diferenca_dias=circ_dist(peak, cur))
    return result


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="corrige dados.js com sugestões de alta confiança")
    ap.add_argument("--only", help="filtra por cidade ou nome do evento")
    ap.add_argument("--limit", type=int)
    a = ap.parse_args()

    src = DADOS.read_text(encoding="utf-8")
    rows = ROW.findall(src)
    if a.only:
        rows = [r for r in rows if norm(a.only) in norm(r[0] + " " + r[5])]
    if a.limit:
        rows = rows[: a.limit]

    out = []
    for i, r in enumerate(rows, 1):
        res = analyse(r)
        out.append(res)
        print(f"[{i}/{len(rows)}] {res['evento']} ({res['cidade']}/{res['uf']}): {res['status']} {res.get('sugerida','')} conf={res['confianca']}", flush=True)

    rep = ROOT / "scripts" / "relatorio_datas.json"
    rep.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")

    md = ["# Relatório de verificação de datas", "", f"Gerado em {datetime.now():%d/%m/%Y %H:%M}. Fonte: Google News, últimos 12 meses.", ""]
    for st, label in [("divergente", "Divergentes"), ("sem_noticia_cultural", "Sem notícia de show/evento cultural"), ("ok", "Confirmadas")]:
        group = [x for x in out if x["status"] == st]
        md += [f"## {label} ({len(group)})", ""]
        for x in group:
            sug = x.get("sugerida") or x.get("mes_sugerido", "")
            md.append(f"- **{x['evento']}** ({x['cidade']}/{x['uf']}): atual {x['atual']}" + (f" → sugerida {sug}" if sug and st == "divergente" else "") + f" · confiança {x['confianca']} · {x['culturais']} notícias")
            for e in x["exemplos"][:2]:
                md.append(f"  - {e['data']} [{e['titulo']}]({e['link']})")
        md.append("")
    (ROOT / "scripts" / "relatorio_datas.md").write_text("\n".join(md), encoding="utf-8")

    if a.apply:
        fixes = {(x["cidade"], x["uf"], x["tipo"], x["evento"]): x["sugerida"] for x in out
                 if x["status"] == "divergente" and x["confianca"] == "alta" and x.get("sugerida")}
        def sub(m):
            c, u, d, mo, t, e, sh, l = m.groups()
            k = (c, u, t, e or f"Aniversário de {c}")
            if k in fixes:
                nd, nm = map(int, fixes[k].split("/"))
                return f'["{c}","{u}",{nd},{nm},"{t}","{e}",{sh},"{l}"]'
            return m.group(0)
        DADOS.write_text(ROW.sub(sub, src), encoding="utf-8")
        print(f"Aplicadas {len(fixes)} correções de alta confiança em {DADOS}")


if __name__ == "__main__":
    main()
