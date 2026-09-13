import { palette, shell, message, esc, fetchAll } from './_chart.js';

/**
 * Unit cost of the product assembly, broken down by category.
 *
 * Walks the BOM one level deep, resolving sub-assemblies to their own BOM cost
 * so a PCBA contributes as a single line rather than 59. Lines that price at
 * zero are called out explicitly: a missing price is the most common reason a
 * unit cost is quietly wrong, and it should be visible rather than averaged in.
 */

function money(value, currency) {
  const n = Number(value ?? 0);
  return `${n.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')} ${currency || ''}`.trim();
}

async function bomCost(api, partId) {
  try {
    const res = await api.get(`/api/part/${partId}/pricing/`);
    const d = res?.data ?? {};
    const min = d.bom_cost_min ?? d.overall_min;
    return {
      value: min == null ? null : Number(min),
      currency: d.currency || '',
    };
  } catch {
    return { value: null, currency: '' };
  }
}

export async function renderDashboardItem(target, ctx) {
  if (!target) return;

  const api = ctx?.api;
  if (!api) {
    message(target, 'No API client available to this widget.', 'error');
    return;
  }

  const configured = String(ctx?.context?.productPartId ?? '').trim();
  message(target, 'Loading assembly cost…');

  let partId = configured;
  let part = null;

  try {
    if (!partId) {
      // No part configured: fall back to the assembly with the deepest BOM.
      const assemblies = await fetchAll(api, '/api/part/', { assembly: true, active: true });
      if (!assemblies.length) {
        message(target, 'No assemblies found. Set a product part in the plugin settings.');
        return;
      }
      assemblies.sort((a, b) => (b.bom_items ?? 0) - (a.bom_items ?? 0));
      part = assemblies[0];
      partId = part.pk;
    } else {
      part = (await api.get(`/api/part/${partId}/`))?.data;
    }
  } catch (err) {
    message(target, `Could not load the product part: ${err?.message ?? err}`, 'error');
    return;
  }

  let bom;
  try {
    bom = await fetchAll(api, '/api/bom/', { part: partId });
  } catch (err) {
    message(target, `Could not load the BOM: ${err?.message ?? err}`, 'error');
    return;
  }

  if (!bom.length) {
    message(target, `${part?.name ?? 'This part'} has no BOM lines.`);
    return;
  }

  // Price each line: sub-assemblies roll up their own BOM cost.
  const rows = [];
  let currency = '';
  for (const line of bom) {
    const sub = line.sub_part_detail ?? {};
    const qty = Number(line.quantity ?? 0);
    let unit = null;

    if (line.price_range || line.pricing_min != null) {
      unit = Number(line.pricing_min ?? 0) || null;
    }
    if (unit == null) {
      const priced = await bomCost(api, line.sub_part);
      unit = priced.value;
      currency = currency || priced.currency;
    }

    rows.push({
      name: sub.name || `Part ${line.sub_part}`,
      category: sub.category_detail?.name || sub.category_name || 'Uncategorised',
      qty,
      unit,
      total: unit == null ? null : unit * qty,
      assembly: !!sub.assembly,
    });
  }

  const overall = await bomCost(api, partId);
  currency = overall.currency || currency || '';

  const priced = rows.filter((r) => r.total != null && r.total > 0);
  const unpriced = rows.filter((r) => r.total == null || r.total === 0);
  const sum = priced.reduce((acc, r) => acc + r.total, 0);

  const colours = palette(ctx);

  // Group the priced lines by category for the contribution bar.
  const byCategory = new Map();
  for (const r of priced) {
    byCategory.set(r.category, (byCategory.get(r.category) ?? 0) + r.total);
  }
  const cats = [...byCategory.entries()].sort((a, b) => b[1] - a[1]);

  const bar = cats
    .map(([label, value], i) => {
      const pct = sum > 0 ? (value / sum) * 100 : 0;
      const colour = colours.series[i % colours.series.length];
      return `<div title="${esc(label)}: ${money(value, currency)}"
        style="width:${pct}%;background:${colour}"></div>`;
    })
    .join('');

  const catRows = cats
    .map(([label, value], i) => {
      const colour = colours.series[i % colours.series.length];
      const pct = sum > 0 ? Math.round((value / sum) * 100) : 0;
      return `<div style="display:flex;align-items:center;gap:.5rem;font-size:.78rem;line-height:1.6">
        <span style="flex:none;width:.6rem;height:.6rem;border-radius:2px;background:${colour}"></span>
        <span style="flex:1;color:var(--mantine-color-text)">${esc(label)}</span>
        <span style="font-variant-numeric:tabular-nums;color:var(--mantine-color-dimmed)">${esc(money(value, currency))} · ${pct}%</span>
      </div>`;
    })
    .join('');

  const warning = unpriced.length
    ? `<div style="margin-top:.7rem;padding:.5rem .65rem;border-radius:4px;
            background:var(--mantine-color-yellow-light);font-size:.74rem;line-height:1.5">
         <strong>${unpriced.length} line${unpriced.length === 1 ? '' : 's'} priced at zero</strong> —
         this unit cost is understated. ${esc(unpriced.slice(0, 4).map((r) => r.name).join(', '))}${
           unpriced.length > 4 ? `, +${unpriced.length - 4} more` : ''
         }
       </div>`
    : '';

  shell(
    target,
    `<div style="display:flex;align-items:baseline;justify-content:space-between;gap:.5rem;flex-wrap:wrap">
       <div style="font-size:.8rem;color:var(--mantine-color-dimmed)">${esc(part?.name ?? '')}</div>
       <div style="font-size:1.6rem;font-weight:600;font-variant-numeric:tabular-nums;color:var(--mantine-color-text)">
         ${esc(money(overall.value ?? sum, currency))}
       </div>
     </div>
     <div style="display:flex;height:.55rem;border-radius:3px;overflow:hidden;margin:.6rem 0 .7rem;
                 background:var(--mantine-color-default-border)">${bar}</div>
     <div style="display:flex;flex-direction:column;gap:.1rem">${catRows}</div>
     ${warning}
     <div style="margin-top:.6rem;font-size:.7rem;color:var(--mantine-color-dimmed)">
       ${esc(rows.length)} BOM lines · sub-assemblies rolled up
     </div>`
  );
}
