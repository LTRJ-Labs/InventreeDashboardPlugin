import { palette, donut, legend, shell, message, fetchAll, esc } from './_chart-b28175df.js';

/** How the part catalogue is distributed across categories. */
export async function renderDashboardItem(target, ctx) {
  if (!target) return;
  message(target, 'Loading categories…');

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

  const counts = new Map();
  for (const part of parts) {
    const name = part?.category_detail?.name || part?.category_name || 'Uncategorised';
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }

  const colours = palette(ctx);
  const ordered = [...counts.entries()].sort((a, b) => b[1] - a[1]);

  // Keep the chart readable: chart the largest, roll the tail into "Other".
  const MAX = 7;
  const head = ordered.slice(0, MAX);
  const tail = ordered.slice(MAX);
  if (tail.length) {
    head.push(['Other', tail.reduce((sum, [, n]) => sum + n, 0)]);
  }

  const slices = head.map(([label, value], i) => ({
    label,
    value,
    color: label === 'Other' ? colours.idle : colours.series[i % colours.series.length],
    display: `${value} · ${Math.round((value / parts.length) * 100)}%`,
  }));

  shell(
    target,
    `<div style="display:flex;gap:1.1rem;align-items:center;flex-wrap:wrap">
       <div style="flex:none">${donut(slices, { centre: String(parts.length) })}</div>
       <div style="flex:1;min-width:11rem;display:flex;flex-direction:column;gap:.35rem">
         ${legend(slices)}
       </div>
     </div>
     <div style="margin-top:.6rem;font-size:.72rem;color:var(--mantine-color-dimmed)">
       ${esc(parts.length)} active parts across ${esc(counts.size)} categories
     </div>`
  );
}
