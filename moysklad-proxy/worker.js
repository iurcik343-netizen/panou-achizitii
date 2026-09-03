const API = 'https://api.moysklad.ru/api/remap/1.2';

// Numele exacte ale punctelor de vânzare din MoySklad (Retail → Точки продаж),
// folosite pentru reconcilierea zilnică cash-vs-card (vezi RECONCILIERE mai jos).
const RECONCILE_STORES = ['Magazin Bonus', 'Magazin Soiuz'];

// ================= REÎNCERCARE AUTOMATĂ PENTRU CERERILE CĂTRE MOYSKLAD =================
// MoySklad limitează rata de cereri (429 Too Many Requests) sub trafic mare — o sincronizare de
// catalog complet, sau mulți produse verificate rapid din Comenzi, pot trimite destule cereri
// simultane cît să lovească pragul. Fără reîncercare, O SINGURĂ cerere lovită de limită eșua
// direct — eroarea ajungea în aplicație arătînd ca "nu merge Cloudflare/proxy-ul", deși Worker-ul
// funcționase perfect, doar MoySklad refuzase temporar acea cerere. Reîncercăm de pînă la 2 ori,
// cu pauză scurtă crescătoare (respectînd Retry-After dacă MoySklad îl trimite), doar pe
// 429/5xx sau eșec de rețea — NICIODATĂ pe un 4xx real (400/404 etc.), care nu se rezolvă
// reîncercînd și ar întîrzia degeaba un răspuns care oricum va fi o eroare.
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
async function msFetch(url, options, retriesLeft) {
  if (retriesLeft === undefined) retriesLeft = 2;
  let res;
  try {
    res = await fetch(url, options);
  } catch (err) {
    if (retriesLeft > 0) { await sleep(300 * (3 - retriesLeft)); return msFetch(url, options, retriesLeft - 1); }
    throw err;
  }
  if (RETRYABLE_STATUS.has(res.status) && retriesLeft > 0) {
    const retryAfterHeader = res.headers.get('Retry-After');
    const retryAfterMs = retryAfterHeader ? parseInt(retryAfterHeader, 10) * 1000 : NaN;
    const waitMs = Number.isFinite(retryAfterMs) ? Math.min(retryAfterMs, 3000) : 300 * (3 - retriesLeft);
    await sleep(waitMs);
    return msFetch(url, options, retriesLeft - 1);
  }
  return res;
}

export default {
  async fetch(request, env) {
    const allowOrigin = env.ALLOWED_ORIGIN || '*';
    const corsHeaders = {
      'Access-Control-Allow-Origin': allowOrigin,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    const authHeader = env.MOYSKLAD_AUTH;
    if (!authHeader) {
      return json({ error: 'Secretul MOYSKLAD_AUTH nu e configurat pe acest Worker.' }, 500, corsHeaders);
    }
    const baseHeaders = { 'Authorization': authHeader, 'Accept-Encoding': 'gzip' };
    const url = new URL(request.url);

    try {
      if (request.method === 'POST') {
        const action = url.searchParams.get('action');
        const body = await request.json().catch(() => ({}));
        if (action === 'createFolder') return await handleCreateFolder(body, baseHeaders, corsHeaders);
        if (action === 'renameFolder') return await handleRenameFolder(body, baseHeaders, corsHeaders);
        if (action === 'deleteFolder') return await handleDeleteFolder(body, baseHeaders, corsHeaders);
        if (action === 'setArchived') return await handleSetArchived(body, baseHeaders, corsHeaders);
        if (action === 'deleteProducts') return await handleDeleteProducts(body, baseHeaders, corsHeaders);
        if (action === 'setAttrs') return await handleSetAttrs(body, baseHeaders, corsHeaders);
        if (action === 'createMoves') return await handleCreateMoves(body, baseHeaders, corsHeaders);
        return json({ error: 'Acțiune necunoscută.' }, 400, corsHeaders);
      }
      if (url.searchParams.has('transferdata')) return await handleTransferData(url, baseHeaders, corsHeaders);
      if (url.searchParams.has('movehistory')) return await handleMoveHistory(url, baseHeaders, corsHeaders);
      if (url.searchParams.has('catalog')) return await handleCatalog(baseHeaders, corsHeaders);
      if (url.searchParams.has('history')) return await handleHistory(url.searchParams.get('history'), baseHeaders, corsHeaders);
      if (url.searchParams.has('imgurl')) return await handleImageUrl(url.searchParams.get('imgurl'), baseHeaders, corsHeaders);
      if (url.searchParams.has('ordernum')) return await handleOrderImport(url.searchParams.get('ordernum'), baseHeaders, corsHeaders);
      if (url.searchParams.has('orderstatus')) return await handleOrderStatus(url.searchParams.get('orderstatus'), baseHeaders, corsHeaders);
      if (url.searchParams.has('attrs')) return await handleGetAttrs(url.searchParams.get('attrs'), baseHeaders, corsHeaders);
      if (url.searchParams.has('attrdefs')) return await handleAttrDefs(baseHeaders, corsHeaders);
      if (url.searchParams.has('pricetypes')) return await handlePriceTypes(baseHeaders, corsHeaders);
      if (url.searchParams.has('rawproduct')) return await handleRawProduct(url.searchParams.get('rawproduct'), baseHeaders, corsHeaders);
      if (url.searchParams.has('reconcile')) return await handleReconcile(baseHeaders, corsHeaders, env, url.searchParams.get('send') === '1');
      if (url.searchParams.has('fc_debug')) return await handleFiscalCloudDebug(corsHeaders, env);
      return await handleStock(baseHeaders, corsHeaders);
    } catch (err) {
      return json({ error: 'Eroare neașteptată în proxy', detail: String(err) }, 500, corsHeaders);
    }
  },

  // Rulează automat, la ora setată în Cloudflare → Workers → moysklad-proxy → Settings → Triggers → Cron Triggers.
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      const authHeader = env.MOYSKLAD_AUTH;
      if (!authHeader) return;
      const baseHeaders = { 'Authorization': authHeader, 'Accept-Encoding': 'gzip' };
      const report = await buildReconcileReport(baseHeaders, env);
      await sendTelegramMessage(formatReconcileMessage(report), env);
    })());
  }
};

