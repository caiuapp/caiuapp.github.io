// GET /api/news?q=<termo>  ->  notícias dos últimos 30 dias (Google News RSS), em JSON
export async function onRequestGet({ request }) {
  const params = new URL(request.url).searchParams;
  const q = (params.get("q") || "").trim();
  const norm = (x) => x.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const keys = (params.get("k") || "").split("|").map((x) => norm(x.trim())).filter(Boolean);
  if (!q || q.length > 160) return json({ error: "parâmetro q inválido" }, 400);

  const UA = { "user-agent": "Mozilla/5.0 (compatible; EventosMunicipais/1.0)", "accept": "application/rss+xml,text/xml" };
  const sources = [
    "https://news.google.com/rss/search?" + new URLSearchParams({ q: q + " when:30d", hl: "pt-BR", gl: "BR", ceid: "BR:pt-419" }),
    "https://www.bing.com/news/search?" + new URLSearchParams({ q, format: "rss", setlang: "pt-BR", cc: "BR", qft: 'interval="8"' }),
  ];
  let xml = "", status = [];
  for (const url of sources) {
    const r = await fetch(url, { headers: UA, cf: { cacheTtl: 1800, cacheEverything: true } });
    status.push(r.status);
    if (r.ok) { const t = await r.text(); if (t.includes("<item>")) { xml = t; break; } }
  }
  if (!xml) return json({ q, items: [], status }, 200);

  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 15).map((m) => {
    const get = (tag) => (m[1].match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`)) || [])[1] || "";
    const clean = (s) => s.replace(/<!\[CDATA\[|\]\]>/g, "").replace(/<[^>]+>/g, "")
      .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
      .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").trim();
    return { title: clean(get("title")), link: clean(get("link")), pub: clean(get("pubDate")), source: clean(get("source")), desc: clean(get("description")) };
  })
    .filter((n) => !n.pub || Date.now() - new Date(n.pub) < 31 * 864e5)
    .filter((n) => !keys.length || keys.some((k) => norm(n.title + " " + n.desc).includes(k)))
    .map(({ desc, ...n }) => n);
  return json({ q, items });
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=1800" },
  });
}
