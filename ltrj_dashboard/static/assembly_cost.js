import { palette, shell, message, esc, fetchAll } from './_chart.js';

/**
 * Unit cost of a product assembly at a chosen build quantity.
 *
 * Enter a number of units and every line is priced at the break it would
 * actually hit for that quantity. Tier selection deliberately never
 * extrapolates: the best break at or below the required quantity wins, and
 * below the smallest break the smallest price is used unchanged -- a part
 * quoted once at 5 off costs the same per unit at 1, 6 or 500. That matches
 * how the sync computes its ladders, so the two always agree.
 */

const PRESETS = [1, 5, 10, 25, 50, 100, 250];
const STORE = 'ltrj-assembly-qty';

function money(v, cur) {
  const n = Number(v ?? 0);
  return `${n.toFixed(n < 1 ? 4 : 2)} ${cur || ''}`.trim();
}

/** Best price break at or below `need`; never below the smallest break. */
function tierPrice(breaks, need) {
  if (!breaks || !breaks.length) return null;
  const ladder = breaks
    .map((b) => ({ q: Number(b.quantity), p: Number(b.price) }))
    .filter((b) => Number.isFinite(b.q) && Number.isFinite(b.p))
    .sort((a, b) => a.q - b.q);
  if (!ladder.length) return null;
  const applicable = ladder.filter((b) => b.q <= need);
  return (applicable.length ? applicable[applicable.length - 1] : ladder[0]).p;
}