// ================= STOC RAPID (folosit în tab-ul Comparație produse) =================
async function handleStock(baseHeaders, corsHeaders) {
  const idToBarcodes = await fetchAllBarcodes(baseHeaders);
  if (idToBarcodes.error) return json(idToBarcodes, 502, corsHeaders);

  const stockRes = await msFetch(`${API}/report/stock/all/current?stockType=stock`, { headers: baseHeaders });
  if (!stockRes.ok) return json({ error: 'Eroare la citirea stocului din MoySklad', status: stockRes.status, detail: await stockRes.text() }, 502, corsHeaders);
  const stockRows = await stockRes.json();

  const stock = {};
  for (const row of stockRows) {
    const codes = idToBarcodes.map[row.assortmentId];
    if (!codes) continue;
    for (const code of codes) stock[code] = row.stock;
  }
  return json({ stock, updatedAt: new Date().toISOString() }, 200, corsHeaders);
}

// ================= CATALOG COMPLET (tab-ul Produse) =================
async function fetchPage(url, sep, baseHeaders, limit, offset) {
  const res = await msFetch(`${url}${sep}limit=${limit}&offset=${offset}`, { headers: baseHeaders });
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  return res.json();
}

// Ia prima pagină ca să afle numărul total, apoi cere TOATE paginile rămase simultan
// (nu pe rând) — pe domeniul gratuit workers.dev, Cloudflare taie cererile care
// durează prea mult, iar pentru cataloage mari, paginarea secvențială depășea pragul.
async function fetchAllPages(url, baseHeaders, limit) {
  const sep = url.indexOf('?') === -1 ? '?' : '&';
  const first = await fetchPage(url, sep, baseHeaders, limit, 0);
  const rows = (first.rows || []).slice();
  const total = (first.meta && typeof first.meta.size === 'number') ? first.meta.size : rows.length;
  const pageCount = Math.min(Math.ceil(total / limit), 200);
  if (pageCount > 1) {
    const rest = [];
    for (let page = 1; page < pageCount; page++) rest.push(fetchPage(url, sep, baseHeaders, limit, page * limit));
    const restPages = await Promise.all(rest);
    for (const p of restPages) rows.push(...(p.rows || []));
  }
  return rows;
}

async function handleCatalog(baseHeaders, corsHeaders) {
  const limit = 1000;
  let productRows, stockRows, folderRows;
  try {
    // Cele trei sunt independente — le cerem în paralel, nu unul după altul, ca să nu riscăm timeout.
    [productRows, stockRows, folderRows] = await Promise.all([
      fetchAllPages(`${API}/entity/product?filter=archived=false`, baseHeaders, limit),
      fetchAllPages(`${API}/report/stock/all`, baseHeaders, limit),
      fetchAllPages(`${API}/entity/productfolder`, baseHeaders, limit)
    ]);
  } catch (err) {
    return json({ error: 'Eroare la citirea datelor din MoySklad', detail: String(err) }, 502, corsHeaders);
  }

  // 1. Toate brandurile (grupurile de produse) existente, indiferent dacă au produse sau nu.
  const folders = {};
  for (const f of folderRows) folders[f.id] = f.name;

  // 2. Produsele: barcode, denumire, preț de achiziție, brand (grup).
  const products = {};
  const currencyIds = new Set();
  for (const p of productRows) {
    const barcodes = (p.barcodes || []).map(b => Object.values(b)[0]).filter(Boolean);
    var buyPrice = null, buyPriceCurrencyId = null;
    if (p.buyPrice && typeof p.buyPrice.value === 'number') {
      buyPrice = p.buyPrice.value / 100;
      if (p.buyPrice.currency && p.buyPrice.currency.meta && p.buyPrice.currency.meta.href) {
        buyPriceCurrencyId = p.buyPrice.currency.meta.href.split('/').pop();
        currencyIds.add(buyPriceCurrencyId);
      }
    }
    var brandId = (p.productFolder && p.productFolder.meta && p.productFolder.meta.href) ? extractId(p.productFolder.meta.href) : null;
    products[p.id] = {
      id: p.id,
      name: p.name,
      article: p.article || '',
      code: p.code || '',
      barcodes: barcodes,
      buyPrice: buyPrice,
      buyPriceCurrencyId: buyPriceCurrencyId,
      brand: brandId && folders[brandId] ? folders[brandId] : '',
      brandId: brandId,
      stock: null,
      stockDays: null,
      imageUrl: null,
      hasImage: !!(p.images && p.images.meta && p.images.meta.size > 0)
    };
  }

  // 3. Stoc, zile în depozit și imaginea principală, din raportul extins.
  for (const r of stockRows) {
    const id = extractId(r.meta && r.meta.href);
    if (id && products[id]) {
      products[id].stock = r.stock;
      products[id].stockDays = r.stockDays;
      if (!products[id].imageUrl) {
        const img = r.image && (r.image.tiny || r.image.miniature);
        if (img && img.href) products[id].imageUrl = img.href;
      }
    }
  }

  // 4. Numele monedelor folosite la preț de achiziție (de obicei doar una).
  const currencyNames = {};
  await Promise.all(Array.from(currencyIds).map(async (id) => {
    try {
      const res = await msFetch(`${API}/entity/currency/${id}`, { headers: baseHeaders });
      if (res.ok) { const c = await res.json(); currencyNames[id] = c.isoCode || c.name || ''; }
    } catch (e) { /* ignorăm, rămâne fără nume de monedă */ }
  }));
  for (const id of Object.keys(products)) {
    var cid = products[id].buyPriceCurrencyId;
    if (cid && currencyNames[cid]) products[id].buyPriceCurrency = currencyNames[cid];
    delete products[id].buyPriceCurrencyId;
  }

  const folderList = Object.keys(folders).map(id => ({ id: id, name: folders[id] }));
  return json({ products: Object.values(products), folders: folderList, updatedAt: new Date().toISOString() }, 200, corsHeaders);
}

