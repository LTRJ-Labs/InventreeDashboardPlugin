import { palette, shell, message, esc, fetchAll } from './_chart-b28175df.js';

/**
 * Unit cost of a product assembly at a chosen build quantity, browsable as a
 * tree: categories open into their parts, and any part that is itself an
 * assembly opens into its own BOM, all the way down.
 *
 * Tier selection never extrapolates: the best break at or below the required
 * quantity wins, and below the smallest break the smallest price is used
 * unchanged. A part quoted once at 5 off costs the same per unit at 1, 6 or
 * 500. This matches how Inventree_SupplierSync builds its ladders.
 */

const PRESETS = [1, 5, 10, 25, 50, 100, 250];
const QTY_STORE = 'ltrj-assembly-qty';
const OPEN_STORE = 'ltrj-assembly-open';

const money = (v, cur) => {
  const n = Number(v ?? 0);
  return `${n.toFixed(n !== 0 && Math.abs(n) < 1 ? 4 : 2)} ${cur || ''}`.trim();
};

function tierPrice(breaks, need) {
  if (!breaks || !breaks.length) return null;
  const ladder = breaks
    .map((b) => ({ q: Number(b.quantity), p: Number(b.price), c: b.price_currency }))
    .filter((b) => Number.isFinite(b.q) && Number.isFinite(b.p))
    .sort((a, b) => a.q - b.q);
  if (!ladder.length) return null;
  const ok = ladder.filter((b) => b.q <= need);
  const hit = ok.length ? ok[ok.length - 1] : ladder[0];
  // Carry the currency of the break that actually won. Reading it off the
  // first row instead is wrong whenever one supplier part quotes in two.
  return { price: hit.p, currency: hit.c };
}

function loadSet(key) {
  try { return new Set(JSON.parse(localStorage.getItem(key) || '[]')); }
  catch (e) { return new Set(); }
}
function saveSet(key, set) {
  try { localStorage.setItem(key, JSON.stringify([...set])); } catch (e) { /* ignore */ }
}

