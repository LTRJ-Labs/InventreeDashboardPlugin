import { palette, esc, fetchAll } from './_chart.js';

/**
 * Full-width cost breakdown panel for a Part detail page.
 *
 * Registered through `get_ui_panels`, so unlike the dashboard widgets this one
 * knows which part it is looking at: `ctx.instance` is the already-fetched Part
 * and `ctx.id` its primary key, so there is no lookup to open the panel.
 *
 * Tier selection never extrapolates: the best break at or below the required
 * quantity wins, and below the smallest break the smallest price is used
 * unchanged. This matches Inventree_SupplierSync's `tier_price()`, so the panel
 * and the sync cannot disagree.
 */

const PRESETS = [1, 5, 10, 25, 50, 100, 250, 1000];
const QTY_STORE = 'ltrj-panel-qty';
const OPEN_STORE = 'ltrj-panel-open';
const CONFIG_STORE = 'ltrj-panel-config';
const MAX_DEPTH = 8;
const REFRESH_MS = 5 * 60 * 1000;

/* ------------------------------------------------------------------ state */

function loadSet(key) {
  try { return new Set(JSON.parse(localStorage.getItem(key) || '[]')); }
  catch (e) { return new Set(); }
}
function saveSet(key, set) {
  try { localStorage.setItem(key, JSON.stringify([...set])); } catch (e) { /* ignore */ }
}
function loadQty() {
  try {
    const n = Number(localStorage.getItem(QTY_STORE));
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1;
  } catch (e) { return 1; }
}

/* ---------------------------------------------------------- configuration */

/**
 * Product options come from the CONFIG_GROUPS plugin setting, so the variants
 * can change without shipping JS. A part named by any group is "optional": it
 * counts only while its own option is selected. A part in no group always
 * counts, which is what keeps the common core of the BOM unconditional.
 */
function loadChoice(groups) {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(CONFIG_STORE) || '{}'); } catch (e) { /* ignore */ }
  const choice = {};
  for (const g of groups) {
    const keys = (g.options || []).map((o) => o.key);
    choice[g.key] = keys.includes(saved[g.key]) ? saved[g.key]
      : (keys.includes(g.default) ? g.default : keys[0]);
  }
  return choice;
}

function saveChoice(choice) {
  try { localStorage.setItem(CONFIG_STORE, JSON.stringify(choice)); } catch (e) { /* ignore */ }
}

/** Every part any group can switch on, and the subset currently switched on. */
function resolveOptional(groups, choice) {
  const universe = new Set();
  const included = new Set();
  for (const g of groups) {
    for (const o of g.options || []) {
      for (const pk of o.parts || []) {
        universe.add(pk);
        if (choice[g.key] === o.key) included.add(pk);
      }
    }
  }
  // A part offered by two groups stays in as long as one selection includes it.
  const excluded = new Set([...universe].filter((pk) => !included.has(pk)));
  return { universe, included, excluded };
}

/* ------------------------------------------------------------- formatting */

function makeMoney(currency) {
  const fmt = (digits) => {
    try {
      return new Intl.NumberFormat(undefined, {
        style: 'currency', currency,
        minimumFractionDigits: digits, maximumFractionDigits: digits,
      });
    } catch (e) { return null; }
  };
  const two = fmt(2);
  const four = fmt(4);
  return (v) => {
    const n = Number(v ?? 0);
    // Sub-dollar unit prices are meaningless at 2dp -- most passives land there.
    const f = (n !== 0 && Math.abs(n) < 1 ? four : two);
    return f ? f.format(n) : `${n.toFixed(2)} ${currency}`;
  };
}

const num = (v) => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n.toLocaleString(undefined, { maximumFractionDigits: 3 }) : '0';
};

/* ----------------------------------------------------------------- pricing */

/**
 * Best price break at or below `need`. Returns the currency alongside the
 * price: taking it from the first row instead is wrong whenever a supplier
 * part carries breaks in more than one currency.
 */