// ================= DATE PENTRU PEREMISENII — stoc pe fiecare depozit + vânzări recente pe depozit =================
// Folosit de hub-ul NOD (modulul Peremisenii), nu de panoul de achiziții.
async function handleTransferData(url, baseHeaders, corsHeaders) {
  const storeIds = (url.searchParams.get('storeIds') || '').split(',').map(s => s.trim()).filter(Boolean);
  const days = parseInt(url.searchParams.get('days'), 10) || 30;

  let stockRows;
  try {
    stockRows = await fetchAllPages(`${API}/report/stock/bystore`, baseHeaders, 1000);
  } catch (err) {
    return json({ error: 'Eroare la citirea stocului pe depozite din MoySklad', detail: String(err) }, 502, corsHeaders);
  }

  // Depozitele se extrag direct din rândurile de stoc — nu mai e nevoie de un apel separat la entity/store.
  const storesMap = {};
  for (const row of stockRows) {
    for (const s of (row.stockByStore || [])) {
      const sid = extractId(s.meta && s.meta.href);
      if (sid && !storesMap[sid]) storesMap[sid] = { id: sid, name: s.name };
    }
  }

  const momentTo = new Date();
  const momentFrom = new Date(momentTo.getTime() - days * 24 * 3600 * 1000);
  const fmtMoment = (d) => d.toISOString().slice(0, 10) + ' 00:00:00';

  const turnoverByStore = {};
  try {
    await Promise.all(storeIds.map(async (sid) => {
      const filterParts = [`store=${API}/entity/store/${sid}`, 'type=retaildemand'];
      const qs = filterParts.map(f => 'filter=' + encodeURIComponent(f)).join('&');
      const rows = await fetchAllPages(
        `${API}/report/turnover/all?${qs}&momentFrom=${encodeURIComponent(fmtMoment(momentFrom))}&momentTo=${encodeURIComponent(fmtMoment(momentTo))}`,
        baseHeaders, 1000
      );
      const map = {};
      for (const r of rows) {
        const pid = extractId(r.assortment && r.assortment.meta && r.assortment.meta.href);
        if (pid) map[pid] = (r.outcome && r.outcome.quantity) || 0;
      }
      turnoverByStore[sid] = map;
    }));
  } catch (err) {
    return json({ error: 'Eroare la citirea vânzărilor din MoySklad', detail: String(err) }, 502, corsHeaders);
  }

  const products = {};
  for (const row of stockRows) {
    const pid = extractId(row.meta && row.meta.href);
    if (!pid) continue;
    const stockByStore = {};
    for (const s of (row.stockByStore || [])) {
      const sid = extractId(s.meta && s.meta.href);
      if (sid) stockByStore[sid] = { stock: s.stock, reserve: s.reserve, inTransit: s.inTransit };
    }
    products[pid] = { id: pid, stockByStore, soldByStore: {} };
  }
  for (const sid of storeIds) {
    const map = turnoverByStore[sid] || {};
    for (const pid of Object.keys(map)) {
      if (!products[pid]) products[pid] = { id: pid, stockByStore: {}, soldByStore: {} };
      products[pid].soldByStore[sid] = map[pid];
    }
  }

  return json({ stores: Object.values(storesMap), products: Object.values(products), days, updatedAt: new Date().toISOString() }, 200, corsHeaders);
}

// ================= ISTORIC PEREMISENII (documente entity/move deja create, ca sursă de calibrare) =================
// Doar citire — folosit pentru a studia ce a mutat depozitarul manual până acum (produs, cantitate,
// sursă/destinație), ca fundal pentru ajustarea algoritmului de sugestii, nu pentru decizii automate.
async function handleMoveHistory(url, baseHeaders, corsHeaders) {
  const limit = Math.min(parseInt(url.searchParams.get('limit'), 10) || 100, 500);
  let rows;
  try {
    rows = await fetchAllPages(`${API}/entity/move?expand=positions,positions.assortment,sourceStore,targetStore&order=moment,desc`, baseHeaders, Math.min(limit, 100));
  } catch (err) {
    return json({ error: 'Eroare la citirea istoricului de peremisenii', detail: String(err) }, 502, corsHeaders);
  }
  rows = rows.slice(0, limit);
  const moves = rows.map(m => {
    const posRows = (m.positions && m.positions.rows) || [];
    return {
      id: m.id,
      name: m.name,
      moment: m.moment,
      sourceStoreId: extractId(m.sourceStore && m.sourceStore.meta && m.sourceStore.meta.href),
      sourceStoreName: (m.sourceStore && m.sourceStore.name) || null,
      targetStoreId: extractId(m.targetStore && m.targetStore.meta && m.targetStore.meta.href),
      targetStoreName: (m.targetStore && m.targetStore.name) || null,
      lines: posRows.map(pos => ({
        productId: extractId(pos.assortment && pos.assortment.meta && pos.assortment.meta.href),
        name: (pos.assortment && pos.assortment.name) || null,
        quantity: pos.quantity,
      })),
    };
  });
  return json({ moves, updatedAt: new Date().toISOString() }, 200, corsHeaders);
}

