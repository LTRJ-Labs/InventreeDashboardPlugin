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

**JavaScript** — plain ES module, `export function renderDashboardItem(target, ctx)`.
`target` is the DOM node. `ctx` is the `InvenTreePluginContext`:

| Key | Use |
| :--- | :--- |
| `ctx.api` | **authenticated Axios instance** — the way to query the API |
| `ctx.theme` | Mantine theme; take colours from here for light/dark |
| `ctx.context` | the per-widget `context` dict from the Python side |
| `ctx.user`, `ctx.navigate`, `ctx.forms`, `ctx.globalSettings` | also available |

React and Mantine are exposed globally, but these widgets use plain DOM
deliberately — small enough to stay legible, and no coupling to a React version.

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

## Instance data state (2026-09-12)

Shapes what the widgets can meaningfully show:

- **70 parts, 8 categories, well organised** — Parts by Category has real data.
- **Zero stock items, zero locations, zero POs, zero build orders.** Stock
  Status renders one slice ("Out of stock: 70") until the first goods receipt.
- **No `minimum_stock` set on any part**, so "below minimum" is always empty.
  Setting reorder points is what turns that widget from "do I have any" into
  "what should I reorder"; `LOW_STOCK_FALLBACK` is a stopgap.
- **Mothnode (pk 6)** is the product assembly; **pk 5** is the PCBA with 59
  lines. BOM cost ~4.70 CAD, understated — the enclosure (pk 3) and screws
  (pk 4) have no supplier pricing, and no JLCPCB fab/assembly line exists yet.
  The cost widget names zero-priced lines deliberately for this reason.

## Open threads

- **Price history graph + week-over-week trend arrow** (requested). InvenTree
  stores no price history — `PartPricing` holds one current value. Recording a
  series is required first; `/api/part/stocktake/` is writable and carries
  `cost_min`/`cost_max`, or the plugin could own a table via `AppMixin`.
  Undecided. Either way the chart is empty until data accrues, and the weekly
  arrow needs ~7 days.
- **Cleanup**: `STATIC_ROOT/plugins/ltrj-dashboard/plugins/` is orphaned junk
  from the old nested layout. Safe to delete.
- The distribution name (`inventree-ltrj-dashboard`) does not match the repo
  name, which has already caused one install failure. Worth aligning.
