# InventreeDashboardPlugin — working notes

Context for future sessions. Verified facts only; anything unconfirmed is marked.

## What this is

Custom dashboard widgets for a self-hosted InvenTree 1.5.0 instance:
Stock Status, Assembly Unit Cost, and Parts by Category. Pip-installable
plugin, distributed from this public repo.

Companion project: **Inventree_SupplierSync**, which keeps the underlying
supplier pricing current. The cost widget is only as good as that data.

## ⚠️ The layout rule that will bite you

Widget JS lives **flat in `ltrj_dashboard/static/`**. Do not nest it.

For a **pip-installed** plugin, InvenTree copies everything under
`<package>/static/` into `STATIC_ROOT/plugins/<slug>/`, **preserving relative
paths**. Laying the files out as `static/plugins/<slug>/*.js` — which is how
InvenTree's own **builtin sample** plugins are structured, because those go
through Django's app-directory finder instead, which adds no prefix — produces:

```
plugins/ltrj-dashboard/plugins/ltrj-dashboard/stock_status.js
```

while everything looks for `plugins/ltrj-dashboard/stock_status.js`.

This cost five versions to find. It fails with **no exception, no error log**:
the plugin loads, registers all its widgets, InvenTree generates correct-looking
URLs, and every widget renders blank. The only visible symptom is
`Static file not found for plugin` from `plugin_static_file()`'s existence check.

## Plugin contract (verified against InvenTree source, 1.5.0)

**Python** — `UserInterfaceMixin.get_ui_dashboard_items(self, request, context, **kwargs)`
returns a list of dicts: `key`, `title`, `source` (required); `description`,
`icon`, `options` (`width`/`height`), `context` (optional). Build `source` with
`self.plugin_static_file('file.js')`, optionally `'file.js:functionName'`.

**Panels** — `UserInterfaceMixin.get_ui_panels(self, request, context, **kwargs)`,
same dict shape minus `options.width/height` (`CustomPanelOptions` carries only
`icon`; panels are full-width tabs). `context` carries **`target_model`** and
**`target_id`** for the page being viewed, so filter on
`context.get('target_model') == 'part'`. The frontend passes the panel its own
part, so nothing needs threading through the Python `context` to identify it.

**JavaScript** — plain ES module. Dashboard items export
`renderDashboardItem(target, ctx)`; panels export `renderPanel(target, ctx)`, or
any name addressed as `'file.js:funcName'`. `target` is the DOM node. `ctx` is
the `InvenTreePluginContext` (`src/frontend/lib/types/Plugins.tsx`), which is far
richer than the four keys this file used to list:

| Key | Use |
| :--- | :--- |
| `ctx.api` | **authenticated Axios instance** — the way to query the API |
| `ctx.queryClient` | **TanStack QueryClient** — `fetchQuery` with a `staleTime` for cached reads, `invalidateQueries` to force a refresh. Better than hand-rolled Maps. |
| `ctx.model`, `ctx.id`, `ctx.instance` | panels only: the model type, pk, and the **already-fetched instance** — a Part panel needs no lookup |
| `ctx.theme`, `ctx.colorScheme` | Mantine theme; take colours from here for light/dark |
| `ctx.tables.renderTable` | renders InvenTree's own data table (sorting, filtering, paging). Lazy-loaded, so it costs nothing unless used. |
| `ctx.preview.open(model, id)` | global preview drawer — drill down without leaving the page |
| `ctx.forms` | InvenTree's API form modals, incl. `forms.stockActions` |
| `ctx.reloadInstance`, `ctx.reloadContent` | refresh the instance / re-render the panel after a write |
| `ctx.version` | `{inventree, react, reactDom, mantine}` — check before touching the React globals |
| `ctx.context` | the per-feature `context` dict from the Python side |
| `ctx.user`, `ctx.navigate`, `ctx.i18n`, `ctx.globalSettings`, `ctx.thumbnail`, `ctx.renderInstance`, `ctx.importer` | also available |

React and Mantine are exposed globally, but these widgets and the panel use
plain DOM deliberately — legible at this size, and no coupling to a React
version. `ctx.version` is there if that call is ever revisited.

## ⚠️ Navigation items do not work in 1.5.0