export async function renderDashboardItem(target, ctx) {
  if (!target) return;
  const api = ctx?.api;
  if (!api) {
    message(target, 'No API client available to this widget.', 'error');
    return;
  }

  let qty = 1;
  try {
    const saved = Number(localStorage.getItem(STORE));
    if (Number.isFinite(saved) && saved > 0) qty = saved;
  } catch (e) { /* private mode */ }

  message(target, 'Loading assembly…');

  // ---- resolve the product part -------------------------------------
  const configured = String(ctx?.context?.productPartId ?? '').trim();
  let part;
  try {
    if (configured) {
      part = (await api.get(`/api/part/${configured}/`))?.data;
    } else {
      const assemblies = await fetchAll(api, '/api/part/', { assembly: true, active: true });
      if (!assemblies.length) {
        message(target, 'No assemblies found. Set a product part in the plugin settings.');
        return;
      }
      assemblies.sort((a, b) => (b.bom_items ?? 0) - (a.bom_items ?? 0));
      part = assemblies[0];
    }
  } catch (err) {
    message(target, `Could not load the product part: ${err?.message ?? err}`, 'error');
    return;
  }

  // ---- gather everything needed to price the BOM at any quantity ------
  let lines, supplierParts, breaks, rates, currency = 'USD';
  try {
    [lines, supplierParts, breaks] = await Promise.all([
      fetchAll(api, '/api/bom/', { part: part.pk }),
      fetchAll(api, '/api/company/part/', { active: true }),
      fetchAll(api, '/api/company/price-break/', {}),
    ]);
    const fx = (await api.get('/api/currency/exchange/'))?.data;
    rates = fx?.exchange_rates ?? {};
    currency = fx?.base_currency ?? 'USD';
  } catch (err) {
    message(target, `Could not load pricing data: ${err?.message ?? err}`, 'error');
    return;
  }

  const spByPart = new Map();
  for (const sp of supplierParts) {
    if (!spByPart.has(sp.part)) spByPart.set(sp.part, []);
    spByPart.get(sp.part).push(sp);
  }
  const breaksBySp = new Map();
  for (const b of breaks) {
    if (!breaksBySp.has(b.part)) breaksBySp.set(b.part, []);
    breaksBySp.get(b.part).push(b);
  }
  const toBase = (v, cur) => Number(v) / Number(rates[cur || currency] ?? 1);

  /** Cheapest unit cost for `need` units of a part, in base currency. */
  function unitCost(partId, need) {
    let best = null;
    for (const sp of spByPart.get(partId) ?? []) {
      const price = tierPrice(breaksBySp.get(sp.pk), need);
      if (price == null) continue;
      const pack = Number(sp.pack_quantity_native ?? 1) || 1;
      const rows = breaksBySp.get(sp.pk) ?? [];
      const cur = rows.length ? rows[0].price_currency : currency;
      const u = toBase(price, cur) / pack;
      if (best == null || u < best) best = u;
    }
    return best;
  }

  const colours = palette(ctx);

  function render() {
    const rows = [];
    let total = 0;
    const unpriced = [];
    for (const line of lines) {
      const sub = line.sub_part_detail ?? {};
      const per = Number(line.quantity ?? 0);
      const need = per * qty;
      const u = unitCost(line.sub_part, need);
      if (u == null) {
        unpriced.push(sub.name || `Part ${line.sub_part}`);
        continue;
      }
      const ext = u * need;
      total += ext;
      rows.push({
        name: sub.name || `Part ${line.sub_part}`,
        category: sub.category_detail?.name || sub.category_name || 'Uncategorised',
        per, unit: u, ext,
      });
    }
    const perBoard = qty > 0 ? total / qty : 0;

    const byCat = new Map();
    for (const r of rows) byCat.set(r.category, (byCat.get(r.category) ?? 0) + r.ext);
    const cats = [...byCat.entries()].sort((a, b) => b[1] - a[1]);
    const bar = cats.map(([label, v], i) => {
      const pct = total > 0 ? (v / total) * 100 : 0;
      return `<div title="${esc(label)}: ${money(v, currency)}"
        style="width:${pct}%;background:${colours.series[i % colours.series.length]}"></div>`;
    }).join('');
    const catRows = cats.map(([label, v], i) => {
      const pct = total > 0 ? Math.round((v / total) * 100) : 0;
      return `<div style="display:flex;align-items:center;gap:.5rem;font-size:.78rem;line-height:1.55">
        <span style="flex:none;width:.6rem;height:.6rem;border-radius:2px;background:${colours.series[i % colours.series.length]}"></span>
        <span style="flex:1;color:var(--mantine-color-text)">${esc(label)}</span>
        <span style="font-variant-numeric:tabular-nums;color:var(--mantine-color-dimmed)">${esc(money(v / qty, currency))}/unit · ${pct}%</span>
      </div>`;
    }).join('');

    const top = rows.sort((a, b) => b.ext - a.ext).slice(0, 4).map((r) =>
      `<div style="display:flex;gap:.5rem;font-size:.74rem;line-height:1.5">
         <span style="flex:1;color:var(--mantine-color-dimmed)">${esc(r.name)}</span>
         <span style="font-variant-numeric:tabular-nums;color:var(--mantine-color-dimmed)">${esc(money(r.ext / qty, currency))}</span>
       </div>`).join('');

    const warn = unpriced.length
      ? `<div style="margin-top:.6rem;padding:.45rem .6rem;border-radius:4px;
             background:var(--mantine-color-yellow-light);font-size:.72rem;line-height:1.45">
           <strong>${unpriced.length} line${unpriced.length === 1 ? '' : 's'} unpriced</strong> —
           understated. ${esc(unpriced.slice(0, 3).join(', '))}${unpriced.length > 3 ? `, +${unpriced.length - 3}` : ''}
         </div>` : '';

    shell(target, `
      <div style="display:flex;align-items:center;gap:.5rem;flex-wrap:wrap;margin-bottom:.5rem">
        <label for="ltrj-qty" style="font-size:.74rem;color:var(--mantine-color-dimmed)">Build quantity</label>
        <input id="ltrj-qty" type="number" min="1" step="1" value="${qty}"
          style="width:5.5rem;padding:.25rem .4rem;font-family:inherit;font-size:.85rem;
                 font-variant-numeric:tabular-nums;color:var(--mantine-color-text);
                 background:var(--mantine-color-body);border:1px solid var(--mantine-color-default-border);
                 border-radius:4px">
        <div style="display:flex;gap:.25rem;flex-wrap:wrap">
          ${PRESETS.map((p) => `<button data-qty="${p}" style="padding:.15rem .4rem;font-size:.7rem;
              cursor:pointer;border-radius:3px;border:1px solid var(--mantine-color-default-border);
              background:${p === qty ? 'var(--mantine-color-blue-light)' : 'transparent'};
              color:var(--mantine-color-text)">${p}</button>`).join('')}
        </div>
      </div>
      <div style="display:flex;align-items:baseline;justify-content:space-between;gap:.5rem;flex-wrap:wrap">
        <div style="font-size:.78rem;color:var(--mantine-color-dimmed)">${esc(part?.name ?? '')}</div>
        <div style="text-align:right">
          <div style="font-size:1.5rem;font-weight:600;font-variant-numeric:tabular-nums;color:var(--mantine-color-text)">
            ${esc(money(perBoard, currency))}<span style="font-size:.7rem;font-weight:400;color:var(--mantine-color-dimmed)">/unit</span>
          </div>
          <div style="font-size:.72rem;color:var(--mantine-color-dimmed);font-variant-numeric:tabular-nums">
            ${esc(money(total, currency))} for ${qty}
          </div>
        </div>
      </div>
      <div style="display:flex;height:.5rem;border-radius:3px;overflow:hidden;margin:.55rem 0 .6rem;
                  background:var(--mantine-color-default-border)">${bar}</div>
      <div style="display:flex;flex-direction:column;gap:.1rem">${catRows}</div>
      <div style="margin-top:.55rem;padding-top:.4rem;border-top:1px solid var(--mantine-color-default-border)">
        <div style="font-size:.68rem;text-transform:uppercase;letter-spacing:.08em;
                    color:var(--mantine-color-dimmed);margin-bottom:.2rem">Largest lines / unit</div>
        ${top}
      </div>
      ${warn}
    `);

    const input = target.querySelector('#ltrj-qty');
    const apply = (v) => {
      const n = Math.max(1, Math.floor(Number(v) || 1));
      if (n === qty) return;
      qty = n;
      try { localStorage.setItem(STORE, String(qty)); } catch (e) { /* ignore */ }
      render();
    };
    input?.addEventListener('change', (e) => apply(e.target.value));
    input?.addEventListener('keydown', (e) => { if (e.key === 'Enter') apply(e.target.value); });
    target.querySelectorAll('button[data-qty]').forEach((b) =>
      b.addEventListener('click', () => apply(b.dataset.qty)));
  }

  render();
}