function tierPrice(breaks, need) {
  if (!breaks || !breaks.length) return null;
  const ladder = breaks
    .map((b) => ({ q: Number(b.quantity), p: Number(b.price), c: b.price_currency }))
    .filter((b) => Number.isFinite(b.q) && Number.isFinite(b.p))
    .sort((a, b) => a.q - b.q);
  if (!ladder.length) return null;
  const ok = ladder.filter((b) => b.q <= need);
  const hit = ok.length ? ok[ok.length - 1] : ladder[0];
  return { price: hit.p, currency: hit.c };
}

/* -------------------------------------------------------------------- data */

/**
 * Pull the catalogue, supplier parts, price breaks and FX rates.
 *
 * Routed through the plugin context's TanStack QueryClient so repeated panel
 * opens reuse one cached result, and a refresh invalidates in one place.
 */
async function loadPricingData(api, queryClient) {
  const run = async () => {
    const [supplierParts, breaks, allParts] = await Promise.all([
      fetchAll(api, '/api/company/part/', { active: true }),
      fetchAll(api, '/api/company/price-break/', {}),
      // /api/bom/ returns no category for its lines even with sub_part_detail
      // expanded, so the catalogue is fetched once and resolves name, category
      // and stock for every row in the tree.
      fetchAll(api, '/api/part/', {}),
    ]);
    let rates = {}, currency = 'USD';
    try {
      const fx = (await api.get('/api/currency/exchange/'))?.data;
      rates = fx?.exchange_rates ?? {};
      currency = fx?.base_currency ?? 'USD';
    } catch (e) { /* unconverted prices are better than no panel */ }
    return { supplierParts, breaks, allParts, rates, currency, at: Date.now() };
  };

  if (queryClient?.fetchQuery) {
    return queryClient.fetchQuery({
      queryKey: ['ltrj-cost-panel', 'pricing'],
      queryFn: run,
      staleTime: REFRESH_MS,
    });
  }
  return run();
}

function buildIndex(data) {
  const { supplierParts, breaks, allParts, rates, currency } = data;

  const partInfo = new Map();
  for (const p of allParts) {
    partInfo.set(p.pk, {
      name: p.name || `Part ${p.pk}`,
      ipn: p.IPN || '',
      category: p.category_detail?.name || p.category_name || 'Uncategorised',
      assembly: !!p.assembly,
      purchaseable: !!p.purchaseable,
      stock: Number(p.in_stock ?? p.total_in_stock ?? 0),
      minimum: Number(p.minimum_stock ?? 0),
      onOrder: Number(p.ordering ?? 0),
      units: p.units || '',
    });
  }

  const spByPart = new Map();
  for (const sp of supplierParts) {
    if (!spByPart.has(sp.part)) spByPart.set(sp.part, []);
    spByPart.get(sp.part).push(sp);
  }
  const bkBySp = new Map();
  for (const b of breaks) {
    if (!bkBySp.has(b.part)) bkBySp.set(b.part, []);
    bkBySp.get(b.part).push(b);
  }

  const toBase = (v, cur) => Number(v) / Number(rates[cur || currency] ?? 1);

  /** Cheapest supplier unit price for `need` units, in base currency. */
  function unitCost(partId, need) {
    let best = null;
    for (const sp of spByPart.get(partId) ?? []) {
      const hit = tierPrice(bkBySp.get(sp.pk) ?? [], need);
      if (!hit) continue;
      const pack = Number(sp.pack_quantity_native ?? 1) || 1;
      const u = toBase(hit.price, hit.currency) / pack;
      if (best == null || u < best) best = u;
    }
    return best;
  }

  const infoOf = (id) => partInfo.get(id)
    || { name: `Part ${id}`, category: 'Uncategorised', stock: 0, minimum: 0, onOrder: 0 };

  return { infoOf, unitCost, currency };
}

/* ---------------------------------------------------------------- costing */

/**
 * Cost `partId` for `need` units.
 *
 * Unlike the dashboard widget, a part that has its own supplier price still has
 * its BOM walked when it has one: the buy price is what the rollup uses, but
 * the make cost is computed alongside it so a purchased sub-assembly is still
 * explorable and the two numbers can be compared.
 *
 * `priced` propagates upward -- an assembly counts as priced only when every
 * descendant is. Returning `true` unconditionally is how a sub-assembly of
 * entirely unpriced parts reports a confident cost of zero.
 */