`get_ui_navigation_items` exists on the mixin and the builtin sample plugin
returns one, but the frontend never renders it —
`src/frontend/src/components/nav/NavigationDrawer.tsx`:

```js
// TODO @matmair #1: implement plugin loading and menu item generation see #5269
const plugins: MenuLinkItem[] = [];
```

So there is **no way to add a custom page or route** from a plugin on this
version. Even once implemented, nav items carry only `options.url` and no
`source`, so they are links, not rendered pages. **Panels are the ceiling** —
do not plan around a full-page plugin view.

## Requirements

- `ENABLE_PLUGINS_INTERFACE` must be **on** (Settings → Plugin Settings →
  "Enable interface integration"). Without it the plugin installs and activates
  but contributes nothing, which looks like a broken plugin.
- Installing requires a **superuser**. On this instance that is `admin`;
  `puritch` and `bjornson` are staff but not superuser.
- The repo must be **public**, or pip inside the container cannot clone it
  (no credentials there; a token in the URL would be stored in InvenTree's DB
  in plaintext).

## Install / upgrade

```
Package name: inventree-ltrj-dashboard      ← the distribution name, not the repo name
URL:          git+https://github.com/LTRJ-Labs/InventreeDashboardPlugin.git
```

**Always bump the version in `pyproject.toml` and `__init__.py` when changing
anything.** With an unchanged version pip reports "already satisfied" and skips,
so the reinstall silently does nothing and you debug a stale build.

After installing, activate the plugin, then add widgets from the dashboard's
**Add Widget** drawer. They never appear automatically.

## Debugging when a widget is blank

Check in this order:

1. `GET /api/plugins/ui/features/dashboard/` — are the items registered, and
   what `source` URL does InvenTree generate?
2. Fetch that URL directly. A 404 means the static copy is the problem.
3. Look at `STATIC_ROOT/plugins/` **on disk** — this is what finally solved it.
   The path being wrong is far more likely than the copy failing.

**INFO logging is suppressed** in this deployment, so the copy's own
`Collecting static files…` / `Copied N static files…` messages are invisible.
A lease failure *would* show, since that logs at ERROR.

`/api/error-report/` surfaces exceptions InvenTree caught. Note that silently
skipped code paths leave nothing there.

Diagnostic that gives full visibility (needs shell on the Docker host):

```bash
docker exec -i $(docker ps --format '{{.Names}}' | grep -m1 inventree-server) \
  sh -c 'cd "$(dirname "$(find / -name manage.py -path "*InvenTree*" | head -1)")" && python3 manage.py shell' <<'PY'
from django.conf import settings
from django.contrib.staticfiles.storage import staticfiles_storage
from plugin.staticfiles import copy_plugin_static_files
from pathlib import Path
copy_plugin_static_files("ltrj-dashboard", check_reload=False)
print(staticfiles_storage.exists("plugins/ltrj-dashboard/stock_status.js"))
print([str(p) for p in (Path(settings.STATIC_ROOT)/"plugins").rglob("*")])
PY
```

`manage.py collectplugins` is the supported way to force collection.

## Frontend gotchas that cost real time

**`/api/bom/` carries no category data.** `sub_part_detail` is `null` by
default, and even with `sub_part_detail=true` the expanded object has `pk`,
`name`, `description` and `pricing_min/max` but **no category field**. Every
tree row rendered as "Uncategorised" until the widget started resolving names
and categories from `/api/part/` instead, fetched once and cached.

**Do not put a query string on a widget `source` -- it can never work.**
`usePluginSource` (`hooks/UseRemotePlugin.tsx`) builds the module URL as
`url.origin + parts[0]`, where `parts` is `url.pathname.split(':')`. The search
string is **discarded by construction**, and the ':' split runs over the
pathname, so a `?v=` buster is dropped at best and corrupts the parse at worst.
Reverted in 0.3.3. Hash the filename instead -- see below.

**Cache busting is solved, via hashed filenames (0.6.0).** `build_assets.py`
emits content-hashed copies of every module plus a Vite-style
`static/.vite/manifest.json`. `plugin_static_file()` calls `hashed_file_lookup()`,
which reads that manifest and serves `cost_panel-f2812dcf.js` in place of
`cost_panel.js`. New release -> new filename -> new URL, so neither the browser
nor Cloudflare can serve a stale module.

