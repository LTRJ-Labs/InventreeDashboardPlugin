import { palette, donut, legend, shell, message, fetchAll } from './_chart.js';

/**
 * Parts grouped by stock health.
 *
 * "Low" means below the part's own minimum_stock. Parts with no minimum set
 * fall back to the plugin's threshold setting, so the widget still says
 * something useful before reorder points have been configured.
 */
export async function renderDashboardItem(target, ctx) {
  if (!target) return;
  message(target, 'Loading stock status…');

  const api = ctx?.api;
  if (!api) {
    message(target, 'No API client available to this widget.', 'error');
    return;
  }

  let parts;
  try {
    parts = await fetchAll(api, '/api/part/', { active: true });
  } catch (err) {
    message(target, `Could not load parts: ${err?.message ?? err}`, 'error');
    return;
  }

  const colours = palette(ctx);
  const fallback = Number(ctx?.context?.lowStockFallback ?? 0) || 0;

  const buckets = { out: 0, low: 0, ok: 0 };
  for (const part of parts) {
    const stock = Number(part.in_stock ?? 0);
    const minimum = Number(part.minimum_stock ?? 0) || fallback;
    if (stock <= 0) buckets.out++;
    else if (minimum > 0 && stock < minimum) buckets.low++;
    else buckets.ok++;
  }

  const slices = [
    { label: 'In stock', value: buckets.ok, color: colours.good },
    { label: 'Below minimum', value: buckets.low, color: colours.warn },
    { label: 'Out of stock', value: buckets.out, color: colours.bad },
  ];

  const total = parts.length;
  const withMinimum = parts.filter((p) => Number(p.minimum_stock ?? 0) > 0).length;

  const hint =
    withMinimum === 0 && fallback === 0
      ? `<div style="margin-top:.6rem;font-size:.72rem;color:var(--mantine-color-dimmed);line-height:1.4">
           No reorder points set — "below minimum" stays empty until parts have a
           minimum stock, or a fallback threshold is set in plugin settings.
         </div>`
      : '';

  shell(
    target,
    `<div style="display:flex;gap:1.1rem;align-items:center;flex-wrap:wrap">
       <div style="flex:none">${donut(slices, { centre: String(total) })}</div>
       <div style="flex:1;min-width:10rem;display:flex;flex-direction:column;gap:.35rem">
         ${legend(slices)}
       </div>
     </div>
     ${hint}`
  );
}