export async function renderDashboardItem(target, ctx) {
  if (!target) return;
  const api = ctx?.api;
  if (!api) { message(target, 'No API client available to this widget.', 'error'); return; }

  let qty = 1;
  try {
    const s = Number(localStorage.getItem(QTY_STORE));
    if (Number.isFinite(s) && s > 0) qty = s;
  } catch (e) { /* ignore */ }
  const open = loadSet(OPEN_STORE);

  message(target, 'Loading assembly…');

  const configured = String(ctx?.context?.productPartId ?? '').trim();
  let root;
  try {
    if (configured) root = (await api.get(`/api/part/${configured}/`))?.data;
    else {
      const asm = await fetchAll(api, '/api/part/', { assembly: true, active: true });
      if (!asm.length) { message(target, 'No assemblies found. Set a product part in plugin settings.'); return; }
      asm.sort((a, b) => (b.bom_items ?? 0) - (a.bom_items ?? 0));
      root = asm[0];
    }
  } catch (err) { message(target, `Could not load product part: ${err?.message ?? err}`, 'error'); return; }

  let supplierParts, breaks, allParts, rates, currency = 'USD';
  try {
    // /api/bom/ returns neither name nor category for its lines -- even with
    // sub_part_detail expanded there is no category field -- so the part
    // catalogue is fetched once and used to resolve both.
    [supplierParts, breaks, allParts] = await Promise.all([
      fetchAll(api, '/api/company/part/', { active: true }),
      fetchAll(api, '/api/company/price-break/', {}),
      fetchAll(api, '/api/part/', {}),
    ]);
    const fx = (await api.get('/api/currency/exchange/'))?.data;
    rates = fx?.exchange_rates ?? {}; currency = fx?.base_currency ?? 'USD';
  } catch (err) { message(target, `Could not load pricing: ${err?.message ?? err}`, 'error'); return; }

  const partInfo = new Map();
  for (const p of allParts) {
    partInfo.set(p.pk, {
      name: p.name || `Part ${p.pk}`,
      category: p.category_detail?.name || p.category_name || 'Uncategorised',
      assembly: !!p.assembly,
    });
  }
  const infoOf = (id) => partInfo.get(id) || { name: `Part ${id}`, category: 'Uncategorised' };

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

  // BOMs are fetched once per part and reused as the tree is opened.
  const bomCache = new Map();
  async function bomOf(partId) {
    if (!bomCache.has(partId)) bomCache.set(partId, await fetchAll(api, '/api/bom/', { part: partId }));
    return bomCache.get(partId);
  }

  /**
   * Cost a part for `need` units. A part with its own supplier pricing uses
   * it; otherwise we descend into its BOM. Returns {cost, children, priced}.
   */
  async function costOf(partId, need, depth) {
    const direct = unitCost(partId, need);
    if (direct != null) return { cost: direct * need, children: null, priced: true };
    if (depth > 6) return { cost: 0, children: null, priced: false };
    const lines = await bomOf(partId);
    if (!lines.length) return { cost: 0, children: null, priced: false };
    const children = [];
    let total = 0;
    let allPriced = true;
    for (const l of lines) {
      const info = infoOf(l.sub_part);
      const per = Number(l.quantity ?? 0);
      const r = await costOf(l.sub_part, per * need, depth + 1);
      total += r.cost;
      if (!r.priced) allPriced = false;
      children.push({
        id: l.sub_part, name: info.name, category: info.category,
        per, need: per * need, cost: r.cost, priced: r.priced, kids: r.children,
      });
    }
    // An assembly is only priced when everything beneath it is. Returning true
    // unconditionally is how a sub-assembly of entirely unpriced parts reported
    // a confident cost of zero, with no warning anywhere up the tree.
    return { cost: total, children, priced: allPriced };
  }

  const colours = palette(ctx);

  function rowHtml(node, key, depth) {
    const hasKids = Array.isArray(node.kids) && node.kids.length;
    const isOpen = open.has(key);
    const arrow = hasKids
      ? `<span data-key="${esc(key)}" style="cursor:pointer;display:inline-block;width:.9rem;
           color:var(--mantine-color-dimmed);user-select:none">${isOpen ? '▾' : '▸'}</span>`
      : `<span style="display:inline-block;width:.9rem"></span>`;
    const warn = node.priced ? '' :
      `<span title="no supplier pricing" style="color:var(--mantine-color-yellow-6)">⚠</span>`;
    const per = node.per != null
      ? `<span style="color:var(--mantine-color-dimmed);font-size:.68rem">×${node.per}</span>` : '';
    return `<div style="display:flex;align-items:center;gap:.4rem;font-size:.76rem;line-height:1.7;
              padding-left:${depth * 0.95}rem">
        ${arrow}
        <span style="flex:1;color:var(--mantine-color-text);overflow:hidden;text-overflow:ellipsis;
              white-space:nowrap">${esc(node.name)} ${per} ${warn}</span>
        <span style="font-variant-numeric:tabular-nums;color:var(--mantine-color-dimmed)">
          ${esc(money(node.cost / qty, currency))}</span>
      </div>` +
      (hasKids && isOpen ? node.kids.map((k, i) => rowHtml(k, `${key}/${k.id}-${i}`, depth + 1)).join('') : '');
  }

  async function render() {
    const res = await costOf(root.pk, qty, 0);
    const nodes = res.children ?? [];
    const total = res.cost;
    const perUnit = qty > 0 ? total / qty : 0;

    // Top level groups by category, each opening into its parts.
    const groups = new Map();
    for (const n of nodes) {
      if (!groups.has(n.category)) groups.set(n.category, []);
      groups.get(n.category).push(n);
    }
    const ordered = [...groups.entries()]
      .map(([cat, items]) => ({ cat, items, cost: items.reduce((s, i) => s + i.cost, 0) }))
      .sort((a, b) => b.cost - a.cost);

    const bar = ordered.map((g, i) => {
      const pct = total > 0 ? (g.cost / total) * 100 : 0;
      return `<div title="${esc(g.cat)}: ${money(g.cost / qty, currency)}/unit"
        style="width:${pct}%;background:${colours.series[i % colours.series.length]}"></div>`;
    }).join('');

    const tree = ordered.map((g, i) => {
      const key = `cat:${g.cat}`;
      const isOpen = open.has(key);
      const pct = total > 0 ? Math.round((g.cost / total) * 100) : 0;
      return `<div style="display:flex;align-items:center;gap:.4rem;font-size:.79rem;line-height:1.85">
          <span data-key="${esc(key)}" style="cursor:pointer;display:inline-block;width:.9rem;
                color:var(--mantine-color-dimmed);user-select:none">${isOpen ? '▾' : '▸'}</span>
          <span style="flex:none;width:.6rem;height:.6rem;border-radius:2px;
                background:${colours.series[i % colours.series.length]}"></span>
          <span style="flex:1;color:var(--mantine-color-text)">${esc(g.cat)}</span>
          <span style="font-variant-numeric:tabular-nums;color:var(--mantine-color-dimmed)">
            ${esc(money(g.cost / qty, currency))} · ${pct}%</span>
        </div>` +
        (isOpen ? g.items.sort((a, b) => b.cost - a.cost)
            .map((n, j) => rowHtml(n, `${key}/${n.id}-${j}`, 1)).join('') : '');
    }).join('');

    shell(target, `
      <div style="display:flex;align-items:center;gap:.5rem;flex-wrap:wrap;margin-bottom:.45rem">
        <label for="ltrj-qty" style="font-size:.72rem;color:var(--mantine-color-dimmed)">Build quantity</label>
        <input id="ltrj-qty" type="number" min="1" step="1" value="${qty}"
          style="width:5rem;padding:.2rem .35rem;font:inherit;font-size:.82rem;
                 font-variant-numeric:tabular-nums;color:var(--mantine-color-text);
                 background:var(--mantine-color-body);
                 border:1px solid var(--mantine-color-default-border);border-radius:4px">
        <div style="display:flex;gap:.2rem;flex-wrap:wrap">
          ${PRESETS.map((p) => `<button data-qty="${p}" style="padding:.12rem .38rem;font-size:.68rem;
            cursor:pointer;border-radius:3px;border:1px solid var(--mantine-color-default-border);
            background:${p === qty ? 'var(--mantine-color-blue-light)' : 'transparent'};
            color:var(--mantine-color-text)">${p}</button>`).join('')}
        </div>
      </div>
      <div style="display:flex;align-items:baseline;justify-content:space-between;gap:.5rem;flex-wrap:wrap">
        <div style="font-size:.76rem;color:var(--mantine-color-dimmed)">${esc(root?.name ?? '')}</div>
        <div style="text-align:right">
          <div style="font-size:1.45rem;font-weight:600;font-variant-numeric:tabular-nums;
                      color:var(--mantine-color-text)">${esc(money(perUnit, currency))}<span
            style="font-size:.68rem;font-weight:400;color:var(--mantine-color-dimmed)">/unit</span></div>
          <div style="font-size:.7rem;color:var(--mantine-color-dimmed);font-variant-numeric:tabular-nums">
            ${esc(money(total, currency))} for ${qty}</div>
        </div>
      </div>
      <div style="display:flex;height:.45rem;border-radius:3px;overflow:hidden;margin:.5rem 0 .5rem;
                  background:var(--mantine-color-default-border)">${bar}</div>
      <div>${tree}</div>
    `);

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
    target.querySelectorAll('[data-key]').forEach((el) =>
      el.addEventListener('click', () => {
        const k = el.dataset.key;
        if (open.has(k)) open.delete(k); else open.add(k);
        saveSet(OPEN_STORE, open);
        render();
      }));
  }

  await render();
}