**Run `python3 build_assets.py` before committing a release.** It is not
automatic. Forgetting it ships the old hashes, and the manifest keeps pointing
at the previous build -- the same stale-code symptom the hashing exists to
prevent, just with extra steps. The script rewrites intra-plugin imports
(`./_chart.js` -> `./_chart-<hash>.js`) in dependency order, so the hashes chain
correctly; editing `_chart.js` changes every module's hash, which is correct.

Packaging must carry both: `package-data` and `MANIFEST.in` include
`static/*.js` **and** `static/.vite/manifest.json`.

## The real development loop

Reinstall-per-change is not how this is meant to be developed. InvenTree has a
first-class plugin dev mode, in `plugin_static_file()`:

```python
if settings.DEBUG and settings.PLUGIN_DEV_HOST and settings.PLUGIN_DEV_SLUG \
        and self.SLUG == settings.PLUGIN_DEV_SLUG:
    url = f'{settings.PLUGIN_DEV_HOST}/src/{pathname}'
    url = url.replace('.js', '.tsx')
```

Set `PLUGIN_DEV_SLUG=ltrj-dashboard` and `PLUGIN_DEV_HOST` to a local Vite dev
server and the frontend loads modules straight from it -- edit, save, see it.
`lib/plugin/InventreeHmrPlugin.tsx` injects an `import.meta.hot` block that
calls `window.__plugin_hmr_callbacks`, so it is true hot reload, not a refresh.

**Caveats, both real:** it requires `settings.DEBUG`, which should not be on for
this instance, and the dev path rewrites `.js` to `.tsx`, so it expects the
plugin-creator's TypeScript layout rather than plain `.js` modules. Using it
means either a throwaway local InvenTree or adopting that layout. Worth it if
frontend iteration continues; the hashed filenames are the fix that works
without touching the server.

**Browsers cache widget modules hard.** After an upgrade, a plain reload -- and
often `Ctrl+Shift+R` -- keeps serving the previous file, which looks exactly
like the plugin not having updated. Use DevTools -> right-click reload ->
*Empty Cache and Hard Reload*. Static responses carry `max-age=14400`, so a
stale copy can persist for four hours.

**The install form times out but the install succeeds.** InvenTree runs `pip
install` synchronously inside the HTTP request; the proxy gives up before pip
finishes cloning and building. Verify by version in Admin Center -> Plugins
rather than by re-running the install.

**Version reporting.** `__version__` reads from package metadata, so it matches
what pip installed. Before that fix, `pyproject.toml` and `__init__.py` carried
independent strings and drifted -- the package installed as 0.1.5 while the
plugin reported 0.1.3, which removed the only reliable signal of which code was
running during a long debugging session.

## Instance data state (2026-09-14)

- **73 parts, 8 categories.** Zero stock items, locations, POs, build orders.
- **No `minimum_stock` on any part**, so "below minimum" is always empty.
- **Mothnode (pk 6)** is the product; **pk 5** the PCBA. MothNode's BOM was
  three lines (PCBA, enclosure, screws) and the sensors were attached to
  nothing, so the ~4.70 CAD figure recorded here previously was the PCBA alone.
  With the sensors on the BOM the default configuration is **~125 CAD/unit at
  qty 1**, ~82 at qty 100.
- **Unpriced, and the reason the panel reports the total as a floor:**
  `ESP32-S3-WROOM-1-N8R8` (pk 1, no supplier part) and `BG95mPCIE Module`
  (pk 74, DigiKey supplier part but zero price breaks).
- **BG95 contributing zero makes "Cellular + LoRa" cost exactly the same as
  "LoRa"** in the panel. That is the missing price showing through, not a bug
  in the configuration filter.
- **pk 72** (JLCPCB Turnkey, dead after the fab-as-a-BOM-line change) deleted.
- **pk 65 merged into pk 3**: two enclosure records existed, pk 3 held the
  supplier pricing and pk 65 the correct name. pk 3 survives, renamed
  `Enclosure380x175x45`; pk 65 deleted. **InvenTree refuses to delete an active
  part** -- PATCH `active: false` first, or the DELETE returns 400.
- **`/api/bom/?sub_part=<pk>` is not a supported filter** and silently returns
  the unfiltered list. Filter BOM lines client-side; a safety check built on
  that query will read as "still referenced" for every part.

