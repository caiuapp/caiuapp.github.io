/* Painel do Caiu! — módulos de Business Intelligence.
 *
 * Abas: Visão geral, Audiência, Consumo, Ofertas, Performance, Segmentos, Retail Media, Financeiro e
 * Acompanhamento (o painel original, intacto). Cada aba chama UMA função do banco (painel_*), que só
 * responde a administradores e devolve números agregados. Nada aqui calcula ou inventa número: o que
 * vem com estado diferente de "ok" aparece como "—" com o motivo.
 *
 * Gráficos: Apache ECharts 5.6.0 (licença Apache 2.0), carregado só depois do login.
 * Paleta validada (claro e escuro) com o azul do Caiu! na série 1; cores nas variáveis --serie-* do bi.css.
 */
(function () {
  'use strict';
  var URL_ECHARTS = 'https://cdn.jsdelivr.net/npm/echarts@5.6.0/dist/echarts.min.js';
  var CACHE_MS = 5 * 60 * 1000;
  var sb = null;
  var opcoes = null;           // listas dos filtros (categorias, tipos, marcas, lojas)
  var graficos = [];           // instâncias ECharts da aba atual
  var cache = {};
  var estado = { aba: 'visao', dias: 30, inicio: null, fim: null, comparar: true, filtros: {} };
  try { var salvo = JSON.parse(localStorage.getItem('caiu-painel-bi') || '{}'); if (salvo.aba) estado.aba = salvo.aba; if (salvo.dias) estado.dias = salvo.dias; } catch (e) { /* sem armazenamento */ }

  var ABAS = [
    { id: 'visao', nome: 'Visão geral' }, { id: 'audiencia', nome: 'Audiência' }, { id: 'consumo', nome: 'Consumo' },
    { id: 'ofertas', nome: 'Ofertas' }, { id: 'performance', nome: 'Performance' }, { id: 'segmentos', nome: 'Segmentos' },
    { id: 'retail', nome: 'Retail Media' }, { id: 'financeiro', nome: 'Financeiro' }, { id: 'acompanhamento', nome: 'Acompanhamento' }
  ];
  // quais filtros valem em cada aba (os outros ficam desligados, com o motivo)
  var FILTROS_DA_ABA = {
    visao: ['categoria_id', 'generico_id', 'marca', 'loja', 'plataforma'], consumo: ['categoria_id', 'generico_id', 'marca', 'loja', 'plataforma'],
    ofertas: ['categoria_id', 'generico_id', 'marca', 'produto_id'], performance: ['categoria_id', 'generico_id', 'marca', 'loja', 'plataforma'],
    audiencia: [], segmentos: [], retail: [], financeiro: []
  };

  // ---------- utilidades ----------
  var $ = function (id) { return document.getElementById(id); };
  function el(tag, attrs, filhos) {
    var e = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (attrs[k] == null) return;
      if (k === 'texto') e.textContent = attrs[k];
      else if (k.slice(0, 2) === 'on') e.addEventListener(k.slice(2), attrs[k]);
      else e.setAttribute(k, attrs[k]);
    });
    (filhos || []).forEach(function (f) { if (f) e.appendChild(typeof f === 'string' ? document.createTextNode(f) : f); });
    return e;
  }
  var nf = new Intl.NumberFormat('pt-BR');
  var nf1 = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 });
  var brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
  function formatar(v, formato) {
    if (v == null) return '—';
    if (typeof v === 'string') return v;                    // "<50" (anonimato)
    if (formato === 'pct') return nf1.format(v) + '%';
    if (formato === 'brl') return brl.format(v);
    if (formato === 'dec') return nf1.format(v);
    if (formato === 'dur') { var m = Math.floor(v / 60), s = Math.round(v % 60); return m ? m + ' min ' + String(s).padStart(2, '0') + ' s' : s + ' s'; }
    return nf.format(v);
  }
  function dataBR(d) { var p = String(d).slice(0, 10).split('-'); return p[2] + '/' + p[1]; }
  function hojeISO() { var d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  function menosDias(iso, n) { var d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); }
  function cor(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }
  function serieCores() { return [1, 2, 3, 4, 5, 6, 7, 8].map(function (i) { return cor('--serie-' + i); }); }
  function guardar() { try { localStorage.setItem('caiu-painel-bi', JSON.stringify({ aba: estado.aba, dias: estado.dias })); } catch (e) { /* ok */ } }

  function carregarScript(src) {
    return new Promise(function (ok, erro) {
      if (window.echarts) return ok();
      var s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = function () { erro(new Error('Não foi possível carregar a biblioteca de gráficos.')); };
      document.head.appendChild(s);
    });
  }

  async function rpc(nome, params) {
    var chave = nome + JSON.stringify(params || {});
    var c = cache[chave];
    if (c && Date.now() - c.em < CACHE_MS) return c.r;
    var r = await sb.rpc(nome, params || {});
    if (!r.error) cache[chave] = { em: Date.now(), r: r };
    return r;
  }

  // ---------- estrutura: abas e filtros ----------
  function montar() {
    var main = document.querySelector('main');
    var abas = el('nav', { class: 'abas', id: 'abasBI', role: 'tablist', 'aria-label': 'Módulos do painel' });
    ABAS.forEach(function (a) {
      abas.appendChild(el('button', { type: 'button', role: 'tab', id: 'aba-' + a.id, 'aria-selected': String(a.id === estado.aba), texto: a.nome,
        onclick: function () { trocarAba(a.id); } }));
    });
    var bi = el('div', { id: 'bi' });
    main.insertBefore(abas, $('conteudo'));
    main.insertBefore(bi, $('conteudo'));
    bi.appendChild(barraFiltros());
    bi.appendChild(el('div', { id: 'biCorpo', role: 'tabpanel' }));
    window.addEventListener('resize', function () { graficos.forEach(function (g) { g.resize(); }); });
    var mq = window.matchMedia('(prefers-color-scheme: dark)');
    if (mq.addEventListener) mq.addEventListener('change', function () { if (estado.aba !== 'acompanhamento') desenharAba(); });
  }

  function opcao(valor, texto, sel) { var o = el('option', { value: valor, texto: texto }); if (sel) o.selected = true; return o; }

  function barraFiltros() {
    var f = el('div', { class: 'filtros', id: 'filtrosBI' });
    var per = el('select', { id: 'fPeriodo', 'aria-label': 'Período' });
    [[7, 'Últimos 7 dias'], [30, 'Últimos 30 dias'], [90, 'Últimos 90 dias'], [180, 'Últimos 180 dias'], [365, 'Últimos 12 meses'], [0, 'Personalizado…']]
      .forEach(function (x) { per.appendChild(opcao(x[0], x[1], x[0] === estado.dias)); });
    var ini = el('input', { type: 'date', id: 'fInicio', 'aria-label': 'Início' });
    var fim = el('input', { type: 'date', id: 'fFim', 'aria-label': 'Fim' });
    per.addEventListener('change', function () {
      estado.dias = Number(per.value); guardar();
      $('lblInicio').hidden = $('lblFim').hidden = estado.dias !== 0;
      if (estado.dias === 0) { fim.value = fim.value || hojeISO(); ini.value = ini.value || menosDias(fim.value, 29); }
      atualizar();
    });
    [ini, fim].forEach(function (x) { x.addEventListener('change', atualizar); });
    var comp = el('input', { type: 'checkbox', id: 'fComparar' }); comp.checked = estado.comparar;
    comp.addEventListener('change', function () { estado.comparar = comp.checked; desenharAba(); });

    var cat = el('select', { id: 'f_categoria_id', 'aria-label': 'Categoria' }, [opcao('', 'Todas as categorias')]);
    var tipo = el('select', { id: 'f_generico_id', 'aria-label': 'Tipo de produto' }, [opcao('', 'Todos os tipos')]);
    var marca = el('select', { id: 'f_marca', 'aria-label': 'Marca' }, [opcao('', 'Todas as marcas')]);
    var loja = el('select', { id: 'f_loja', 'aria-label': 'Loja' }, [opcao('', 'Todas as lojas')]);
    var plat = el('select', { id: 'f_plataforma', 'aria-label': 'Plataforma' }, [opcao('', 'Todas as plataformas')]);
    cat.addEventListener('change', function () { estado.filtros.categoria_id = cat.value || undefined; estado.filtros.generico_id = undefined; preencherTipos(); atualizar(); });
    tipo.addEventListener('change', function () { estado.filtros.generico_id = tipo.value || undefined; atualizar(); });
    marca.addEventListener('change', function () { estado.filtros.marca = marca.value || undefined; atualizar(); });
    loja.addEventListener('change', function () { estado.filtros.loja = loja.value || undefined; atualizar(); });
    plat.addEventListener('change', function () { estado.filtros.plataforma = plat.value || undefined; atualizar(); });
    var prod = el('span', { id: 'fProduto', class: 'caixa', hidden: '' });
    var limpar = el('button', { type: 'button', class: 'secundario', texto: 'Limpar filtros', onclick: function () { estado.filtros = {}; sincronizarFiltros(); atualizar(); } });

    f.appendChild(el('label', null, ['Período', per]));
    f.appendChild(el('label', { id: 'lblInicio', hidden: estado.dias === 0 ? null : '' }, ['De', ini])); f.appendChild(el('label', { id: 'lblFim', hidden: estado.dias === 0 ? null : '' }, ['Até', fim]));
    f.appendChild(el('label', { class: 'caixa' }, [comp, 'Comparar com o período anterior']));
    f.appendChild(el('label', null, ['Categoria', cat])); f.appendChild(el('label', null, ['Tipo de produto', tipo]));
    f.appendChild(el('label', null, ['Marca', marca])); f.appendChild(el('label', null, ['Loja', loja]));
    f.appendChild(el('label', null, ['Plataforma', plat]));
    f.appendChild(prod); f.appendChild(limpar);
    f.appendChild(el('p', { class: 'nota-filtro', id: 'notaFiltro' }));
    return f;
  }

  function preencherOpcoes() {
    if (!opcoes) return;
    var cat = $('f_categoria_id'), marca = $('f_marca'), loja = $('f_loja'), plat = $('f_plataforma');
    opcoes.categorias.forEach(function (c) { cat.appendChild(opcao(c.id, c.nome)); });
    (opcoes.marcas || []).forEach(function (m) { marca.appendChild(opcao(m, m)); });
    (opcoes.lojas || []).forEach(function (l) { loja.appendChild(opcao(l, l)); });
    (opcoes.plataformas || []).forEach(function (p) { plat.appendChild(opcao(p, p === 'android' ? 'Android' : p === 'ios' ? 'iOS' : 'Site')); });
    preencherTipos();
  }
  function preencherTipos() {
    var tipo = $('f_generico_id'); tipo.textContent = ''; tipo.appendChild(opcao('', 'Todos os tipos'));
    if (!opcoes) return;
    opcoes.genericos.filter(function (g) { return !estado.filtros.categoria_id || g.categoria_id === estado.filtros.categoria_id; })
      .forEach(function (g) { tipo.appendChild(opcao(g.id, g.nome, g.id === estado.filtros.generico_id)); });
  }
  function nomeCategoria(id) { var c = opcoes && opcoes.categorias.find(function (x) { return x.id === id; }); return c ? c.nome : id; }
  function nomeTipo(id) { var g = opcoes && opcoes.genericos.find(function (x) { return x.id === id; }); return g ? g.nome : id; }

  function sincronizarFiltros() {
    ['categoria_id', 'marca', 'loja', 'plataforma'].forEach(function (k) { var s = $('f_' + k); if (s) s.value = estado.filtros[k] || ''; });
    preencherTipos(); $('f_generico_id').value = estado.filtros.generico_id || '';
    var validos = FILTROS_DA_ABA[estado.aba] || [];
    ['categoria_id', 'generico_id', 'marca', 'loja', 'plataforma'].forEach(function (k) { var s = $('f_' + k); if (s) s.disabled = validos.indexOf(k) < 0; });
    var p = $('fProduto'); p.textContent = '';
    if (estado.filtros.produto_id && validos.indexOf('produto_id') >= 0) {
      p.hidden = false;
      p.appendChild(document.createTextNode('Produto: ' + (estado.filtros.produto_nome || estado.filtros.produto_id) + ' '));
      p.appendChild(el('button', { type: 'button', class: 'link-acao', texto: '✕ remover', onclick: function () { delete estado.filtros.produto_id; delete estado.filtros.produto_nome; sincronizarFiltros(); atualizar(); } }));
    } else p.hidden = true;
    var nota = { audiencia: 'Audiência não é filtrada por produto: uma pessoa ativa não pertence a uma categoria.',
      segmentos: 'Os segmentos têm filtros próprios, abaixo.', retail: 'Retail Media mostra só o período.', financeiro: 'Financeiro mostra só o período.' }[estado.aba];
    $('notaFiltro').textContent = nota || '';
  }

  function periodo() {
    if (estado.dias === 0) return { p_inicio: $('fInicio').value || null, p_fim: $('fFim').value || null };
    var fim = hojeISO(); return { p_inicio: menosDias(fim, estado.dias - 1), p_fim: fim };
  }
  function filtrosAtivos() {
    var f = {}, validos = FILTROS_DA_ABA[estado.aba] || [];
    validos.forEach(function (k) { if (estado.filtros[k]) f[k] = estado.filtros[k]; });
    return f;
  }

  // ---------- abas ----------
  function trocarAba(id) {
    estado.aba = id; guardar();
    ABAS.forEach(function (a) { $('aba-' + a.id).setAttribute('aria-selected', String(a.id === id)); });
    var original = id === 'acompanhamento';
    document.body.classList.toggle('aba-bi', !original);
    $('bi').hidden = original;
    $('conteudo').hidden = !original;
    if (!original) { sincronizarFiltros(); desenharAba(); }
  }
  function atualizar() { sincronizarFiltros(); desenharAba(); }

  var desenhando = 0;
  async function desenharAba() {
    var minha = ++desenhando;
    graficos.forEach(function (g) { g.dispose(); }); graficos = [];
    var corpo = $('biCorpo');
    corpo.setAttribute('aria-busy', 'true');
    try {
      var fn = { visao: abaVisao, audiencia: abaAudiencia, consumo: abaConsumo, ofertas: abaOfertas, performance: abaPerformance,
        segmentos: function () { return abaSegmentos(estado.estimativa); }, retail: abaRetail, financeiro: abaFinanceiro }[estado.aba];
      var conteudo = await fn();
      if (minha !== desenhando) return;
      corpo.textContent = '';
      corpo.appendChild(conteudo);
      graficos.forEach(function (g) { g.resize(); });
    } catch (e) {
      if (minha !== desenhando) return;
      corpo.textContent = '';
      corpo.appendChild(el('div', { class: 'aviso-bi', texto: e.message || String(e) }));
    } finally { corpo.removeAttribute('aria-busy'); }
  }

  function erroRpc(r) {
    var e = r.error;
    if (e.code === '42501') return new Error(e.message || 'Seu acesso não inclui este módulo.');
    if (e.code === 'PGRST202') return new Error('Este módulo ainda não foi ativado no banco (migrações 0032 a 0034).');
    return new Error('Não foi possível carregar: ' + e.message);
  }
  async function dados(nome, comFiltros) {
    var p = periodo();
    if (comFiltros) p.p_filtros = filtrosAtivos();
    var r = await rpc(nome, p);
    if (r.error) throw erroRpc(r);
    return r.data;
  }

  // ---------- peças: cartões de indicador ----------
  function kpis(ind, lista) {
    var g = el('div', { class: 'kpis' });
    lista.forEach(function (k) {
      var i = (ind || {})[k.chave] || { estado: 'sem_dados' };
      var ok = i.estado === 'ok';
      var rot = el('div', { class: 'rot' }, [el('span', { texto: k.rotulo }),
        i.estimativa || k.estimativa ? el('span', { class: 'selo', texto: 'estimativa' }) : null,
        k.dica ? el('span', { class: 'info', title: k.dica, tabindex: '0', 'aria-label': k.dica, texto: 'i' }) : null]);
      var linhas = [rot, el('div', { class: 'val', texto: ok ? formatar(i.valor, k.formato) : '—' })];
      if (ok && i.variacao_pct != null && estado.comparar) {
        var s = i.variacao_pct > 0 ? '▲ +' : i.variacao_pct < 0 ? '▼ ' : '● ';
        linhas.push(el('div', { class: 'var', texto: s + nf1.format(i.variacao_pct) + '% vs. período anterior (' + formatar(i.anterior, k.formato) + ')' }));
      } else if (ok && i.anterior != null && estado.comparar) {
        linhas.push(el('div', { class: 'var', texto: 'Período anterior: ' + formatar(i.anterior, k.formato) }));
      } else if (ok && i.base != null) {
        linhas.push(el('div', { class: 'mot', texto: 'Base: ' + nf.format(i.base) }));
      }
      if (ok && i.anonimizado) linhas.push(el('div', { class: 'mot', texto: 'Grupos pequenos aparecem como "<50".' }));
      if (!ok) linhas.push(el('div', { class: 'mot', texto: i.motivo || (i.estado === 'insuficiente' ? 'Ainda não dá para calcular.' : 'Sem dados no período.') }));
      g.appendChild(el('div', { class: 'kpi' }, linhas));
    });
    return g;
  }

  // ---------- peças: cartão de gráfico com tabela, CSV e PNG ----------
  function cartao(titulo, desc, opt) {
    opt = opt || {};
    var card = el('section', { class: 'card-bi' + (opt.largo ? ' largo' : '') }, [el('h3', { texto: titulo }), desc ? el('p', { class: 'desc', texto: desc }) : null]);
    if (opt.vazio) { card.appendChild(el('div', { class: 'vazio', texto: opt.vazio })); return card; }
    var acoes = el('div', { class: 'acoes' });
    if (opt.grafico) {
      var div = el('div', { class: 'grafico-bi' + (opt.alto ? ' alto' : ''), role: 'img', 'aria-label': titulo });
      card.appendChild(div);
      requestAnimationFrame(function () {
        var g = window.echarts.init(div, null, { renderer: 'canvas' });
        g.setOption(opt.grafico);
        if (opt.aoClicar) g.on('click', opt.aoClicar);
        graficos.push(g);
        acoes.insertBefore(el('button', { type: 'button', texto: 'PNG', title: 'Baixar imagem do gráfico', onclick: function () {
          baixar(g.getDataURL({ type: 'png', pixelRatio: 2, backgroundColor: cor('--superficie') }), nomeArquivo(titulo) + '.png');
        } }), acoes.firstChild);
      });
    }
    if (opt.corpo) card.appendChild(opt.corpo);
    if (opt.tabela) {
      var t = opt.tabela;
      if (opt.tabelaAberta) card.appendChild(tabelaAnalitica(t.colunas, t.linhas, { busca: t.linhas.length > 15 }));
      else acoes.appendChild(el('details', null, [el('summary', { texto: 'Ver tabela' }), tabelaAnalitica(t.colunas, t.linhas, { busca: t.linhas.length > 15 })]));
      acoes.insertBefore(el('button', { type: 'button', texto: 'CSV', title: 'Baixar os dados em CSV', onclick: function () { baixarCSV(t.colunas, t.linhas, nomeArquivo(titulo)); } }), acoes.firstChild);
    }
    card.appendChild(acoes);
    return card;
  }
  function nomeArquivo(t) { return 'caiu-' + t.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }
  function baixar(url, nome) { var a = el('a', { href: url, download: nome }); document.body.appendChild(a); a.click(); a.remove(); }
  function baixarCSV(colunas, linhas, nome) {
    var esc = function (v) { v = v == null ? '' : String(v); return /[";\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
    var txt = [colunas.map(function (c) { return esc(c.nome); }).join(';')].concat(linhas.map(function (l) {
      return colunas.map(function (c) { var v = l[c.campo]; return esc(typeof v === 'number' && c.formato !== 'texto' ? String(v).replace('.', ',') : v); }).join(';');
    })).join('\n');
    var url = URL.createObjectURL(new Blob(['﻿' + txt], { type: 'text/csv;charset=utf-8' }));
    baixar(url, nome + '.csv'); setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  }

  // tabela com ordenação por coluna e busca
  function tabelaAnalitica(colunas, linhas, opt) {
    opt = opt || {};
    var ordem = { campo: null, asc: false }, termo = '';
    var corpo = el('tbody');
    var ths = colunas.map(function (c) {
      var th = el('th', { class: c.formato && c.formato !== 'texto' && c.formato !== 'link' ? 'n' : null, scope: 'col', texto: c.nome, tabindex: '0' });
      var ordenar = function () {
        ordem.asc = ordem.campo === c.campo ? !ordem.asc : false; ordem.campo = c.campo;
        ths.forEach(function (x) { x.removeAttribute('aria-sort'); });
        th.setAttribute('aria-sort', ordem.asc ? 'ascending' : 'descending'); desenhar();
      };
      th.addEventListener('click', ordenar);
      th.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') ordenar(); });
      return th;
    });
    function desenhar() {
      corpo.textContent = '';
      var l = linhas.filter(function (x) { return !termo || colunas.some(function (c) { return String(x[c.campo] == null ? '' : x[c.campo]).toLowerCase().indexOf(termo) >= 0; }); });
      if (ordem.campo) l = l.slice().sort(function (a, b) {
        var va = a[ordem.campo], vb = b[ordem.campo];
        if (typeof va === 'string' && va.charAt(0) === '<') va = 0; if (typeof vb === 'string' && vb.charAt(0) === '<') vb = 0;
        if (va == null) return 1; if (vb == null) return -1;
        return (va > vb ? 1 : va < vb ? -1 : 0) * (ordem.asc ? 1 : -1);
      });
      l.forEach(function (x) {
        corpo.appendChild(el('tr', null, colunas.map(function (c) {
          var v = x[c.campo];
          if (c.formato === 'link') return el('td', null, [v ? el('a', { href: v, target: '_blank', rel: 'noopener', texto: 'abrir' }) : '—']);
          if (c.acao) return el('td', null, [el('button', { type: 'button', class: 'link-acao', texto: c.acaoTexto, onclick: function () { c.acao(x); } })]);
          if (c.formato === 'bool') return el('td', { texto: v == null ? '—' : v ? 'sim' : 'não' });
          if (c.formato === 'data') return el('td', { texto: v ? new Date(v).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—' });
          return el('td', { class: c.formato && c.formato !== 'texto' ? 'n' : (c.campo === 'nome' || c.campo === 'descricao') ? 'nome' : null, texto: c.formato === 'texto' || !c.formato ? (v == null ? '—' : String(v)) : formatar(v, c.formato) });
        })));
      });
      if (!l.length) corpo.appendChild(el('tr', null, [el('td', { colspan: String(colunas.length), texto: 'Nada para mostrar.' })]));
    }
    desenhar();
    var caixa = el('div', { class: 'tabela-bi' });
    if (opt.busca) {
      var b = el('input', { type: 'search', class: 'busca-tab', placeholder: 'Procurar na tabela…', 'aria-label': 'Procurar na tabela' });
      b.addEventListener('input', function () { termo = b.value.trim().toLowerCase(); desenhar(); });
      caixa.appendChild(b);
    }
    caixa.appendChild(el('table', null, [el('thead', null, [el('tr', null, ths)]), corpo]));
    return caixa;
  }

  // lista com barras para contagens que podem vir como "<50"
  function listaBarras(itens) {
    var nums = itens.map(function (i) { return typeof i.valor === 'number' ? i.valor : 0; });
    var max = Math.max.apply(null, [1].concat(nums));
    var l = el('div', { class: 'lista-bi' });
    itens.forEach(function (i) {
      var barra = el('i'); barra.style.width = (typeof i.valor === 'number' ? Math.max(1, 100 * i.valor / max) : 2) + '%';
      if (typeof i.valor !== 'number') barra.style.opacity = '.35';
      l.appendChild(el('div', { class: 'it' }, [el('span', { texto: i.rotulo }), el('div', { class: 'trilho' }, [barra]), el('b', { texto: formatar(i.valor) })]));
    });
    return l;
  }

  // ---------- peças: opções ECharts (marcas finas, grade discreta, uma escala) ----------
  function base() {
    return {
      color: serieCores(), animationDuration: 300,
      textStyle: { fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif', color: cor('--texto') },
      grid: { left: 8, right: 16, top: 28, bottom: 8, containLabel: true },
      tooltip: { backgroundColor: cor('--superficie'), borderColor: cor('--linha'), textStyle: { color: cor('--texto'), fontSize: 13 }, confine: true }
    };
  }
  function eixoValor(formato) {
    return { type: 'value', splitLine: { lineStyle: { color: cor('--grade') } }, axisLabel: { color: cor('--suave'), formatter: function (v) { return formato === 'brl' ? 'R$ ' + nf.format(v) : formato === 'pct' ? v + '%' : nf.format(v); } } };
  }
  function eixoCategoria(rotulos) {
    return { type: 'category', data: rotulos, axisLine: { lineStyle: { color: cor('--linha') } }, axisTick: { show: false }, axisLabel: { color: cor('--suave'), hideOverlap: true } };
  }
  function legenda(n) { return n >= 2 ? { top: 0, right: 0, icon: 'roundRect', itemWidth: 12, itemHeight: 8, textStyle: { color: cor('--texto-2') } } : { show: false }; }

  // linhas no tempo; "anterior" = série do período anterior (cinza, fina)
  function optLinha(dias, series, opt) {
    opt = opt || {};
    var o = base();
    o.tooltip.trigger = 'axis'; o.tooltip.axisPointer = { type: 'line', lineStyle: { color: cor('--suave') } };
    o.tooltip.valueFormatter = function (v) { return formatar(v, opt.formato); };
    o.legend = legenda(series.length);
    o.xAxis = eixoCategoria(dias.map(dataBR)); o.xAxis.boundaryGap = false;
    o.yAxis = eixoValor(opt.formato);
    o.series = series.map(function (s, i) {
      return { name: s.nome, type: 'line', data: s.dados, showSymbol: false, symbolSize: 8, smooth: false,
        lineStyle: { width: s.anterior ? 1.5 : 2, color: s.anterior ? cor('--anterior') : undefined },
        itemStyle: s.anterior ? { color: cor('--anterior') } : undefined,
        areaStyle: opt.area && !s.anterior ? { opacity: 0.12 } : undefined, z: s.anterior ? 1 : 2 + i };
    });
    if (series.length >= 2) o.grid.top = 36;
    return o;
  }
  function optColunas(rotulos, series, opt) {
    opt = opt || {};
    var o = base();
    o.tooltip.trigger = 'axis'; o.tooltip.axisPointer = { type: 'shadow', shadowStyle: { color: 'rgba(127,127,127,.08)' } };
    o.tooltip.valueFormatter = function (v) { return formatar(v, opt.formato); };
    o.legend = legenda(series.length);
    o.xAxis = eixoCategoria(rotulos); o.yAxis = eixoValor(opt.formato);
    if (opt.todosRotulos) { o.xAxis.axisLabel.interval = 0; o.xAxis.axisLabel.rotate = 30; o.xAxis.axisLabel.hideOverlap = false; }
    o.series = series.map(function (s) {
      return { name: s.nome, type: 'bar', data: s.dados, stack: opt.empilhar ? 'total' : undefined, barMaxWidth: 18,
        itemStyle: { borderRadius: opt.empilhar ? 0 : [4, 4, 0, 0], borderColor: cor('--superficie'), borderWidth: opt.empilhar ? 1 : 0, color: s.cor } };
    });
    if (series.length >= 2) o.grid.top = 36;
    return o;
  }
  // ranking horizontal (barras finas, valor no fim da barra)
  function optRanking(itens, opt) {
    opt = opt || {};
    var o = base();
    o.tooltip.trigger = 'item'; o.tooltip.formatter = function (p) { return p.name + '<br><b>' + formatar(p.value, opt.formato) + '</b>' + (opt.dicaClique ? '<br><span style="opacity:.7">' + opt.dicaClique + '</span>' : ''); };
    o.grid.right = 56;
    o.xAxis = eixoValor(opt.formato); o.xAxis.axisLabel.show = false; o.xAxis.splitLine.show = false;
    o.yAxis = eixoCategoria(itens.map(function (i) { return i.rotulo; }));
    o.yAxis.inverse = true; o.yAxis.axisLabel = { color: cor('--texto-2'), width: 150, overflow: 'truncate' };
    o.series = [{ type: 'bar', data: itens.map(function (i) { return { value: i.valor, id: i.id }; }), barMaxWidth: 14,
      itemStyle: { borderRadius: [0, 4, 4, 0], color: cor('--serie-1') },
      label: { show: true, position: 'right', color: cor('--texto-2'), formatter: function (p) { return formatar(p.value, opt.formato); } },
      cursor: opt.dicaClique ? 'pointer' : 'default' }];
    return o;
  }
  function optRosca(itens) {
    var o = base();
    o.tooltip.trigger = 'item'; o.tooltip.formatter = function (p) { return p.name + '<br><b>' + nf.format(p.value) + '</b> (' + nf1.format(p.percent) + '%)'; };
    o.legend = legenda(itens.length); o.legend.top = 'bottom'; o.legend.right = 'center';
    o.series = [{ type: 'pie', radius: ['52%', '76%'], center: ['50%', '46%'], data: itens.map(function (i) { return { name: i.rotulo, value: i.valor }; }),
      itemStyle: { borderColor: cor('--superficie'), borderWidth: 2 },
      label: { color: cor('--texto-2'), formatter: function (p) { return nf1.format(p.percent) + '%'; } } }];
    return o;
  }
  function optFunil(etapas) {
    var o = base();
    var tons = ['#2F6FD0', '#3987e5', '#5598e7', '#6da7ec', '#86b6ef'];
    o.tooltip.trigger = 'item';
    o.tooltip.formatter = function (p) { var pri = etapas[0].valor || 1; return p.name + '<br><b>' + nf.format(p.value) + ' pessoas</b> (' + nf1.format(100 * p.value / pri) + '% do início)'; };
    o.series = [{ type: 'funnel', sort: 'none', left: '4%', width: '52%', top: 8, bottom: 8, minSize: '6%', gap: 2, funnelAlign: 'left',
      data: etapas.map(function (e, i) { return { name: e.rotulo, value: e.valor, itemStyle: { color: tons[i % tons.length] } }; }),
      label: { position: 'right', color: cor('--texto'), formatter: function (p) { return p.name + ': ' + nf.format(p.value); } },
      labelLine: { show: false },
      itemStyle: { borderColor: cor('--superficie'), borderWidth: 2 } }];
    return o;
  }
  function optCalor(xs, ys, valores, opt) {
    opt = opt || {};
    var o = base();
    var max = Math.max.apply(null, [1].concat(valores.map(function (v) { return v[2] || 0; })));
    o.tooltip.trigger = 'item';
    o.tooltip.formatter = function (p) { return ys[p.value[1]] + ' · ' + xs[p.value[0]] + '<br><b>' + (p.value[2] == null ? '—' : formatar(p.value[2], opt.formato)) + '</b>' + (opt.unidade ? ' ' + opt.unidade : ''); };
    o.grid = { left: 8, right: 8, top: 8, bottom: 44, containLabel: true };
    o.xAxis = eixoCategoria(xs); o.xAxis.splitArea = { show: false };
    o.yAxis = eixoCategoria(ys); o.yAxis.inverse = true;
    o.visualMap = { min: 0, max: opt.max || max, calculable: false, orient: 'horizontal', left: 'center', bottom: 0, itemHeight: 120, itemWidth: 10,
      textStyle: { color: cor('--suave') }, inRange: { color: [cor('--seq-baixo'), cor('--seq-alto')] }, formatter: function (v) { return formatar(Math.round(v), opt.formato); } };
    o.series = [{ type: 'heatmap', data: valores, itemStyle: { borderColor: cor('--superficie'), borderWidth: 2, borderRadius: 3 },
      label: { show: !!opt.rotulos, fontSize: 11, color: cor('--texto'), formatter: function (p) { return p.value[2] == null ? '' : formatar(p.value[2], opt.formato); } } }];
    return o;
  }

  function secao(t) { return el('h2', { class: 'secao-bi', texto: t }); }
  function grade(itens) { return el('div', { class: 'grade-bi' }, itens); }
  function aviso(t) { return t ? el('div', { class: 'aviso-bi', texto: t }) : null; }
  function vazioSe(lista, msg) { return !lista || !lista.length ? msg || 'Nada no período.' : null; }
  function todosZero(lista, campo) { return !lista || !lista.some(function (x) { return Number(x[campo || 'qtd']) > 0; }); }
  function rodape(d) {
    var t = 'Período ' + dataBR(d.periodo.inicio) + ' a ' + dataBR(d.periodo.fim) + ' · comparado com ' + dataBR(d.periodo_anterior.inicio) + ' a ' + dataBR(d.periodo_anterior.fim) +
      (d.processado_ate ? ' · dados processados até ' + dataBR(d.processado_ate) + ' (atualização de hora em hora)' : '');
    return el('p', { class: 'sub', texto: t });
  }
  // filtro cruzado: clicar numa categoria/tipo filtra a aba inteira (drill-down)
  function filtrarPor(campo, id) {
    if (campo === 'categoria_id') { estado.filtros.categoria_id = id; estado.filtros.generico_id = undefined; }
    else estado.filtros[campo] = id;
    atualizar();
  }
  function verHistorico(produto) {
    estado.filtros.produto_id = produto.produto_id; estado.filtros.produto_nome = produto.nome;
    if (estado.aba !== 'ofertas') trocarAba('ofertas'); else atualizar();
  }

  // ---------- A. Visão geral ----------
  async function abaVisao() {
    var d = await dados('painel_visao_geral', true);
    var s = d.series, dias = s.ativos_por_dia.map(function (x) { return x.dia; });
    var seriesAtivos = [{ nome: 'Pessoas ativas', dados: s.ativos_por_dia.map(function (x) { return x.dau; }) }];
    if (estado.comparar) seriesAtivos.push({ nome: 'Período anterior', anterior: true, dados: s.ativos_por_dia.map(function (x) { return x.dau_anterior; }) });
    var frag = document.createDocumentFragment();
    frag.appendChild(kpis(d.indicadores, [
      { chave: 'usuarios_cadastrados', rotulo: 'Usuários cadastrados', dica: 'Contas que aceitaram o termo até o fim do período (sem administradores).' },
      { chave: 'novos_usuarios', rotulo: 'Novos usuários', dica: 'Primeiro aceite do termo dentro do período.' },
      { chave: 'dau', rotulo: 'DAU (média)', formato: 'dec', dica: 'Média de pessoas distintas ativas por dia no período (dias vazios contam como zero).' },
      { chave: 'wau', rotulo: 'WAU', dica: 'Pessoas distintas ativas nos 7 dias até o fim do período.' },
      { chave: 'mau', rotulo: 'MAU', dica: 'Pessoas distintas ativas nos 30 dias até o fim do período.' },
      { chave: 'dau_mau', rotulo: 'DAU/MAU', formato: 'pct', dica: 'DAU médio dos últimos 30 dias ÷ MAU. Mede o hábito de uso.' },
      { chave: 'retencao_d7', rotulo: 'Retenção D7', formato: 'pct', dica: 'Dos cadastrados no período com 7 dias completos: % que usou o app exatamente 7 dias depois.' },
      { chave: 'produtos_monitorados', rotulo: 'Produtos monitorados', dica: 'Produtos que o coletor consulta hoje.' },
      { chave: 'ofertas_ativas', rotulo: 'Ofertas encontradas', dica: 'Ofertas ativas agora: vendedores do Mercado Livre + lojas parceiras.' },
      { chave: 'cliques_ofertas', rotulo: 'Cliques em ofertas', dica: 'Idas à loja a partir do app.' },
      { chave: 'quedas_preco', rotulo: 'Quedas de preço', dica: 'Produtos × dias com queda de 5% ou mais em relação ao dia anterior.' },
      { chave: 'economia_potencial', rotulo: 'Economia potencial', formato: 'brl', estimativa: true, dica: 'Soma, nos produtos acompanhados, de (média histórica − preço atual) quando positiva. Preço anunciado, sem frete.' },
      { chave: 'receita_total', rotulo: 'Receita total', formato: 'brl', dica: 'Receita realizada (assinaturas, afiliados e anúncios).' },
      { chave: 'receita_por_ativo', rotulo: 'Receita por ativo', formato: 'brl', dica: 'Receita realizada ÷ MAU.' }
    ]));
    frag.appendChild(grade([
      cartao('Pessoas ativas por dia', estado.comparar ? 'Linha cinza: o mesmo dia do período anterior.' : null, {
        largo: true, grafico: optLinha(dias, seriesAtivos),
        tabela: { colunas: [{ nome: 'Dia', campo: 'dia', formato: 'texto' }, { nome: 'Ativos', campo: 'dau', formato: 'num' }, { nome: 'Período anterior', campo: 'dau_anterior', formato: 'num' }], linhas: s.ativos_por_dia } }),
      cartao('Usuários cadastrados (acumulado)', 'Total de contas com termo aceito ao fim de cada dia.', {
        grafico: optLinha(dias, [{ nome: 'Cadastrados', dados: s.cadastrados_acumulado.map(function (x) { return x.qtd; }) }], { area: true }),
        tabela: { colunas: [{ nome: 'Dia', campo: 'dia', formato: 'texto' }, { nome: 'Cadastrados', campo: 'qtd', formato: 'num' }], linhas: s.cadastrados_acumulado } }),
      cartao('Novos usuários por dia', null, todosZero(s.novos_por_dia) ? { vazio: 'Nenhum cadastro novo no período.' } : {
        grafico: optColunas(dias.map(dataBR), [{ nome: 'Novos', dados: s.novos_por_dia.map(function (x) { return x.qtd; }) }]),
        tabela: { colunas: [{ nome: 'Dia', campo: 'dia', formato: 'texto' }, { nome: 'Novos', campo: 'qtd', formato: 'num' }], linhas: s.novos_por_dia } }),
      cartao('Cliques em ofertas por dia', 'Respeita os filtros de categoria, tipo, marca, loja e plataforma.', todosZero(s.cliques_por_dia) ? { vazio: 'Nenhum clique no período.' } : {
        grafico: optColunas(dias.map(dataBR), [{ nome: 'Cliques', dados: s.cliques_por_dia.map(function (x) { return x.qtd; }) }]),
        tabela: { colunas: [{ nome: 'Dia', campo: 'dia', formato: 'texto' }, { nome: 'Cliques', campo: 'qtd', formato: 'num' }], linhas: s.cliques_por_dia } })
    ]));
    frag.appendChild(rodape(d));
    return frag;
  }

  // ---------- B. Audiência ----------
  var DIAS_SEMANA = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
  async function abaAudiencia() {
    var d = await dados('painel_audiencia', false);
    var s = d.series, dias = s.atividade_por_dia.map(function (x) { return x.dia; });
    var frag = document.createDocumentFragment();
    frag.appendChild(kpis(d.indicadores, [
      { chave: 'usuarios_cadastrados', rotulo: 'Usuários cadastrados' }, { chave: 'novos_usuarios', rotulo: 'Novos usuários' },
      { chave: 'dau', rotulo: 'DAU (média)', formato: 'dec', dica: 'Média de pessoas ativas por dia.' }, { chave: 'wau', rotulo: 'WAU' }, { chave: 'mau', rotulo: 'MAU' },
      { chave: 'dau_mau', rotulo: 'DAU/MAU', formato: 'pct' },
      { chave: 'ativos_no_periodo', rotulo: 'Ativos no período', dica: 'Pessoas distintas com uso em qualquer dia do período.' },
      { chave: 'sessoes_por_usuario', rotulo: 'Sessões por usuário', formato: 'dec', dica: 'Sessões ÷ pessoas ativas. Sessão nova após 30 min sem uso.' },
      { chave: 'interacoes_por_usuario', rotulo: 'Interações por usuário', formato: 'dec', dica: 'Eventos ÷ pessoas ativas.' },
      { chave: 'tempo_medio_sessao_s', rotulo: 'Tempo médio de sessão', formato: 'dur', dica: 'Do 1º ao último evento da sessão; só sessões com 2 eventos ou mais.' },
      { chave: 'retencao_d1', rotulo: 'Retenção D1', formato: 'pct', dica: '% dos cadastrados que voltaram no dia seguinte.' },
      { chave: 'retencao_d7', rotulo: 'Retenção D7', formato: 'pct' }, { chave: 'retencao_d30', rotulo: 'Retenção D30', formato: 'pct' },
      { chave: 'churn', rotulo: 'Churn de usuários', formato: 'pct', dica: 'Ativos no período anterior que não voltaram neste ÷ ativos no período anterior.' }
    ]));
    var calor = s.calor_semana_hora || [];
    var horas = []; for (var h = 0; h < 24; h++) horas.push(String(h).padStart(2, '0') + 'h');
    var coortes = s.coortes || [];
    var plat = (s.plataformas || []).map(function (p) { return { rotulo: { android: 'Android', ios: 'iOS', web: 'Site' }[p.plataforma] || p.plataforma, valor: p.pessoas }; });
    frag.appendChild(grade([
      cartao('Evolução da audiência', 'DAU, WAU e MAU de cada dia (janelas móveis de 1, 7 e 30 dias).', {
        largo: true, grafico: optLinha(dias, [
          { nome: 'DAU', dados: s.atividade_por_dia.map(function (x) { return x.dau; }) },
          { nome: 'WAU', dados: s.atividade_por_dia.map(function (x) { return x.wau; }) },
          { nome: 'MAU', dados: s.atividade_por_dia.map(function (x) { return x.mau; }) }]),
        tabela: { colunas: [{ nome: 'Dia', campo: 'dia', formato: 'texto' }, { nome: 'DAU', campo: 'dau', formato: 'num' }, { nome: 'WAU', campo: 'wau', formato: 'num' }, { nome: 'MAU', campo: 'mau', formato: 'num' }], linhas: s.atividade_por_dia } }),
      cartao('Quando o app é usado', 'Eventos por dia da semana e hora (horário de Brasília).', !calor.length ? { vazio: 'Nenhum uso no período.' } : {
        largo: true, alto: true,
        grafico: optCalor(horas, DIAS_SEMANA, calor.map(function (c) { return [c.hora, c.dia_semana, c.qtd]; }), { unidade: 'eventos' }),
        tabela: { colunas: [{ nome: 'Dia da semana', campo: 'dsn', formato: 'texto' }, { nome: 'Hora', campo: 'hora', formato: 'num' }, { nome: 'Eventos', campo: 'qtd', formato: 'num' }],
          linhas: calor.map(function (c) { return { dsn: DIAS_SEMANA[c.dia_semana], hora: c.hora, qtd: c.qtd }; }) } }),
      cartao('Retenção por semana de cadastro', '% de cada grupo ativo na semana 0, 1, 2… depois do cadastro.', !coortes.length ? { vazio: 'Nenhum cadastro nas últimas 8 semanas.' } : {
        grafico: optCalor(['S0', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7'], coortes.map(function (c) { return dataBR(c.semana) + ' (' + c.tamanho + ')'; }),
          [].concat.apply([], coortes.map(function (c, y) { return (c.retencao || []).map(function (v, x) { return [x, y, v]; }); })), { formato: 'pct', max: 100, rotulos: true }),
        tabela: { colunas: [{ nome: 'Semana', campo: 'semana', formato: 'texto' }, { nome: 'Pessoas', campo: 'tamanho', formato: 'num' }].concat([0, 1, 2, 3, 4, 5, 6, 7].map(function (k) { return { nome: 'S' + k + ' %', campo: 's' + k, formato: 'pct' }; })),
          linhas: coortes.map(function (c) { var l = { semana: c.semana, tamanho: c.tamanho }; (c.retencao || []).forEach(function (v, k) { l['s' + k] = v; }); return l; }) } }),
      cartao('Plataformas', 'Pessoas ativas no período por plataforma.', plat.length < 2 ? { corpo: listaBarras(plat.length ? plat : [{ rotulo: 'Sem uso', valor: 0 }]) } : {
        grafico: optRosca(plat), tabela: { colunas: [{ nome: 'Plataforma', campo: 'rotulo', formato: 'texto' }, { nome: 'Pessoas', campo: 'valor', formato: 'num' }], linhas: plat } }),
      cartao('Novos usuários por dia', null, todosZero(s.novos_por_dia) ? { vazio: 'Nenhum cadastro novo no período.' } : {
        grafico: optColunas(dias.map(dataBR), [{ nome: 'Novos', dados: s.novos_por_dia.map(function (x) { return x.qtd; }) }]),
        tabela: { colunas: [{ nome: 'Dia', campo: 'dia', formato: 'texto' }, { nome: 'Novos', campo: 'qtd', formato: 'num' }], linhas: s.novos_por_dia } })
    ]));
    frag.appendChild(rodape(d));
    return frag;
  }

  // ---------- C. Consumo ----------
  var NIVEIS = { inicial: 'Interesse inicial', recorrente: 'Interesse recorrente', elevado: 'Interesse elevado', muito_elevado: 'Interesse muito elevado' };
  async function abaConsumo() {
    var d = await dados('painel_consumo', true);
    var t = d.tabelas, porTipo = t.nivel_ranking === 'generico';
    var frag = document.createDocumentFragment();
    frag.appendChild(aviso(d.aviso));
    frag.appendChild(kpis(d.indicadores, [
      { chave: 'interacoes', rotulo: 'Interações de interesse', dica: 'Buscas, visualizações, filtros, acompanhamentos, avisos abertos, cliques e cupons copiados.' },
      { chave: 'buscas', rotulo: 'Buscas' },
      { chave: 'pessoas_interesse_recorrente', rotulo: 'Pessoas com interesse recorrente ou maior', dica: 'Score atual. Grupos com menos de 50 pessoas aparecem como "<50".' }
    ]));
    var rk = t.ranking_categorias || [];
    var cresc = rk.filter(function (x) { return x.crescimento_pct != null; }).sort(function (a, b) { return b.crescimento_pct - a.crescimento_pct; }).slice(0, 10);
    var faixas = t.faixas_preco || [];
    frag.appendChild(grade([
      cartao(porTipo ? 'Tipos mais procurados em ' + nomeCategoria(estado.filtros.categoria_id) : 'Categorias mais procuradas',
        porTipo ? 'Clique num tipo para filtrar a aba por ele.' : 'Clique numa categoria para ver os tipos dela (drill-down).', vazioSe(rk) ? { vazio: 'Nenhuma interação no período.' } : {
        grafico: optRanking(rk.slice(0, 12).map(function (x) { return { rotulo: x.nome, valor: x.eventos, id: x.id }; }), { dicaClique: porTipo ? 'Clique para filtrar' : 'Clique para ver os tipos' }),
        aoClicar: function (p) { filtrarPor(porTipo ? 'generico_id' : 'categoria_id', p.data.id); },
        tabela: { colunas: [{ nome: porTipo ? 'Tipo' : 'Categoria', campo: 'nome', formato: 'texto' }, { nome: 'Interações', campo: 'eventos', formato: 'num' },
          { nome: 'Período anterior', campo: 'anterior', formato: 'num' }, { nome: 'Crescimento', campo: 'crescimento_pct', formato: 'pct' }], linhas: rk } }),
      cartao('Maior crescimento', 'Variação das interações em relação ao período anterior (só quem tinha interações antes).', vazioSe(cresc) ? { vazio: 'Sem período anterior com interações para comparar.' } : {
        grafico: optRanking(cresc.map(function (x) { return { rotulo: x.nome, valor: x.crescimento_pct, id: x.id }; }), { formato: 'pct' }),
        tabela: { colunas: [{ nome: 'Nome', campo: 'nome', formato: 'texto' }, { nome: 'Crescimento', campo: 'crescimento_pct', formato: 'pct' }], linhas: cresc } }),
      cartao('Marcas mais pesquisadas', 'Interações com produtos de cada marca. Clique para filtrar.', vazioSe(t.ranking_marcas) ? { vazio: 'Nenhuma marca no período.' } : {
        grafico: optRanking(t.ranking_marcas.slice(0, 12).map(function (x) { return { rotulo: x.marca, valor: x.eventos, id: x.marca }; }), { dicaClique: 'Clique para filtrar pela marca' }),
        aoClicar: function (p) { filtrarPor('marca', p.data.id); },
        tabela: { colunas: [{ nome: 'Marca', campo: 'marca', formato: 'texto' }, { nome: 'Interações', campo: 'eventos', formato: 'num' }, { nome: 'Buscas e visualizações', campo: 'buscas_e_visualizacoes', formato: 'num' }], linhas: t.ranking_marcas } }),
      cartao('Faixas de preço mais procuradas', 'Visualizações de produtos (pelo preço atual) e preços-alvo definidos, por faixa.', vazioSe(faixas) ? { vazio: 'Sem dados de preço no período.' } : {
        grafico: optColunas(faixas.map(function (x) { return x.faixa; }), [
          { nome: 'Visualizações', dados: faixas.map(function (x) { return x.visualizacoes; }) },
          { nome: 'Preços-alvo', dados: faixas.map(function (x) { return x.precos_alvo; }) }], { todosRotulos: true }),
        tabela: { colunas: [{ nome: 'Faixa', campo: 'faixa', formato: 'texto' }, { nome: 'Visualizações', campo: 'visualizacoes', formato: 'num' }, { nome: 'Preços-alvo', campo: 'precos_alvo', formato: 'num' }], linhas: faixas } }),
      cartao('Níveis de intenção', 'Nível mais alto de cada pessoa no recorte escolhido (score atual).', {
        corpo: listaBarras((t.distribuicao_niveis || []).map(function (x) { return { rotulo: NIVEIS[x.nivel], valor: x.pessoas }; })),
        tabela: { colunas: [{ nome: 'Nível', campo: 'nome', formato: 'texto' }, { nome: 'Pessoas', campo: 'pessoas', formato: 'texto' }],
          linhas: (t.distribuicao_niveis || []).map(function (x) { return { nome: NIVEIS[x.nivel], pessoas: x.pessoas }; }) } }),
      cartao('Frequência de acompanhamento', 'Em quantos dias diferentes a pessoa voltou ao mesmo interesse de categoria.', vazioSe(t.frequencia) ? { vazio: 'Sem interesses calculados.' } : {
        corpo: listaBarras(t.frequencia.map(function (x) { return { rotulo: x.faixa, valor: x.pessoas }; })) })
    ]));
    frag.appendChild(grade([
      cartao('Produtos com maior intenção de compra', 'Soma dos pontos do score por produto. Clique para ver o histórico de preço.', vazioSe(t.produtos_maior_intencao) ? { largo: true, vazio: 'Sem score calculado ainda.' } : {
        largo: true, tabelaAberta: true,
        tabela: { colunas: [{ nome: 'Produto', campo: 'nome', formato: 'texto' }, { nome: 'Pontos', campo: 'pontos', formato: 'dec' }, { nome: 'Pessoas', campo: 'pessoas', formato: 'texto' },
          { nome: 'Interesse elevado+', campo: 'pessoas_elevado', formato: 'texto' }, { nome: '', campo: 'x', acao: verHistorico, acaoTexto: 'histórico de preço' }], linhas: t.produtos_maior_intencao } }),
      cartao('Produtos mais acompanhados', 'Acompanhamentos ativos agora.', vazioSe(t.produtos_mais_acompanhados) ? { largo: true, vazio: 'Ninguém acompanha produtos neste recorte.' } : {
        largo: true, tabelaAberta: true,
        tabela: { colunas: [{ nome: 'Produto', campo: 'nome', formato: 'texto' }, { nome: 'Acompanhamentos', campo: 'acompanhamentos', formato: 'num' }, { nome: 'Preço atual', campo: 'preco_atual', formato: 'brl' },
          { nome: '', campo: 'x', acao: verHistorico, acaoTexto: 'histórico de preço' }], linhas: t.produtos_mais_acompanhados } })
    ]));
    frag.appendChild(rodape(d));
    return frag;
  }

  // ---------- D. Ofertas ----------
  async function abaOfertas() {
    var d = await dados('painel_ofertas', true);
    var s = d.series, t = d.tabelas, dias = s.quedas_por_dia.map(function (x) { return x.dia; });
    var frag = document.createDocumentFragment();
    frag.appendChild(aviso(d.aviso));
    frag.appendChild(kpis(d.indicadores, [
      { chave: 'produtos_cadastrados', rotulo: 'Produtos na base' }, { chave: 'produtos_monitorados', rotulo: 'Produtos monitorados' },
      { chave: 'ofertas_ativas', rotulo: 'Ofertas ativas', dica: 'Vendedores do Mercado Livre + produtos das lojas parceiras.' },
      { chave: 'quedas_preco', rotulo: 'Quedas de preço', dica: 'Produtos × dias com queda de 5% ou mais.' },
      { chave: 'cupons_ativos', rotulo: 'Cupons disponíveis' },
      { chave: 'taxa_sucesso_consultas', rotulo: 'Sucesso das consultas', formato: 'pct', dica: 'Consultas às fontes com resposta 200 ÷ total.' },
      { chave: 'consultas_fonte', rotulo: 'Consultas às fontes' },
      { chave: 'economia_potencial', rotulo: 'Economia potencial', formato: 'brl', estimativa: true },
      { chave: 'cliques_ofertas', rotulo: 'Cliques em ofertas' }
    ]));
    var cards = [];
    if (s.historico_produto) {
      var hp = s.historico_produto;
      cards.push(cartao('Histórico de preço: ' + (estado.filtros.produto_nome || estado.filtros.produto_id), 'Menor preço ao fim de cada dia, preço médio entre vendedores e preço "de".', vazioSe(hp) ? { largo: true, vazio: 'Sem coletas deste produto.' } : {
        largo: true, grafico: optLinha(hp.map(function (x) { return x.dia; }), [
          { nome: 'Menor preço', dados: hp.map(function (x) { return x.menor; }) }, { nome: 'Preço médio', dados: hp.map(function (x) { return x.medio; }) },
          { nome: 'Preço "de"', dados: hp.map(function (x) { return x.preco_de; }) }], { formato: 'brl' }),
        tabela: { colunas: [{ nome: 'Dia', campo: 'dia', formato: 'texto' }, { nome: 'Menor', campo: 'menor', formato: 'brl' }, { nome: 'Mínimo do dia', campo: 'minimo_do_dia', formato: 'brl' },
          { nome: 'Médio', campo: 'medio', formato: 'brl' }, { nome: 'Preço "de"', campo: 'preco_de', formato: 'brl' }], linhas: hp } }));
    }
    var mk = t.marketplaces || [];
    cards.push(
      cartao('Quedas de preço por dia', null, todosZero(s.quedas_por_dia) ? { vazio: 'Nenhuma queda de 5% ou mais no período.' } : {
        grafico: optColunas(dias.map(dataBR), [{ nome: 'Quedas', dados: s.quedas_por_dia.map(function (x) { return x.qtd; }) }]),
        tabela: { colunas: [{ nome: 'Dia', campo: 'dia', formato: 'texto' }, { nome: 'Quedas', campo: 'qtd', formato: 'num' }], linhas: s.quedas_por_dia } }),
      cartao('Consultas às fontes por dia', 'Respostas com sucesso e com erro (Mercado Livre e redes).', todosZero(s.consultas_por_dia, 'ok') && todosZero(s.consultas_por_dia, 'erro') ? { vazio: 'Nenhuma consulta no período.' } : {
        grafico: optColunas(dias.map(dataBR), [
          { nome: 'Sucesso', dados: s.consultas_por_dia.map(function (x) { return x.ok; }) },
          { nome: 'Erro', dados: s.consultas_por_dia.map(function (x) { return x.erro; }), cor: cor('--serie-8') }], { empilhar: true }),
        tabela: { colunas: [{ nome: 'Dia', campo: 'dia', formato: 'texto' }, { nome: 'Sucesso', campo: 'ok', formato: 'num' }, { nome: 'Erro', campo: 'erro', formato: 'num' }], linhas: s.consultas_por_dia } }),
      cartao('Marketplaces com mais ofertas', 'Ofertas ativas agora por loja (cliques do período na tabela).', vazioSe(mk) ? { vazio: 'Nenhuma oferta ativa.' } : {
        grafico: optRanking(mk.slice(0, 12).map(function (x) { return { rotulo: x.loja, valor: x.ofertas }; })),
        tabela: { colunas: [{ nome: 'Loja', campo: 'loja', formato: 'texto' }, { nome: 'Ofertas', campo: 'ofertas', formato: 'num' }, { nome: 'Cliques no período', campo: 'cliques', formato: 'num' }], linhas: mk } })
    );
    frag.appendChild(grade(cards));
    frag.appendChild(grade([
      cartao('Ofertas com maior engajamento', 'Visualizações + 3 × cliques no período. Frete e preço final não vêm da API (só "frete grátis").', vazioSe(t.ofertas_engajamento) ? { largo: true, vazio: 'Nenhuma oferta vista no período.' } : {
        largo: true, tabelaAberta: true,
        tabela: { colunas: [{ nome: 'Produto', campo: 'nome', formato: 'texto' }, { nome: 'Origem', campo: 'marketplace', formato: 'texto' },
          { nome: 'Visualizações', campo: 'visualizacoes', formato: 'num' }, { nome: 'Cliques', campo: 'cliques', formato: 'num' },
          { nome: 'Preço original', campo: 'preco_original', formato: 'brl' }, { nome: 'Preço promocional', campo: 'preco_promocional', formato: 'brl' },
          { nome: 'Frete grátis', campo: 'frete_gratis', formato: 'bool' }, { nome: 'Disponível', campo: 'disponivel', formato: 'bool' },
          { nome: 'Vendedores', campo: 'vendedores', formato: 'num' }, { nome: 'Atualizado', campo: 'atualizado_em', formato: 'data' },
          { nome: 'Link', campo: 'link', formato: 'link' }, { nome: '', campo: 'x', acao: verHistorico, acaoTexto: 'histórico' }], linhas: t.ofertas_engajamento } }),
      cartao('Maiores quedas no período', 'Maior queda diária de cada produto.', vazioSe(t.maiores_quedas) ? { largo: true, vazio: 'Nenhuma queda de 5% ou mais.' } : {
        largo: true, tabelaAberta: true,
        tabela: { colunas: [{ nome: 'Produto', campo: 'nome', formato: 'texto' }, { nome: 'Dia', campo: 'dia', formato: 'texto' }, { nome: 'Queda', campo: 'queda_pct', formato: 'pct' },
          { nome: 'Preço', campo: 'preco', formato: 'brl' }, { nome: 'Frete grátis', campo: 'frete_gratis', formato: 'bool' }, { nome: 'Link', campo: 'link', formato: 'link' },
          { nome: '', campo: 'x', acao: verHistorico, acaoTexto: 'histórico' }], linhas: t.maiores_quedas } })
    ]));
    frag.appendChild(rodape(d));
    return frag;
  }

  // ---------- E. Performance ----------
  var GRUPOS = { usuarios: 'Usuários', navegacao: 'Navegação', intencao: 'Intenção de compra', cupons: 'Cupons', anuncios: 'Anúncios' };
  var MOTIVOS = { preco_alvo: 'Chegou no preço-alvo', abaixo_media: 'Abaixo da média', generico_queda: 'Queda no tipo acompanhado' };
  async function abaPerformance() {
    var d = await dados('painel_performance', true);
    var s = d.series, t = d.tabelas;
    var frag = document.createDocumentFragment();
    frag.appendChild(kpis(d.indicadores, [
      { chave: 'conversao_visualizacao_acompanhamento', rotulo: 'Visualização → acompanhamento', formato: 'pct', dica: 'Pessoa × produto visto no período que virou acompanhamento do mesmo produto em até 7 dias.' },
      { chave: 'conversao_aviso_clique', rotulo: 'Aviso → clique', formato: 'pct', dica: 'Avisos abertos seguidos de clique no mesmo produto em até 48 h.' },
      { chave: 'avisos_gerados', rotulo: 'Avisos gerados' },
      { chave: 'taxa_leitura_avisos', rotulo: 'Avisos lidos', formato: 'pct' },
      { chave: 'aquisicao', rotulo: 'Aquisição por canal' }
    ]));
    var funil = (s.funil || []).map(function (x) { return { rotulo: x.etapa, valor: x.pessoas }; });
    var grupos = Object.keys(GRUPOS).filter(function (g) { return (s.eventos_por_grupo || []).some(function (x) { return x.grupo === g; }); });
    var diasG = []; (s.eventos_por_grupo || []).forEach(function (x) { if (diasG.indexOf(x.dia) < 0) diasG.push(x.dia); }); diasG.sort();
    frag.appendChild(grade([
      cartao('Funil de conversão', 'Pessoas distintas em cada etapa, no período.', !funil.length || !funil[0].valor ? { vazio: 'Ninguém viu produtos no período.' } : {
        grafico: optFunil(funil), tabela: { colunas: [{ nome: 'Etapa', campo: 'rotulo', formato: 'texto' }, { nome: 'Pessoas', campo: 'valor', formato: 'num' }], linhas: funil } }),
      cartao('Engajamento por tipo de ação', 'Eventos por dia, empilhados por grupo do catálogo.', !diasG.length ? { vazio: 'Nenhum evento no período.' } : {
        grafico: optColunas(diasG.map(dataBR), grupos.map(function (g) {
          return { nome: GRUPOS[g], dados: diasG.map(function (dia) { var x = s.eventos_por_grupo.find(function (y) { return y.dia === dia && y.grupo === g; }); return x ? x.qtd : 0; }) };
        }), { empilhar: true }),
        tabela: { colunas: [{ nome: 'Dia', campo: 'dia', formato: 'texto' }, { nome: 'Grupo', campo: 'grupoNome', formato: 'texto' }, { nome: 'Eventos', campo: 'qtd', formato: 'num' }],
          linhas: (s.eventos_por_grupo || []).map(function (x) { return { dia: x.dia, grupoNome: GRUPOS[x.grupo] || x.grupo, qtd: x.qtd }; }) } }),
      cartao('Desempenho dos avisos', 'Por motivo, no período.', vazioSe(t.avisos_por_motivo) ? { vazio: 'Nenhum aviso gerado no período.' } : {
        tabelaAberta: true,
        tabela: { colunas: [{ nome: 'Motivo', campo: 'nome', formato: 'texto' }, { nome: 'Gerados', campo: 'gerados', formato: 'num' }, { nome: 'Lidos', campo: 'lidos', formato: 'num' },
          { nome: 'Taxa de leitura', campo: 'taxa_leitura', formato: 'pct' }, { nome: 'Minutos até ler (mediana)', campo: 'minutos_ate_ler_mediana', formato: 'num' }],
          linhas: t.avisos_por_motivo.map(function (x) { return Object.assign({ nome: MOTIVOS[x.motivo] || x.motivo }, x); }) } }),
      cartao('Produtos mais visualizados', null, vazioSe(t.produtos_mais_vistos) ? { vazio: 'Nenhuma visualização no período.' } : {
        grafico: optRanking(t.produtos_mais_vistos.slice(0, 10).map(function (x) { return { rotulo: x.nome, valor: x.visualizacoes }; })),
        tabela: { colunas: [{ nome: 'Produto', campo: 'nome', formato: 'texto' }, { nome: 'Visualizações', campo: 'visualizacoes', formato: 'num' },
          { nome: 'Acompanhamentos novos', campo: 'acompanhamentos_novos', formato: 'num' }, { nome: 'Cliques', campo: 'cliques', formato: 'num' }], linhas: t.produtos_mais_vistos } }),
      cartao('Produtos mais monitorados no período', 'Acompanhamentos novos.', vazioSe(t.produtos_mais_monitorados) ? { vazio: 'Nenhum acompanhamento novo no período.' } : {
        grafico: optRanking(t.produtos_mais_monitorados.slice(0, 10).map(function (x) { return { rotulo: x.nome, valor: x.acompanhamentos_novos }; })),
        tabela: { colunas: [{ nome: 'Produto', campo: 'nome', formato: 'texto' }, { nome: 'Acompanhamentos novos', campo: 'acompanhamentos_novos', formato: 'num' }], linhas: t.produtos_mais_monitorados } })
    ]));
    frag.appendChild(rodape(d));
    return frag;
  }

  // ---------- Segmentos ----------
  async function abaSegmentos(filtrosEstimativa) {
    var r = await rpc('painel_segmentos', { p_filtros: filtrosEstimativa || null });
    if (r.error) throw erroRpc(r);
    var d = r.data;
    var frag = document.createDocumentFragment();
    frag.appendChild(aviso(d.aviso + ' O tamanho dos segmentos é recalculado todo dia às 03h17 e estima o alcance de campanhas futuras.'));
    var segs = d.segmentos || [];
    frag.appendChild(grade([cartao('Segmentos de audiência', 'Pessoas com interesse no segmento (score atual) e quantas podem receber publicidade segmentada (18+ com nascimento informado).', vazioSe(segs) ? { largo: true, vazio: 'Nenhum segmento.' } : {
      largo: true, tabelaAberta: true,
      tabela: { colunas: [{ nome: 'Segmento', campo: 'nome', formato: 'texto' }, { nome: 'Descrição', campo: 'descricao', formato: 'texto' },
        { nome: 'Pessoas', campo: 'pessoas', formato: 'texto' }, { nome: 'Elegíveis para publicidade', campo: 'elegiveis_publicidade', formato: 'texto' },
        { nome: 'Crescimento 30 dias', campo: 'crescimento_30d_pct', formato: 'pct' }, { nome: 'Calculado em', campo: 'calculado_em', formato: 'texto' },
        { nome: '', campo: 'x', acao: function (sg) { abrirEstimativa(sg.filtros); }, acaoTexto: 'detalhar' }],
        linhas: segs.map(function (x) { return Object.assign({}, x, { pessoas: formatar(x.pessoas), elegiveis_publicidade: formatar(x.elegiveis_publicidade) }); }) } })]));
    frag.appendChild(secao('Montar ou estimar um segmento'));
    frag.appendChild(formSegmento(d.estimativa));
    return frag;
  }
  function abrirEstimativa(f) { estado.estimativa = f; desenharSegmento(f); }
  async function desenharSegmento(f) {
    var minha = ++desenhando, corpo = $('biCorpo');
    graficos.forEach(function (g) { g.dispose(); }); graficos = [];
    try { var c = await abaSegmentos(f); if (minha !== desenhando) return; corpo.textContent = ''; corpo.appendChild(c); var alvo = $('resultadoSeg'); if (alvo) alvo.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
    catch (e) { corpo.textContent = ''; corpo.appendChild(aviso(e.message)); }
  }
  function formSegmento(est) {
    var f = (est && est.filtros) || estado.estimativa || {};
    var cats = el('select', { multiple: '', id: 'sCat' }), gens = el('select', { multiple: '', id: 'sGen' });
    (opcoes ? opcoes.categorias : []).forEach(function (c) { var o = opcao(c.id, c.nome, (f.categoria_id || []).indexOf(c.id) >= 0); cats.appendChild(o); });
    (opcoes ? opcoes.genericos : []).forEach(function (g) { gens.appendChild(opcao(g.id, nomeCategoria(g.categoria_id) + ' › ' + g.nome, (f.generico_id || []).indexOf(g.id) >= 0)); });
    var nivel = el('select', { id: 'sNivel' }, [opcao('inicial', 'Qualquer nível'), opcao('recorrente', 'Recorrente ou mais'), opcao('elevado', 'Elevado ou mais'), opcao('muito_elevado', 'Muito elevado')]);
    nivel.value = f.nivel_minimo || 'inicial';
    var rec = el('input', { type: 'number', min: '1', id: 'sRec', placeholder: 'ex.: 30', value: f.recencia_dias || '' });
    var freq = el('input', { type: 'number', min: '0', id: 'sFreq', placeholder: 'ex.: 2', value: f.dias_distintos_min || '' });
    var pmin = el('input', { type: 'number', min: '0', id: 'sPmin', placeholder: 'R$', value: f.preco_min || '' });
    var pmax = el('input', { type: 'number', min: '0', id: 'sPmax', placeholder: 'R$', value: f.preco_max || '' });
    var eleg = el('input', { type: 'checkbox', id: 'sEleg' }); eleg.checked = !!f.somente_elegiveis;
    var nome = el('input', { type: 'text', id: 'sNome', maxlength: '80', placeholder: 'Nome para salvar' });
    var msg = el('p', { class: 'sub', role: 'status' });
    function ler() {
      var x = {};
      var sel = function (s) { return Array.prototype.filter.call(s.options, function (o) { return o.selected; }).map(function (o) { return o.value; }); };
      if (sel(cats).length) x.categoria_id = sel(cats); if (sel(gens).length) x.generico_id = sel(gens);
      if (nivel.value !== 'inicial') x.nivel_minimo = nivel.value;
      if (rec.value) x.recencia_dias = Number(rec.value); if (freq.value) x.dias_distintos_min = Number(freq.value);
      if (pmin.value) x.preco_min = Number(pmin.value); if (pmax.value) x.preco_max = Number(pmax.value);
      if (eleg.checked) x.somente_elegiveis = true;
      return x;
    }
    var form = el('div', { class: 'card-bi' }, [el('div', { class: 'form-seg' }, [
      el('label', null, ['Categorias', cats]), el('label', null, ['Tipos de produto', gens]), el('label', null, ['Nível mínimo de interesse', nivel]),
      el('label', null, ['Último sinal há até (dias)', rec]), el('label', null, ['Dias distintos com interesse (mín.)', freq]),
      el('label', null, ['Faixa de preço: de', pmin]), el('label', null, ['até', pmax]),
      el('label', { class: 'caixa' }, [eleg, 'Só elegíveis para publicidade']),
      el('button', { type: 'button', texto: 'Estimar alcance', onclick: function () { abrirEstimativa(ler()); } }),
      el('label', null, ['Salvar como segmento', nome]),
      el('button', { type: 'button', class: 'secundario', texto: 'Salvar segmento', onclick: async function () {
        if (!nome.value.trim()) { msg.textContent = 'Dê um nome ao segmento.'; return; }
        var r = await sb.rpc('painel_segmento_salvar', { p_nome: nome.value.trim(), p_descricao: 'Criado no painel', p_filtros: ler() });
        if (r.error) { msg.textContent = 'Não foi possível salvar: ' + r.error.message; return; }
        cache = {}; abrirEstimativa(ler());
      } })]), msg]);
    var wrap = el('div', null, [form]);
    if (est) {
      var res = el('div', { id: 'resultadoSeg' });
      res.appendChild(secao('Estimativa do segmento'));
      res.appendChild(kpis({ pessoas: { valor: est.pessoas, estado: 'ok' }, elegiveis: { valor: est.elegiveis_publicidade, estado: 'ok' }, ativos7: { valor: est.ativos_7d, estado: 'ok' },
        eventos: est.eventos_por_pessoa_30d == null ? { estado: 'insuficiente', motivo: 'Só aparece com 50 pessoas ou mais no segmento.' } : { valor: est.eventos_por_pessoa_30d, estado: 'ok' } }, [
        { chave: 'pessoas', rotulo: 'Tamanho do segmento' }, { chave: 'elegiveis', rotulo: 'Alcance potencial (elegíveis)', dica: '18+ com data de nascimento informada.' },
        { chave: 'ativos7', rotulo: 'Ativos nos últimos 7 dias' }, { chave: 'eventos', rotulo: 'Interações por pessoa (30 dias)', formato: 'dec' }]));
      res.appendChild(grade([
        cartao('Distribuição por nível de interesse', null, { corpo: listaBarras((est.niveis || []).map(function (x) { return { rotulo: NIVEIS[x.nivel], valor: x.pessoas }; })) }),
        cartao('Faixa etária', 'Pela data de nascimento do cadastro.', { corpo: listaBarras((est.faixas_etarias || []).map(function (x) { return { rotulo: x.faixa, valor: x.pessoas }; })) })
      ]));
      wrap.appendChild(res);
    }
    return wrap;
  }

  // ---------- F. Retail Media ----------
  async function abaRetail() {
    var d = await dados('painel_retail_media', false);
    var t = d.tabelas;
    var frag = document.createDocumentFragment();
    frag.appendChild(aviso('Estrutura pronta para anunciantes, campanhas, produtos patrocinados, impressões, cliques e conversões. Nenhum anúncio é exibido no app: todas as posições estão desligadas até a aprovação do portal de anunciantes. Anunciantes só recebem números agregados.'));
    frag.appendChild(kpis(d.indicadores, [
      { chave: 'impressoes', rotulo: 'Impressões' }, { chave: 'alcance_unico', rotulo: 'Alcance único' }, { chave: 'cliques', rotulo: 'Cliques' },
      { chave: 'ctr', rotulo: 'CTR', formato: 'pct', dica: 'Cliques ÷ impressões.' }, { chave: 'cpc', rotulo: 'CPC', formato: 'brl', dica: 'Receita ÷ cliques.' },
      { chave: 'cpm', rotulo: 'CPM', formato: 'brl', dica: 'Receita ÷ impressões × 1.000.' }, { chave: 'cpa', rotulo: 'CPA', formato: 'brl', dica: 'Receita ÷ conversões.' },
      { chave: 'conversoes', rotulo: 'Conversões' }, { chave: 'receita', rotulo: 'Receita publicitária', formato: 'brl' },
      { chave: 'receita_por_ativo', rotulo: 'Receita por ativo', formato: 'brl' }
    ]));
    frag.appendChild(grade([
      cartao('Posições de anúncio', 'Onde os anúncios poderão aparecer.', { tabelaAberta: true,
        tabela: { colunas: [{ nome: 'Código', campo: 'codigo', formato: 'texto' }, { nome: 'Descrição', campo: 'descricao', formato: 'texto' }, { nome: 'Ligada', campo: 'ativa', formato: 'bool' }], linhas: t.posicoes || [] } }),
      cartao('Campanhas', (t.anunciantes || 0) + ' anunciante(s) cadastrado(s).', vazioSe(t.campanhas) ? { vazio: 'Nenhuma campanha cadastrada.' } : { tabelaAberta: true,
        tabela: { colunas: [{ nome: 'Campanha', campo: 'nome', formato: 'texto' }, { nome: 'Anunciante', campo: 'anunciante', formato: 'texto' }, { nome: 'Status', campo: 'status', formato: 'texto' },
          { nome: 'Modelo', campo: 'modelo', formato: 'texto' }, { nome: 'Impressões', campo: 'impressoes', formato: 'num' }, { nome: 'Cliques', campo: 'cliques', formato: 'num' }, { nome: 'Conversões', campo: 'conversoes', formato: 'num' }], linhas: t.campanhas } }),
      cartao('Receita por anunciante', null, vazioSe(t.receita_por_anunciante) ? { vazio: 'Sem receita publicitária no período.' } : {
        grafico: optRanking(t.receita_por_anunciante.map(function (x) { return { rotulo: x.anunciante, valor: x.receita }; }), { formato: 'brl' }) }),
      cartao('Receita por categoria', null, vazioSe(t.receita_por_categoria) ? { vazio: 'Sem receita publicitária no período.' } : {
        grafico: optRanking(t.receita_por_categoria.map(function (x) { return { rotulo: x.categoria, valor: x.receita }; }), { formato: 'brl' }) })
    ]));
    frag.appendChild(rodape(d));
    return frag;
  }

  // ---------- G. Financeiro ----------
  var FONTES = { assinatura: 'Assinaturas', afiliado: 'Afiliados', anuncio: 'Publicidade', patrocinio: 'Produtos patrocinados', categoria_patrocinada: 'Categorias patrocinadas',
    campanha_segmentada: 'Campanhas segmentadas', relatorio: 'Relatórios de inteligência' };
  async function abaFinanceiro() {
    var d = await dados('painel_financeiro', false);
    var s = d.series, t = d.tabelas;
    var frag = document.createDocumentFragment();
    frag.appendChild(aviso(d.aviso));
    frag.appendChild(kpis(d.indicadores, [
      { chave: 'receita_total', rotulo: 'Receita realizada', formato: 'brl' }, { chave: 'receita_estimada', rotulo: 'Receita estimada', formato: 'brl', estimativa: true },
      { chave: 'mrr', rotulo: 'MRR', formato: 'brl', dica: 'Soma das mensalidades das assinaturas ativas.' }, { chave: 'arpu', rotulo: 'ARPU', formato: 'brl', dica: 'Receita realizada ÷ MAU.' },
      { chave: 'churn_assinantes', rotulo: 'Churn de assinantes', formato: 'pct' }, { chave: 'ltv_estimado', rotulo: 'LTV estimado', formato: 'brl', estimativa: true, dica: 'ARPU ÷ churn mensal de assinantes. Só com 3 meses ou mais de dados.' },
      { chave: 'cac', rotulo: 'CAC', formato: 'brl', dica: 'Custo de aquisição informado ÷ novos usuários.' }
    ]));
    var rm = (s.receita_por_mes || []).filter(function (x) { return x.natureza === 'realizado'; });
    var meses = []; rm.forEach(function (x) { if (meses.indexOf(x.mes) < 0) meses.push(x.mes); }); meses.sort();
    var fontes = Object.keys(FONTES).filter(function (f) { return rm.some(function (x) { return x.fonte === f; }); });
    frag.appendChild(grade([
      cartao('Receita realizada por mês e fonte', 'Só valores realizados. Estimativas ficam na tabela ao lado.', !meses.length ? { vazio: 'Nenhuma receita realizada registrada.' } : {
        grafico: optColunas(meses.map(function (m) { return String(m).slice(5, 7) + '/' + String(m).slice(0, 4); }), fontes.map(function (f) {
          return { nome: FONTES[f], dados: meses.map(function (m) { var x = rm.find(function (y) { return y.mes === m && y.fonte === f; }); return x ? x.valor : 0; }) };
        }), { empilhar: true, formato: 'brl' }) }),
      cartao('Contribuição de cada fonte no período', 'Realizado × estimado.', vazioSe(t.receita_por_fonte) ? { vazio: 'Nenhum lançamento no período.' } : { tabelaAberta: true,
        tabela: { colunas: [{ nome: 'Fonte', campo: 'nome', formato: 'texto' }, { nome: 'Realizado', campo: 'realizado', formato: 'brl' }, { nome: 'Estimado', campo: 'estimado', formato: 'brl' }],
          linhas: t.receita_por_fonte.map(function (x) { return Object.assign({ nome: FONTES[x.fonte] || x.fonte }, x); }) } }),
      cartao('Vendas por afiliados', 'Importadas dos relatórios das redes (pendente, aprovada, cancelada).', vazioSe(t.afiliados) ? { vazio: 'Relatórios das redes de afiliados ainda não integrados.' } : { tabelaAberta: true,
        tabela: { colunas: [{ nome: 'Rede', campo: 'rede', formato: 'texto' }, { nome: 'Status', campo: 'status', formato: 'texto' }, { nome: 'Vendas', campo: 'vendas', formato: 'num' },
          { nome: 'Valor das vendas', campo: 'valor_vendas', formato: 'brl' }, { nome: 'Comissão', campo: 'comissao', formato: 'brl' }], linhas: t.afiliados } })
    ]));
    frag.appendChild(rodape(d));
    return frag;
  }

  // ---------- início (chamado pelo index.html depois do login) ----------
  window.caiuBI = {
    iniciar: async function (cliente) {
      if (sb) return;
      sb = cliente;
      montar();
      try { await carregarScript(URL_ECHARTS); }
      catch (e) { $('biCorpo').appendChild(aviso(e.message)); return; }
      var r = await rpc('painel_filtros_opcoes', {});
      if (!r.error) opcoes = r.data;
      preencherOpcoes();
      trocarAba(estado.aba);
    },
    limpar: function () { cache = {}; }
  };
})();