// ================= CREARE PEREMISENII (documente entity/move) =================
let cachedOrganizationHref = null;
async function resolveOrganizationHref(baseHeaders) {
  if (cachedOrganizationHref) return cachedOrganizationHref;
  const res = await msFetch(`${API}/entity/organization`, { headers: baseHeaders });
  if (!res.ok) return null;
  const data = await res.json();
  const row = (data.rows || [])[0];
  cachedOrganizationHref = row ? row.meta.href : null;
  return cachedOrganizationHref;
}
function metaRef(type, href) {
  return { meta: { href, metadataHref: `${API}/entity/${type}/metadata`, type, mediaType: 'application/json' } };
}
async function handleCreateMoves(body, baseHeaders, corsHeaders) {
  const moves = (body && body.moves) || [];
  if (!moves.length) return json({ error: 'Lipsește lista de peremisenii.' }, 400, corsHeaders);
  const orgHref = await resolveOrganizationHref(baseHeaders);
  if (!orgHref) return json({ error: 'Nu am găsit nicio organizație (juridică) în MoySklad.' }, 502, corsHeaders);

  const results = await Promise.all(moves.map(async (m) => {
    const positions = (m.lines || []).map(l => Object.assign(
      { assortment: metaRef('product', `${API}/entity/product/${l.productId}`) }, { quantity: l.quantity }
    ));
    const payload = Object.assign(
      { organization: metaRef('organization', orgHref) },
      { sourceStore: metaRef('store', `${API}/entity/store/${m.sourceStoreId}`) },
      { targetStore: metaRef('store', `${API}/entity/store/${m.targetStoreId}`) },
      { positions }
    );
    const res = await msFetch(`${API}/entity/move`, {
      method: 'POST', headers: { ...baseHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, sourceStoreId: m.sourceStoreId, targetStoreId: m.targetStoreId, error: (data.errors && data.errors[0] && data.errors[0].error) || 'Eroare necunoscută', detail: data };
    return { ok: true, sourceStoreId: m.sourceStoreId, targetStoreId: m.targetStoreId, id: data.id, name: data.name };
  }));
  const failed = results.filter(r => !r.ok);
  return json({ ok: failed.length === 0, created: results.filter(r => r.ok), failed }, 200, corsHeaders);
}

// ================= IMAGINE INDIVIDUALĂ (la cerere, pentru produsele fără imagine din raportul de stoc) =================
async function handleImageUrl(productId, baseHeaders, corsHeaders) {
  if (!productId) return json({ error: 'Lipsește id-ul produsului.' }, 400, corsHeaders);
  const res = await msFetch(`${API}/entity/product/${productId}/images`, { headers: baseHeaders });
  if (!res.ok) return json({ imageUrl: null }, 200, corsHeaders);
  const data = await res.json();
  const first = (data.rows || [])[0];
  const ref = first && (first.tiny || first.miniature);
  return json({ imageUrl: (ref && ref.href) || null }, 200, corsHeaders);
}

// ================= ISTORIC ACHIZIȚII (per produs, la cerere) =================
async function handleHistory(productId, baseHeaders, corsHeaders) {
  if (!productId) return json({ error: 'Lipsește id-ul produsului.' }, 400, corsHeaders);
  const productHref = `${API}/entity/product/${productId}`;
  const url = `${API}/entity/supply?filter=assortment=${encodeURIComponent(productHref)}&limit=20&order=moment,desc&expand=positions,agent`;
  const res = await msFetch(url, { headers: baseHeaders });
  if (!res.ok) return json({ error: 'Eroare la citirea istoricului de achiziții', status: res.status, detail: await res.text() }, 502, corsHeaders);
  const data = await res.json();
  const history = [];
  for (const doc of (data.rows || [])) {
    const posRows = (doc.positions && doc.positions.rows) || [];
    const match = posRows.find(p => extractId(p.assortment && p.assortment.meta && p.assortment.meta.href) === productId);
    if (!match) continue;
    history.push({
      date: doc.moment,
      supplier: (doc.agent && doc.agent.name) || 'Furnizor necunoscut',
      quantity: match.quantity,
      price: match.price / 100
    });
  }
  return json({ history }, 200, corsHeaders);
}

// ================= IMPORT COMANDĂ (Заказ поставщику, după număr) =================
async function handleOrderImport(orderNumber, baseHeaders, corsHeaders) {
  if (!orderNumber) return json({ error: 'Lipsește numărul comenzii.' }, 400, corsHeaders);
  // Numerotarea comenzilor din MoySklad se reia de la 0 în fiecare an, așa că filtrăm
  // și după anul curent — altfel căutarea după număr putea nimeri o comandă mai veche
  // cu același număr, din alt an.
  const year = new Date().getFullYear();
  const filterParts = [
    `name=${orderNumber}`,
    `moment>=${year}-01-01 00:00:00`,
    `moment<=${year}-12-31 23:59:59`
  ];
  const url = `${API}/entity/purchaseorder?` + filterParts.map(f => 'filter=' + encodeURIComponent(f)).join('&');
  const res = await msFetch(url, { headers: baseHeaders });
  if (!res.ok) return json({ error: 'Eroare la căutarea comenzii în MoySklad', status: res.status, detail: await res.text() }, 502, corsHeaders);
  const data = await res.json();
  const found = (data.rows || [])[0];
  if (!found) return json({ error: 'Nu am găsit nicio comandă cu numărul „' + orderNumber + '” în MoySklad (Заказы поставщикам).' }, 404, corsHeaders);
  // expand nu se populează fiabil pe endpoint-ul de listă filtrat (la fel ca la imagini) —
  // cerem documentul individual, cu id-ul găsit, ca să avem sigur pozițiile și furnizorul.
  // Cerem direct expand=positions.assortment (nu doar positions) ca să avem numele/barcode-ul
  // fiecărui articol fără cereri separate — asta rezolvă și cazul frecvent în care poziția e o
  // MODIFICARE (variant), nu un produs simplu: o cerere separată la /entity/product/{id} pentru
  // o variantă dă 404 și linia rămânea fără nume ("produs necunoscut").
  const fullRes = await msFetch(`${API}/entity/purchaseorder/${found.id}?expand=positions,positions.assortment,agent`, { headers: baseHeaders });
  if (!fullRes.ok) return json({ error: 'Eroare la citirea detaliilor comenzii', status: fullRes.status, detail: await fullRes.text() }, 502, corsHeaders);
  const order = await fullRes.json();
  const posRows = (order.positions && order.positions.rows) || [];
  const lines = posRows.map((pos) => {
    const assortment = pos.assortment || {};
    const codes = (assortment.barcodes || []).map(b => Object.values(b)[0]).filter(Boolean);
    return {
      productId: extractId(assortment.meta && assortment.meta.href),
      name: assortment.name || '',
      barcode: codes[0] || '',
      code: assortment.code || assortment.article || '',
      quantity: pos.quantity,
      price: pos.price / 100
    };
  });
  return json({
    orderNumber: order.name,
    supplier: (order.agent && order.agent.name) || '',
    moyskladOrderId: order.id,
    sum: order.sum || 0,
    shippedSum: order.shippedSum || 0,
    lines: lines
  }, 200, corsHeaders);
}

// ================= STATUS COMANDĂ (verifică dacă a fost deja recepționată) =================
// MoySklad calculează automat shippedSum pe un Заказ поставщику pe măsură ce se creează
// Приемки (recepții de marfă) pe baza lui — dacă shippedSum a ajuns la sum, comanda a fost
// deja recepționată integral în depozit.
async function handleOrderStatus(orderId, baseHeaders, corsHeaders) {
  if (!orderId) return json({ error: 'Lipsește id-ul comenzii.' }, 400, corsHeaders);
  const res = await msFetch(`${API}/entity/purchaseorder/${orderId}`, { headers: baseHeaders });
  if (!res.ok) return json({ error: 'Eroare la verificarea comenzii', status: res.status, detail: await res.text() }, 502, corsHeaders);
  const order = await res.json();
  const sum = order.sum || 0;
  const shippedSum = order.shippedSum || 0;
  return json({ sum, shippedSum, received: sum > 0 && shippedSum >= sum }, 200, corsHeaders);
}

// ================= CÎMPURILE DE PREȚ SETATE PE PRODUS ÎN MOYSKLAD =================
// Nu sînt atribute personalizate (attributemetadata), cum s-a presupus inițial — sînt TIPURI DE
// PREȚ (salePrices), fiecare cu propriul id intern + un externalCode. Aplicația (index.html,
// MS_PRICE_ATTRS) identifică fiecare cîmp după externalCode (UUID stabil, ales de utilizator la
// crearea tipului de preț în MoySklad), nu după id-ul intern al tipului. Excepție: "Закупочная
// цена" (sinecost final MDL) e cîmpul NATIV buyPrice, nu un tip de preț.
// Fiecare produs întoarce în salePrices TOATE tipurile de preț definite în cont (chiar cu value 0
// dacă nu au fost completate încă) — deci găsim/înlocuim direct intrarea potrivită după
// externalCode, fără să construim vreun meta.href manual (spre deosebire de atribute personalizate).
const BUY_PRICE_MDL_EXTCODE = 'bd72d8fc-55bc-11d9-848a-00112f43529a';

async function handleGetAttrs(productId, baseHeaders, corsHeaders) {
  if (!productId) return json({ error: 'Lipsește id-ul produsului.' }, 400, corsHeaders);
  const res = await msFetch(`${API}/entity/product/${productId}`, { headers: baseHeaders });
  if (!res.ok) return json({ error: 'Eroare la citirea produsului din MoySklad', status: res.status, detail: await res.text() }, 502, corsHeaders);
  const data = await res.json();
  const attributes = {};
  for (const sp of (data.salePrices || [])) {
    const ec = sp.priceType && sp.priceType.externalCode;
    if (ec) attributes[ec] = sp.value / 100;
  }
  if (data.buyPrice && typeof data.buyPrice.value === 'number') attributes[BUY_PRICE_MDL_EXTCODE] = data.buyPrice.value / 100;
  return json({ attributes }, 200, corsHeaders);
}
// ================= LISTA REALĂ DE ATRIBUTE PERSONALIZATE DEFINITE ÎN MOYSKLAD (diagnostic) =================
async function handleAttrDefs(baseHeaders, corsHeaders) {
  const res = await msFetch(`${API}/entity/product/metadata/attributes`, { headers: baseHeaders });
  if (!res.ok) return json({ error: 'Eroare la citirea definițiilor de atribute', status: res.status, detail: await res.text() }, 502, corsHeaders);
  const data = await res.json();
  const attributes = (data.rows || []).map(a => ({ id: a.id, name: a.name, type: a.type }));
  return json({ attributes }, 200, corsHeaders);
}
// ================= TIPURI DE PREȚ DEFINITE ÎN CONT (diagnostic) =================
async function handlePriceTypes(baseHeaders, corsHeaders) {
  const res = await msFetch(`${API}/context/companysettings/pricetype`, { headers: baseHeaders });
  if (!res.ok) return json({ error: 'Eroare la citirea tipurilor de preț', status: res.status, detail: await res.text() }, 502, corsHeaders);
  const data = await res.json();
  return json({ priceTypes: data }, 200, corsHeaders);
}
// ================= PRODUS BRUT, NEFILTRAT (diagnostic) =================
async function handleRawProduct(productId, baseHeaders, corsHeaders) {
  if (!productId) return json({ error: 'Lipsește id-ul produsului.' }, 400, corsHeaders);
  const res = await msFetch(`${API}/entity/product/${productId}`, { headers: baseHeaders });
  if (!res.ok) return json({ error: 'Eroare la citirea produsului', status: res.status, detail: await res.text() }, 502, corsHeaders);
  const data = await res.json();
  return json(data, 200, corsHeaders);
}
// Scriem doar valorile cerute, dar PĂSTRÂND restul salePrices neatinse — MoySklad înlocuiește tot
// array-ul la un PUT, deci citim întîi valorile curente și înlocuim doar .value la intrarea cu
// externalCode-ul potrivit, păstrînd fiecare obiect priceType exact cum a venit de la MoySklad.
async function handleSetAttrs(body, baseHeaders, corsHeaders) {
  const productId = body && body.id;
  const updates = (body && body.attributes) || []; // [{ id: externalCode, value: număr real (MDL sau $, nu bani) }]
  if (!productId || !updates.length) return json({ error: 'Lipsește produsul sau lista de atribute.' }, 400, corsHeaders);
  const getRes = await msFetch(`${API}/entity/product/${productId}`, { headers: baseHeaders });
  if (!getRes.ok) return json({ error: 'Eroare la citirea produsului din MoySklad', status: getRes.status, detail: await getRes.text() }, 502, corsHeaders);
  const current = await getRes.json();
  const salePrices = (current.salePrices || []).map(sp => Object.assign({}, sp));
  const patch = {};
  const notFound = [];
  for (const u of updates) {
    if (u.id === BUY_PRICE_MDL_EXTCODE) {
      patch.buyPrice = Object.assign({}, current.buyPrice, { value: Math.round(u.value * 100) });
      continue;
    }
    const idx = salePrices.findIndex(sp => sp.priceType && sp.priceType.externalCode === u.id);
    if (idx === -1) { notFound.push(u.id); continue; }
    salePrices[idx] = Object.assign({}, salePrices[idx], { value: Math.round(u.value * 100) });
  }
  if (notFound.length) return json({ error: 'Tip de preț necunoscut pe acest produs (externalCode): ' + notFound.join(', ') }, 400, corsHeaders);
  patch.salePrices = salePrices;
  const putRes = await msFetch(`${API}/entity/product/${productId}`, {
    method: 'PUT', headers: { ...baseHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify(patch)
  });
  const data = await putRes.json().catch(() => ({}));
  if (!putRes.ok) return json({ error: (data.errors && data.errors[0] && data.errors[0].error) || 'Eroare la salvarea prețurilor în MoySklad.', detail: data }, putRes.status, corsHeaders);
  return json({ ok: true }, 200, corsHeaders);
}

// ================= SCRIERE: BRANDURI (grupuri de produse) =================
async function handleCreateFolder(body, baseHeaders, corsHeaders) {
  const name = (body && body.name || '').trim();
  if (!name) return json({ error: 'Numele brandului e obligatoriu.' }, 400, corsHeaders);
  const res = await msFetch(`${API}/entity/productfolder`, {
    method: 'POST', headers: { ...baseHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ name })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return json({ error: (data.errors && data.errors[0] && data.errors[0].error) || 'Eroare la crearea brandului.', detail: data }, res.status, corsHeaders);
  return json({ id: data.id, name: data.name }, 200, corsHeaders);
}
async function handleRenameFolder(body, baseHeaders, corsHeaders) {
  const id = body && body.id, name = (body && body.name || '').trim();
  if (!id || !name) return json({ error: 'Lipsește id-ul sau numele nou.' }, 400, corsHeaders);
  const res = await msFetch(`${API}/entity/productfolder/${id}`, {
    method: 'PUT', headers: { ...baseHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ name })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return json({ error: (data.errors && data.errors[0] && data.errors[0].error) || 'Eroare la redenumirea brandului.', detail: data }, res.status, corsHeaders);
  return json({ id: data.id, name: data.name }, 200, corsHeaders);
}
async function handleDeleteFolder(body, baseHeaders, corsHeaders) {
  const id = body && body.id;
  if (!id) return json({ error: 'Lipsește id-ul brandului.' }, 400, corsHeaders);
  const res = await msFetch(`${API}/entity/productfolder/${id}`, { method: 'DELETE', headers: baseHeaders });
  if (res.status === 204 || res.ok) return json({ ok: true }, 200, corsHeaders);
  const detail = await res.text();
  return json({ error: 'Nu am putut șterge brandul — probabil mai conține produse.', detail }, res.status, corsHeaders);
}

// ================= SCRIERE: PRODUSE (arhivare / ștergere, în masă) =================
async function handleSetArchived(body, baseHeaders, corsHeaders) {
  const ids = (body && body.ids) || [];
  const archived = !!(body && body.archived);
  if (!ids.length) return json({ error: 'Lipsește lista de produse.' }, 400, corsHeaders);
  const results = await Promise.all(ids.map(async (id) => {
    const res = await msFetch(`${API}/entity/product/${id}`, {
      method: 'PUT', headers: { ...baseHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ archived })
    });
    return { id, ok: res.ok, detail: res.ok ? null : await res.text() };
  }));
  const failed = results.filter(r => !r.ok);
  return json({ ok: failed.length === 0, updated: results.length - failed.length, failed }, 200, corsHeaders);
}
async function handleDeleteProducts(body, baseHeaders, corsHeaders) {
  const ids = (body && body.ids) || [];
  if (!ids.length) return json({ error: 'Lipsește lista de produse.' }, 400, corsHeaders);
  const results = await Promise.all(ids.map(async (id) => {
    const res = await msFetch(`${API}/entity/product/${id}`, { method: 'DELETE', headers: baseHeaders });
    return { id, ok: res.status === 204 || res.ok, detail: (res.status === 204 || res.ok) ? null : await res.text() };
  }));
  const failed = results.filter(r => !r.ok);
  return json({ ok: failed.length === 0, deleted: results.length - failed.length, failed }, 200, corsHeaders);
}

// ================= RECONCILIERE ZILNICĂ CARD (bancă/POS vs MoySklad) =================
// Compară, pentru ziua precedentă, suma de card încasată real în magazin (bancă/IntelectSoft)
// cu suma de card închisă în tura de casă din MoySklad (câmpul proceedsNoCash de pe retailshift).
async function handleReconcile(baseHeaders, corsHeaders, env, send) {
  const report = await buildReconcileReport(baseHeaders, env);
  if (send) {
    const telegram = await sendTelegramMessage(formatReconcileMessage(report), env);
    return json({ report, telegram }, 200, corsHeaders);
  }
  return json(report, 200, corsHeaders);
}

async function buildReconcileReport(baseHeaders, env) {
  const { yesterdayStr, todayStr } = chisinauYesterdayRange();
  const stores = await Promise.all(RECONCILE_STORES.map(async (name) => {
    const storeId = await resolveRetailStoreId(name, baseHeaders);
    if (!storeId) return { name, error: 'Punctul de vânzare nu a fost găsit în MoySklad (verifică numele).' };
    const cardMoySklad = await sumCardRevenue(storeId, yesterdayStr, todayStr, baseHeaders);
    if (cardMoySklad == null) return { name, error: 'Eroare la citirea turelor de casă din MoySklad.' };
    const cardBank = await getBankCardTotal(name, yesterdayStr, env);
    return { name, cardMoySklad, cardBank: cardBank.value, cardBankError: cardBank.error };
  }));
  return { date: yesterdayStr, stores };
}

// Data de "ieri" în fusul orar Chișinău (indiferent de ora UTC la care rulează Worker-ul).
function chisinauYesterdayRange() {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Chisinau', year: 'numeric', month: '2-digit', day: '2-digit' });
  const todayStr = fmt.format(new Date());
  const [y, m, d] = todayStr.split('-').map(Number);
  // folosim ora 12:00 UTC ca reper, ca să evităm ambiguități la schimbarea orei de vară/iarnă
  const yesterdayStr = fmt.format(new Date(Date.UTC(y, m - 1, d, 12) - 24 * 3600 * 1000));
  return { yesterdayStr, todayStr };
}

async function resolveRetailStoreId(name, baseHeaders) {
  const res = await msFetch(`${API}/entity/retailstore?filter=${encodeURIComponent('name=' + name)}`, { headers: baseHeaders });
  if (!res.ok) return null;
  const data = await res.json();
  const row = (data.rows || [])[0];
  return row ? row.id : null;
}

async function sumCardRevenue(storeId, startDateStr, endDateStr, baseHeaders) {
  const storeHref = `${API}/entity/retailstore/${storeId}`;
  const filters = [
    `retailStore=${storeHref}`,
    `closeDate>=${startDateStr} 00:00:00`,
    `closeDate<${endDateStr} 00:00:00`
  ];
  const url = `${API}/entity/retailshift?` + filters.map(f => 'filter=' + encodeURIComponent(f)).join('&') + '&limit=100';
  const res = await msFetch(url, { headers: baseHeaders });
  if (!res.ok) return null;
  const data = await res.json();
  return (data.rows || []).reduce((sum, r) => sum + (Number(r.proceedsNoCash) || 0), 0);
}

// ================= FISCALCLOUD / IntelectSoft — suma reală de card, per magazin =================
// API oficial FiscalCloud (https://cloud.fiscalcloud.md/api-docs), autentificat cu Api-Key +
// semnătură HMAC-SHA256 (Api-Secret nu se trimite niciodată în rețea). Vezi și ?fc_debug=1
// pentru a verifica manual numele punctelor de lucru (subdivisions) și dispozitivele fiscale.
const FISCALCLOUD_BASE = 'https://cloud.fiscalcloud.md';

async function fiscalCloudRequest(method, pathAndQuery, env) {
  const apiKey = env.FISCALCLOUD_API_KEY;
  const apiSecret = env.FISCALCLOUD_API_SECRET;
  if (!apiKey || !apiSecret) return { error: 'Lipsesc secretele FISCALCLOUD_API_KEY / FISCALCLOUD_API_SECRET.' };
  const timestamp = String(Date.now());
  // conform docs: apiKey + timestamp + METODA + path-ul complet (cu query) + hash-ul corpului (gol la GET)
  const dataToSign = `${apiKey}${timestamp}${method}${pathAndQuery}`;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(apiSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sigBuffer = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(dataToSign));
  const signature = toHex(sigBuffer).toLowerCase();
  const res = await fetch(FISCALCLOUD_BASE + pathAndQuery, {
    method,
    headers: { 'Api-Key': apiKey, 'Api-Timestamp': timestamp, 'Api-Signature': signature }
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.success === false) return { error: (data && data.message) || `Eroare FiscalCloud (${res.status})` };
  return { rows: (data.data && data.data.data) || [] };
}

function toHex(buf) {
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function fcResolveSubdivisionId(name, env) {
  const result = await fiscalCloudRequest('GET', `/api/v1/subdivisions?filter=${encodeURIComponent('name=' + name)}`, env);
  if (result.error) return { error: result.error };
  const row = result.rows[0];
  return row ? { id: row.id } : { error: `Niciun punct de lucru „${name}” în FiscalCloud.` };
}

async function fcGetFiscalDeviceIds(subdivisionId, env) {
  const result = await fiscalCloudRequest('GET', `/api/v1/fiscaldevices?filter=${encodeURIComponent('subdivisionId=' + subdivisionId)}&count=100`, env);
  if (result.error) return { error: result.error };
  return { ids: result.rows.map(r => r.id) };
}

// O zi întreagă (00:00:00–23:59:59), în ora locală înregistrată de dispozitivul fiscal.
async function fcGetCardTotal(deviceIds, dateStr, env) {
  if (!deviceIds.length) return { value: 0 };
  const deviceFilter = '(' + deviceIds.map(id => `FiscalDeviceId=${id}`).join('|') + ')';
  const filter = [deviceFilter, 'type=ZReport', `dateTime>=${dateStr} 00:00:00`, `dateTime<=${dateStr} 23:59:59`].join(',');
  const result = await fiscalCloudRequest('GET', `/api/v1/reports/full?filter=${encodeURIComponent(filter)}&count=200`, env);
  if (result.error) return { error: result.error };
  let cardTotal = 0;
  for (const report of result.rows) {
    for (const p of (report.payments || [])) {
      // "Card" = orice metodă de plată care NU e numerar, la fel cum MoySklad desparte doar
      // cash vs non-cash (proceedsCash / proceedsNoCash) — simetric cu partea de MoySklad.
      if (!/numerar|cash/i.test(p.typeName || '')) cardTotal += Number(p.amount) || 0;
    }
  }
  return { value: cardTotal };
}

async function getBankCardTotal(storeName, dateStr, env) {
  const sub = await fcResolveSubdivisionId(storeName, env);
  if (sub.error) return { value: null, error: sub.error };
  const devices = await fcGetFiscalDeviceIds(sub.id, env);
  if (devices.error) return { value: null, error: devices.error };
  const total = await fcGetCardTotal(devices.ids, dateStr, env);
  if (total.error) return { value: null, error: total.error };
  return { value: total.value };
}

// Diagnostic manual — deschide-l în browser (?fc_debug=1) ca să confirmi că numele din
// RECONCILE_STORES corespund exact cu "name" din subdivisions, și ca să vezi ce dispozitive
// fiscale (fiscaldevices) sunt legate de fiecare punct de lucru.
async function handleFiscalCloudDebug(corsHeaders, env) {
  const subdivisions = await fiscalCloudRequest('GET', '/api/v1/subdivisions?count=100', env);
  const devices = await fiscalCloudRequest('GET', '/api/v1/fiscaldevices?count=100', env);
  return json({ subdivisions, devices }, 200, corsHeaders);
}

function formatReconcileMessage(report) {
  const lines = [`📊 Verificare card — ${report.date}`, ''];
  for (const s of report.stores) {
    lines.push(`🏪 ${s.name}`);
    if (s.error) { lines.push(`⚠️ ${s.error}`, ''); continue; }
    lines.push(`💳 MoySklad (casă): ${s.cardMoySklad.toFixed(2)} lei`);
    if (s.cardBank == null) {
      lines.push(`🏦 Card FiscalCloud: indisponibil${s.cardBankError ? ' — ' + s.cardBankError : ''}`);
    } else {
      const diff = s.cardBank - s.cardMoySklad;
      lines.push(`🏦 Card FiscalCloud: ${s.cardBank.toFixed(2)} lei`);
      lines.push(Math.abs(diff) < 0.01 ? '✅ Sumele coincid' : `❌ Diferență: ${diff.toFixed(2)} lei`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

async function sendTelegramMessage(text, env) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    return { ok: false, error: 'Lipsesc secretele TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID pe Worker.' };
  }
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text })
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok && !!data.ok, detail: data };
}

// ================= HELPER =================
function extractId(href) {
  if (!href) return null;
  return href.split('/').pop().split('?')[0];
}
async function fetchAllBarcodes(baseHeaders) {
  const map = {};
  let offset = 0;
  const limit = 1000;
  while (true) {
    const res = await msFetch(`${API}/entity/product?limit=${limit}&offset=${offset}&filter=archived=false`, { headers: baseHeaders });
    if (!res.ok) return { error: 'Eroare la citirea produselor din MoySklad', status: res.status, detail: await res.text() };
    const data = await res.json();
    const rows = data.rows || [];
    for (const p of rows) {
      if (p.barcodes && p.barcodes.length) {
        const codes = p.barcodes.map(b => Object.values(b)[0]).filter(Boolean);
        if (codes.length) map[p.id] = codes;
      }
    }
    if (rows.length < limit) break;
    offset += limit;
    if (offset > 200000) break;
  }
  return { map };
}

function json(obj, status, corsHeaders) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  });
}