## Product configurations

Defined by the **`CONFIG_GROUPS`** plugin setting (JSON), so variants change
without shipping JS. Each group renders as a dropdown in the panel; a part named
by any group counts only while its option is selected, and a part in no group
always counts.

| Group | Options | Parts |
| :--- | :--- | :--- |
| Connectivity | Cellular *(default)* / LoRa / Cellular + LoRa | BG95 (74) / LR62E (63) / both |
| Sensing | Ultrasonic *(default)* / Hydrostatic | DYP-A02 (71) / HydrostaticPressureSensor (70) |

Both radios sit on the **mainboard's** BOM (pk 5), not MothNode's, so the filter
has to apply at every depth of the walk rather than only to top-level lines.

## Features (0.6.0)

| Feature | Where | State |
| :--- | :--- | :--- |
| **Cost Breakdown** | **Part page panel** | The main surface. Quantity input + presets, configuration dropdowns, full-width BOM table drilling to 8 levels, per-line unit price / per-build-unit / extended cost, stock coverage chips, category cost bar, make-vs-buy on priced sub-assemblies, click-through via the preview drawer. Repolls every 5 min and self-cancels when detached. |
| Stock Status | Dashboard | Working. One slice until stock exists; explains why in-widget. |
| Assembly Unit Cost | Dashboard | The panel's cramped ancestor. Still works; the panel supersedes it. |
| Parts by Category | Dashboard | Working. Largest 7 categories, tail rolled into "Other". |

**The panel is the answer to "the tree does not fit".** A dashboard item is a
5×4 grid tile with `overflow:auto`; a recursive BOM tree was always going to
lose that fight. `get_ui_panels` gives it the full page width.

Tier selection in the cost widget mirrors `Inventree_SupplierSync`'s
`tier_price()` exactly — best break at or below the required quantity, and
below the smallest break the smallest price unchanged — so the widget and the
sync cannot disagree.

Quantity and tree-expansion state persist per viewer in `localStorage`.

## Open threads

- **`PRODUCT_PART_ID` should be set to 6**, the full MothNode product. Blank
  auto-picks the assembly with the most BOM lines, which is part 5 (the PCBA).
- **Hashed asset filenames** would end the cache problem properly; needs a
  small build step at packaging time. Do not reach for a query string again.
- **Price history graph + week-over-week trend arrow** (requested, unbuilt). InvenTree
  stores no price history — `PartPricing` holds one current value. Recording a
  series is required first; `/api/part/stocktake/` is writable and carries
  `cost_min`/`cost_max`, or the plugin could own a table via `AppMixin`.
  Undecided. Either way the chart is empty until data accrues, and the weekly
  arrow needs ~7 days.
- **Cleanup**: `STATIC_ROOT/plugins/ltrj-dashboard/plugins/` is orphaned junk
  from the old nested layout. Safe to delete.
- **The dashboard cost widget is now redundant** with the panel. Keep or drop,
  but do not evolve both — the costing logic is duplicated across
  `assembly_cost.js` and `cost_panel.js` and will drift.
- The distribution name (`inventree-ltrj-dashboard`) does not match the repo
  name, which has already caused one install failure. Worth aligning.

## Fixed in 0.4.0

- **`priced` never propagated.** `costOf` returned `priced: true` for any part
  with BOM children regardless of whether those children priced, so a
  sub-assembly of entirely unpriced parts reported a confident cost of zero with
  no ⚠ anywhere up the tree — exactly the silent understatement the widget
  exists to prevent. Now `priced` is the AND of its children.
- **Currency was read off the wrong row.** `toBase()` used
  `rows[0].price_currency` rather than the currency of the break `tierPrice()`
  actually selected. Wrong conversion whenever one supplier part quotes in two
  currencies, silent when it happens. `tierPrice()` now returns
  `{price, currency}`.
- **The asset diagnostic was probing the path that was removed.**
  `_asset_report()` checked `static/plugins/<slug>/` — the nested layout fixed
  in 0.1.x — so `staticDirExists` was permanently `False` and `jsFiles`
  permanently `[]`. The one diagnostic built to answer "did the JS ship?" was
  answering "no" unconditionally. Now probes `static/`.
- **Absolute container paths** were being returned to every dashboard user in
  the widget `context`. Dropped.
