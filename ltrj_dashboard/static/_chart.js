/**
 * Shared rendering helpers for the LTRJ dashboard widgets.
 *
 * Deliberately dependency-free: InvenTree exposes React and Mantine globally,
 * but these widgets are small enough that plain DOM keeps them legible and
 * avoids coupling to a specific React version. Colours are pulled from the
 * Mantine theme handed to the widget so both light and dark themes work.
 */

export function palette(ctx) {
  const t = ctx?.theme ?? {};
  const c = t.colors ?? {};
  const pick = (name, shade, fallback) =>
    (Array.isArray(c[name]) && c[name][shade]) || fallback;
  return {
    good: pick('teal', 6, '#0ca678'),
    warn: pick('yellow', 6, '#f59f00'),
    bad: pick('red', 6, '#e03131'),
    idle: pick('gray', 5, '#adb5bd'),
    series: [
      pick('blue', 6, '#1971c2'),
      pick('teal', 6, '#0ca678'),
      pick('violet', 6, '#7048e8'),
      pick('orange', 6, '#e8590c'),
      pick('cyan', 6, '#0c8599'),
      pick('pink', 6, '#c2255c'),
      pick('lime', 7, '#66a80f'),
      pick('grape', 6, '#9c36b5'),
    ],
    text: 'var(--mantine-color-text)',
    dim: 'var(--mantine-color-dimmed)',
  };
}

/** Escape text destined for innerHTML. Part names are user-controlled. */
export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[ch]);
}

/** Donut chart as inline SVG. `slices` = [{label, value, color}]. */
export function donut(slices, { size = 150, thickness = 26, centre = '' } = {}) {
  const total = slices.reduce((sum, s) => sum + (s.value || 0), 0);
  const r = (size - thickness) / 2;
  const cx = size / 2;
  const circumference = 2 * Math.PI * r;

  if (total <= 0) {
    return `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" aria-label="No data">
      <circle cx="${cx}" cy="${cx}" r="${r}" fill="none" stroke="var(--mantine-color-default-border)" stroke-width="${thickness}"/>
      <text x="${cx}" y="${cx}" text-anchor="middle" dominant-baseline="central"
            font-size="12" fill="var(--mantine-color-dimmed)">no data</text>
    </svg>`;
  }

  let offset = 0;
  const arcs = slices
    .filter((s) => s.value > 0)
    .map((s) => {
      const len = (s.value / total) * circumference;
      const seg = `<circle cx="${cx}" cy="${cx}" r="${r}" fill="none"
        stroke="${s.color}" stroke-width="${thickness}"
        stroke-dasharray="${len} ${circumference - len}"
        stroke-dashoffset="${-offset}"
        transform="rotate(-90 ${cx} ${cx})"><title>${esc(s.label)}: ${s.value}</title></circle>`;
      offset += len;
      return seg;
    })
    .join('');

  const middle = centre
    ? `<text x="${cx}" y="${cx}" text-anchor="middle" dominant-baseline="central"
             font-size="20" font-weight="600" fill="var(--mantine-color-text)">${esc(centre)}</text>`
    : '';

  return `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img">${arcs}${middle}</svg>`;
}

/** Legend rows beside a donut. */
export function legend(slices, { suffix = '' } = {}) {
  return slices
    .map(
      (s) => `<div style="display:flex;align-items:center;gap:.5rem;font-size:.8rem;line-height:1.5">
        <span style="flex:none;width:.65rem;height:.65rem;border-radius:2px;background:${s.color}"></span>
        <span style="flex:1;color:var(--mantine-color-text)">${esc(s.label)}</span>
        <span style="font-variant-numeric:tabular-nums;color:var(--mantine-color-dimmed)">${esc(s.display ?? s.value)}${suffix}</span>
      </div>`
    )
    .join('');
}

export function shell(target, inner) {
  target.innerHTML = `<div style="padding:.75rem 1rem;height:100%;box-sizing:border-box;overflow:auto">${inner}</div>`;
}

export function message(target, text, tone = 'dim') {
  const colour = tone === 'error' ? 'var(--mantine-color-red-6)' : 'var(--mantine-color-dimmed)';
  shell(target, `<div style="font-size:.85rem;color:${colour}">${esc(text)}</div>`);
}

/** Pull every page of a paginated InvenTree endpoint. */
export async function fetchAll(api, url, params = {}) {
  const out = [];
  let offset = 0;
  const limit = 500;
  for (let guard = 0; guard < 50; guard++) {
    const res = await api.get(url, { params: { ...params, limit, offset } });
    const data = res?.data;
    if (Array.isArray(data)) return data;
    const page = data?.results ?? [];
    out.push(...page);
    offset += page.length;
    if (!page.length || !data?.next || offset >= (data?.count ?? 0)) break;
  }
  return out;
}