async function buildTree(partId, need, depth, deps) {
  const { infoOf, unitCost, bomOf, excluded } = deps;
  const buyUnit = unitCost(partId, need);
  const info = infoOf(partId);

  let children = null;
  let makeCost = null;
  let childrenPriced = true;

  if (depth < MAX_DEPTH) {
    const lines = await bomOf(partId);
    if (lines.length) {
      children = [];
      let total = 0;
      for (const line of lines) {
        // Options the current configuration does not select contribute nothing,
        // at any depth -- the radios sit on the mainboard's BOM, not the top.
        if (excluded?.has(line.sub_part)) continue;
        const per = Number(line.quantity ?? 0);
        const kid = await buildTree(line.sub_part, per * need, depth + 1, deps);
        kid.per = per;
        kid.reference = line.reference || '';
        total += kid.cost;
        if (!kid.priced) childrenPriced = false;
        children.push(kid);
      }
      children.sort((a, b) => b.cost - a.cost);
      makeCost = total;
    }
  }

  const buyCost = buyUnit != null ? buyUnit * need : null;
  // Prefer the bought price when one exists; fall back to the rollup.
  const cost = buyCost != null ? buyCost : (makeCost ?? 0);
  const priced = buyCost != null ? true : (children ? childrenPriced : false);

  return {
    id: partId,
    name: info.name,
    ipn: info.ipn,
    category: info.category,
    stock: info.stock,
    minimum: info.minimum,
    onOrder: info.onOrder,
    need, cost, priced, children,
    unit: need > 0 ? cost / need : 0,
    buyCost, makeCost,
  };
}

/** Flatten to visible rows, honouring the expanded set. */
function flatten(nodes, open, depth, parentKey, out) {
  nodes.forEach((n, i) => {
    const key = `${parentKey}/${n.id}-${i}`;
    const hasKids = Array.isArray(n.children) && n.children.length;
    out.push({ node: n, key, depth, hasKids, open: open.has(key) });
    if (hasKids && open.has(key)) flatten(n.children, open, depth + 1, key, out);
  });
  return out;
}

function countUnpriced(nodes, acc = []) {
  for (const n of nodes ?? []) {
    if (!n.priced && !(n.children && n.children.length)) acc.push(n);
    if (n.children) countUnpriced(n.children, acc);
  }
  return acc;
}

/* ----------------------------------------------------------------- styling */

function styles(colours) {
  return `
    .ltrj-wrap { color: var(--mantine-color-text); font-size: .875rem; }
    .ltrj-head {
      display: flex; flex-wrap: wrap; gap: 1.25rem; align-items: flex-end;
      justify-content: space-between; padding: 0 0 1rem;
      border-bottom: 1px solid var(--mantine-color-default-border);
    }
    .ltrj-qty-row { display: flex; align-items: center; gap: .5rem; flex-wrap: wrap; }
    .ltrj-label {
      font-size: .7rem; text-transform: uppercase; letter-spacing: .06em;
      color: var(--mantine-color-dimmed); font-weight: 600;
    }
    .ltrj-input {
      width: 7rem; padding: .35rem .55rem; font: inherit; font-size: 1rem; font-weight: 600;
      font-variant-numeric: tabular-nums; color: var(--mantine-color-text);
      background: var(--mantine-color-body); border-radius: 6px;
      border: 1px solid var(--mantine-color-default-border);
    }
    .ltrj-input:focus { outline: 2px solid ${colours.series[0]}; outline-offset: -1px; border-color: transparent; }
    .ltrj-preset {
      padding: .25rem .5rem; font: inherit; font-size: .75rem; cursor: pointer;
      border-radius: 5px; border: 1px solid var(--mantine-color-default-border);
      background: transparent; color: var(--mantine-color-dimmed); transition: all .12s;
    }
    .ltrj-preset:hover { color: var(--mantine-color-text); border-color: ${colours.series[0]}; }
    .ltrj-preset[data-active="1"] {
      background: ${colours.series[0]}; border-color: ${colours.series[0]};
      color: #fff; font-weight: 600;
    }
    .ltrj-select {
      padding: .3rem .5rem; font: inherit; font-size: .82rem; cursor: pointer;
      color: var(--mantine-color-text); background: var(--mantine-color-body);
      border: 1px solid var(--mantine-color-default-border); border-radius: 6px;
      min-width: 9.5rem;
    }
    .ltrj-select:focus { outline: 2px solid ${colours.series[0]}; outline-offset: -1px; }
    .ltrj-config { display: flex; gap: 1rem; flex-wrap: wrap; }
    .ltrj-figures { display: flex; gap: 1.75rem; align-items: flex-end; }
    .ltrj-fig { text-align: right; }
    .ltrj-fig-v {
      font-size: 1.9rem; font-weight: 700; line-height: 1.05;
      font-variant-numeric: tabular-nums; letter-spacing: -.02em;
    }
    .ltrj-fig-s { font-size: 1.15rem; font-weight: 600; color: var(--mantine-color-dimmed); }

    .ltrj-bar { display: flex; height: .55rem; border-radius: 4px; overflow: hidden; margin: 1rem 0 .5rem;
                background: var(--mantine-color-default-border); }
    .ltrj-bar > div { transition: width .25s ease; }
    .ltrj-legend { display: flex; flex-wrap: wrap; gap: .25rem 1.1rem; margin-bottom: 1rem;
                   font-size: .75rem; color: var(--mantine-color-dimmed); }
    .ltrj-legend span.sw { display: inline-block; width: .6rem; height: .6rem; border-radius: 2px; margin-right: .4rem; }

    .ltrj-note {
      display: flex; align-items: flex-start; gap: .5rem; padding: .6rem .75rem; margin-bottom: 1rem;
      border-radius: 6px; font-size: .8rem; line-height: 1.5;
      background: var(--mantine-color-yellow-light); color: var(--mantine-color-yellow-light-color);
    }

    .ltrj-grid { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
    .ltrj-grid th {
      position: sticky; top: 0; z-index: 1; text-align: right; font-size: .68rem; font-weight: 600;
      text-transform: uppercase; letter-spacing: .05em; color: var(--mantine-color-dimmed);
      padding: .45rem .6rem; background: var(--mantine-color-body);
      border-bottom: 1px solid var(--mantine-color-default-border); white-space: nowrap;
    }
    .ltrj-grid th.l, .ltrj-grid td.l { text-align: left; }
    .ltrj-grid td {
      padding: .3rem .6rem; text-align: right; white-space: nowrap;
      border-bottom: 1px solid var(--mantine-color-default-border);
    }
    .ltrj-grid tbody tr:hover td { background: var(--mantine-color-default-hover); }
    .ltrj-name { display: flex; align-items: center; gap: .4rem; min-width: 0; }
    .ltrj-caret {
      flex: none; width: 1.1rem; height: 1.1rem; display: inline-flex; align-items: center;
      justify-content: center; cursor: pointer; border-radius: 3px; user-select: none;
      color: var(--mantine-color-dimmed); font-size: .65rem;
    }
    .ltrj-caret:hover { background: var(--mantine-color-default-border); color: var(--mantine-color-text); }
    .ltrj-link {
      overflow: hidden; text-overflow: ellipsis; cursor: pointer; text-decoration: none;
      color: var(--mantine-color-text);
    }
    .ltrj-link:hover { color: ${colours.series[0]}; text-decoration: underline; }
    .ltrj-ipn { font-size: .7rem; color: var(--mantine-color-dimmed); }
    .ltrj-cat { font-size: .75rem; color: var(--mantine-color-dimmed); }
    .ltrj-dim { color: var(--mantine-color-dimmed); }
    .ltrj-chip {
      display: inline-block; padding: .05rem .35rem; border-radius: 3px;
      font-size: .68rem; font-weight: 600;
    }
    .ltrj-ok  { background: var(--mantine-color-teal-light); color: var(--mantine-color-teal-light-color); }
    .ltrj-low { background: var(--mantine-color-yellow-light); color: var(--mantine-color-yellow-light-color); }
    .ltrj-no  { background: var(--mantine-color-red-light); color: var(--mantine-color-red-light-color); }
    .ltrj-foot {
      display: flex; justify-content: space-between; align-items: center; gap: 1rem;
      flex-wrap: wrap; margin-top: .75rem; font-size: .72rem; color: var(--mantine-color-dimmed);
    }
    .ltrj-btn {
      padding: .2rem .55rem; font: inherit; font-size: .72rem; cursor: pointer; border-radius: 5px;
      border: 1px solid var(--mantine-color-default-border); background: transparent;
      color: var(--mantine-color-dimmed);
    }
    .ltrj-btn:hover { color: var(--mantine-color-text); }
    @media (max-width: 720px) {
      .ltrj-hide-sm { display: none; }
      .ltrj-fig-v { font-size: 1.45rem; }
    }
  `;
}

/* ------------------------------------------------------------------ render */

export async function renderCostPanel(target, ctx) {
  if (!target) return;
  const api = ctx?.api;
  if (!api) {
    target.innerHTML = '<div style="padding:1rem;color:var(--mantine-color-red-6)">No API client available to this panel.</div>';
    return;
  }

  const colours = palette(ctx);
  const rootId = Number(ctx?.id ?? ctx?.instance?.pk);
  const rootName = ctx?.instance?.name ?? `Part ${rootId}`;

  if (!Number.isFinite(rootId)) {
    target.innerHTML = '<div style="padding:1rem;color:var(--mantine-color-dimmed)">No part in context.</div>';
    return;
  }

  let qty = loadQty();
  const open = loadSet(OPEN_STORE);
  const groups = Array.isArray(ctx?.context?.configGroups) ? ctx.context.configGroups : [];
  let choice = loadChoice(groups);

  target.innerHTML = `<div style="padding:1.5rem;color:var(--mantine-color-dimmed);font-size:.85rem">Loading pricing…</div>`;

  let index, fetchedAt;
  const bomCache = new Map();

  async function bomOf(partId) {
    if (!bomCache.has(partId)) bomCache.set(partId, await fetchAll(api, '/api/bom/', { part: partId }));
    return bomCache.get(partId);
  }

  async function loadIndex() {
    const data = await loadPricingData(api, ctx?.queryClient);
    index = buildIndex(data);
    fetchedAt = data.at ?? Date.now();
  }

  try {
    await loadIndex();
  } catch (err) {
    target.innerHTML = `<div style="padding:1rem;color:var(--mantine-color-red-6)">Could not load pricing: ${esc(err?.message ?? err)}</div>`;
    return;
  }

  const money = makeMoney(index.currency);

  function openPart(id) {
    try {
      if (ctx?.preview?.open) { ctx.preview.open('part', id); return; }
    } catch (e) { /* fall through to a navigation */ }
    try { ctx?.navigate?.(`/part/${id}/`); } catch (e) { /* ignore */ }
  }

  function stockCell(node) {
    const needed = node.need;
    const have = node.stock;
    if (!have && !node.minimum && !node.onOrder) {
      return `<span class="ltrj-chip ltrj-no">none</span>`;
    }
    const cls = have >= needed ? 'ltrj-ok' : (have > 0 ? 'ltrj-low' : 'ltrj-no');
    const extra = node.onOrder ? ` <span class="ltrj-dim">+${num(node.onOrder)} on order</span>` : '';
    return `<span class="ltrj-chip ${cls}">${num(have)}</span>${extra}`;
  }

  function rowHtml(row) {
    const n = row.node;
    const caret = row.hasKids
      ? `<span class="ltrj-caret" data-key="${esc(row.key)}">${row.open ? '▼' : '▶'}</span>`
      : `<span class="ltrj-caret" style="cursor:default"></span>`;
    const warn = n.priced ? ''
      : `<span class="ltrj-chip ltrj-low" title="no supplier pricing anywhere beneath this line">unpriced</span>`;
    const makeBuy = (n.buyCost != null && n.makeCost != null && n.makeCost > 0)
      ? `<span class="ltrj-dim" title="cost to build this sub-assembly from its own BOM">make ${esc(money(n.makeCost / qty))}</span>`
      : '';
    return `<tr>
      <td class="l" style="padding-left:${0.6 + row.depth * 1.15}rem">
        <div class="ltrj-name">
          ${caret}
          <a class="ltrj-link" data-part="${n.id}" title="${esc(n.name)}">${esc(n.name)}</a>
          ${n.ipn ? `<span class="ltrj-ipn">${esc(n.ipn)}</span>` : ''}
          ${warn}
        </div>
      </td>
      <td class="l ltrj-cat ltrj-hide-sm">${esc(n.category)}</td>
      <td class="ltrj-dim ltrj-hide-sm">${n.per != null ? `×${num(n.per)}` : ''}</td>
      <td>${num(n.need)}</td>
      <td class="ltrj-dim">${n.need > 0 && n.cost > 0 ? esc(money(n.cost / n.need)) : '—'}</td>
      <td style="font-weight:600">${esc(money(n.cost / qty))}</td>
      <td class="ltrj-hide-sm">${esc(money(n.cost))}</td>
      <td class="l ltrj-hide-sm">${stockCell(n)}</td>
      <td class="l ltrj-dim ltrj-hide-sm" style="font-size:.7rem">${makeBuy}</td>
    </tr>`;
  }

  let disposed = false;

  async function render() {
    if (disposed || !target.isConnected) return;

    const { excluded, universe } = resolveOptional(groups, choice);
    const tree = await buildTree(rootId, qty, 0, {
      infoOf: index.infoOf, unitCost: index.unitCost, bomOf, excluded,
    });
    const nodes = tree.children ?? [];
    const total = tree.cost;
    const perUnit = qty > 0 ? total / qty : 0;
    const unpriced = countUnpriced(nodes);

    // Top-level category split drives the bar and the legend.
    const groups = new Map();
    for (const n of nodes) {
      groups.set(n.category, (groups.get(n.category) ?? 0) + n.cost);
    }
    const ordered = [...groups.entries()].sort((a, b) => b[1] - a[1]);
    const bar = ordered.map(([cat, cost], i) => {
      const pct = total > 0 ? (cost / total) * 100 : 0;
      return `<div style="width:${pct}%;background:${colours.series[i % colours.series.length]}"
        title="${esc(cat)}: ${esc(money(cost / qty))}/unit"></div>`;
    }).join('');
    const legend = ordered.map(([cat, cost], i) => {
      const pct = total > 0 ? Math.round((cost / total) * 100) : 0;
      return `<span><span class="sw" style="background:${colours.series[i % colours.series.length]}"></span>${esc(cat)} ${pct}%</span>`;
    }).join('');

    const rows = flatten(nodes, open, 0, 'root', []);
    const age = Math.round((Date.now() - fetchedAt) / 1000);
    const ageText = age < 90 ? `${age}s ago` : `${Math.round(age / 60)}m ago`;

    target.innerHTML = `
      <style>${styles(colours)}</style>
      <div class="ltrj-wrap">
        <div class="ltrj-head">
          <div>
            <div class="ltrj-label">Build quantity</div>
            <div class="ltrj-qty-row" style="margin-top:.4rem">
              <input id="ltrj-qty" class="ltrj-input" type="number" min="1" step="1" value="${qty}">
              ${PRESETS.map((p) => `<button class="ltrj-preset" data-qty="${p}" data-active="${p === qty ? 1 : 0}">${p}</button>`).join('')}
            </div>
            ${groups.length ? `<div class="ltrj-config" style="margin-top:.85rem">
              ${groups.map((g) => `<div>
                <div class="ltrj-label">${esc(g.label ?? g.key)}</div>
                <select class="ltrj-select" data-group="${esc(g.key)}" style="margin-top:.3rem">
                  ${(g.options || []).map((o) => `<option value="${esc(o.key)}"${o.key === choice[g.key] ? ' selected' : ''}>${esc(o.label ?? o.key)}</option>`).join('')}
                </select>
              </div>`).join('')}
            </div>` : ''}
          </div>
          <div class="ltrj-figures">
            <div class="ltrj-fig">
              <div class="ltrj-label">Unit cost</div>
              <div class="ltrj-fig-v">${esc(money(perUnit))}</div>
            </div>
            <div class="ltrj-fig">
              <div class="ltrj-label">Total for ${num(qty)}</div>
              <div class="ltrj-fig-s" style="margin-top:.35rem">${esc(money(total))}</div>
            </div>
          </div>
        </div>

        <div class="ltrj-bar">${bar || ''}</div>
        <div class="ltrj-legend">${legend || '<span>No costed lines</span>'}</div>

        ${unpriced.length ? `<div class="ltrj-note">
          <span>⚠</span>
          <div><strong>${unpriced.length} line${unpriced.length === 1 ? '' : 's'} carry no supplier pricing</strong>
          and contribute nothing to the total, so ${esc(money(perUnit))}/unit is a floor, not the real cost:
          ${esc(unpriced.slice(0, 6).map((n) => n.name).join(', '))}${unpriced.length > 6 ? `, and ${unpriced.length - 6} more` : ''}.</div>
        </div>` : ''}

        <div style="overflow-x:auto">
        <table class="ltrj-grid">
          <thead><tr>
            <th class="l">Part</th>
            <th class="l ltrj-hide-sm">Category</th>
            <th class="ltrj-hide-sm">Per</th>
            <th>Qty</th>
            <th>Unit price</th>
            <th>Per build unit</th>
            <th class="ltrj-hide-sm">Extended</th>
            <th class="l ltrj-hide-sm">Stock</th>
            <th class="l ltrj-hide-sm"></th>
          </tr></thead>
          <tbody>${rows.map(rowHtml).join('') || `<tr><td colspan="9" class="ltrj-dim" style="padding:1rem;text-align:left">${esc(rootName)} has no BOM lines.</td></tr>`}</tbody>
        </table>
        </div>

        <div class="ltrj-foot">
          <div>${rows.length} row${rows.length === 1 ? '' : 's'} shown · ${nodes.length} top-level line${nodes.length === 1 ? '' : 's'} · prices in ${esc(index.currency)}${
            excluded.size ? ` · ${excluded.size} of ${universe.size} optional part${universe.size === 1 ? '' : 's'} excluded by configuration` : ''}</div>
          <div style="display:flex;align-items:center;gap:.5rem">
            <span>Pricing fetched ${esc(ageText)}</span>
            <button class="ltrj-btn" id="ltrj-refresh">Refresh</button>
          </div>
        </div>
      </div>
    `;

    /* ---- interaction ---- */

    const apply = (v) => {
      const n = Math.max(1, Math.floor(Number(v) || 1));
      if (n === qty) return;
      qty = n;
      try { localStorage.setItem(QTY_STORE, String(qty)); } catch (e) { /* ignore */ }
      render();
    };

    const input = target.querySelector('#ltrj-qty');
    input?.addEventListener('change', (e) => apply(e.target.value));
    input?.addEventListener('keydown', (e) => { if (e.key === 'Enter') apply(e.target.value); });

    target.querySelectorAll('button[data-qty]').forEach((b) =>
      b.addEventListener('click', () => apply(b.dataset.qty)));

    target.querySelectorAll('select[data-group]').forEach((sel) =>
      sel.addEventListener('change', () => {
        choice = { ...choice, [sel.dataset.group]: sel.value };
        saveChoice(choice);
        render();
      }));

    target.querySelectorAll('.ltrj-caret[data-key]').forEach((el) =>
      el.addEventListener('click', () => {
        const k = el.dataset.key;
        if (open.has(k)) open.delete(k); else open.add(k);
        saveSet(OPEN_STORE, open);
        render();
      }));

    target.querySelectorAll('a[data-part]').forEach((el) =>
      el.addEventListener('click', (e) => {
        e.preventDefault();
        openPart(Number(el.dataset.part));
      }));

    target.querySelector('#ltrj-refresh')?.addEventListener('click', async () => {
      try {
        await ctx?.queryClient?.invalidateQueries?.({ queryKey: ['ltrj-cost-panel', 'pricing'] });
      } catch (e) { /* ignore */ }
      bomCache.clear();
      await loadIndex();
      render();
    });
  }

  await render();

  // Keep the panel current without a reload. InvenTree has no push channel for
  // pricing, so this polls -- paced to SupplierSync's cadence rather than tight,
  // and stopped as soon as the panel leaves the DOM.
  const timer = setInterval(async () => {
    if (disposed || !target.isConnected) { disposed = true; clearInterval(timer); return; }
    try {
      await ctx?.queryClient?.invalidateQueries?.({ queryKey: ['ltrj-cost-panel', 'pricing'] });
      await loadIndex();
      await render();
    } catch (e) { /* a failed refresh should never blank a working panel */ }
  }, REFRESH_MS);
}

export const renderPanel = renderCostPanel;
