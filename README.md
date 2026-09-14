# inventree-ltrj-dashboard

Custom dashboard widgets for LTRJ Labs' InvenTree instance.

### Cost Breakdown panel

A **Cost Breakdown** tab on every Part detail page. Enter any build quantity and
the whole BOM reprices at that volume: unit cost and total up top, then a table
that drills into sub-assemblies to eight levels, showing per-line unit price,
cost per build unit, extended cost, and stock coverage against what the build
needs. Part names open the preview drawer, so you can explore without losing
your place. Pricing refreshes on its own every five minutes.

Lines with no supplier pricing are called out above the table rather than
quietly contributing zero, and a sub-assembly is only reported as priced when
everything beneath it is.

### Dashboard widgets

| Widget | Shows |
| :--- | :--- |
| **Stock Status** | Parts grouped into in-stock / below-minimum / out-of-stock |
| **Assembly Unit Cost** | The panel's smaller ancestor — a quantity input and a BOM tree in a dashboard tile |
| **Parts by Category** | How the catalogue is distributed across categories |

Widgets are dependency-free ES modules using the plugin context's authenticated
API client, and take their colours from the active Mantine theme, so they read
correctly in both light and dark mode.

## Requirements

* InvenTree 1.x (tested against 1.5.0, API v530)
* **Enable interface integration** must be ON — InvenTree → Settings → Plugin Settings
* Installation requires a **superuser** account

## Installation

From InvenTree → Admin Center → Plugins → Install Plugin:

```
git+https://github.com/LTRJ-Labs/InventreeDashboardPlugin.git
```

Then activate the plugin. The **Cost Breakdown** panel appears on Part detail
pages automatically; dashboard widgets must be added from the dashboard's
**Add Widget** drawer.

## Settings

| Setting | Purpose |
| :--- | :--- |
| `PRODUCT_PART_ID` | Primary key of the assembly to cost. Leave blank to auto-pick the assembly with the most BOM lines. |
| `LOW_STOCK_FALLBACK` | Treat parts with no `minimum_stock` as low below this quantity. `0` disables. |

## Notes

**Stock Status is only as good as your reorder points.** With no `minimum_stock`
set on any part, "below minimum" is always empty — set minimums, or set the
fallback threshold, to make the widget answer "what should I reorder?" rather
than just "do I have any?".

**Zero-priced BOM lines are surfaced deliberately.** A part with no supplier
pricing contributes nothing to the rollup, which silently understates unit
cost. The cost widget names those lines instead of hiding them in the total.

**Tier selection never extrapolates.** The best price break at or below the
required quantity wins, and below the smallest break the smallest price is used
unchanged -- a part quoted once at 5 off costs the same per unit at 1, 6 or 500.
This matches how Inventree_SupplierSync computes its ladders, so the widget and
the sync always agree.

## Cache busting

Browsers cache ES modules hard enough that a hard reload can keep serving the
previous widget after an upgrade. A `?v=` query on the source URL was tried and
**broke widget loading entirely** -- the frontend resolves plugin sources
through `new URL()` and a ':' split before importing, and does not survive a
query string. If cache busting is needed, put the hash in the filename:
`plugin_static_file()` already prefers a hashed variant when one is shipped.

Until then, after upgrading use DevTools -> right-click reload -> *Empty Cache
and Hard Reload*.

## Development

Static assets live **flat** in `ltrj_dashboard/static/`.

This matters and is easy to get wrong. For a pip-installed plugin, InvenTree
copies everything under `<package>/static/` into `STATIC_ROOT/plugins/<slug>/`,
preserving relative paths. Nesting the files as `static/plugins/<slug>/*.js` --
which is how InvenTree's own *builtin* sample plugins are laid out, since those
are collected by Django's app-directory finder instead -- produces
`plugins/<slug>/plugins/<slug>/*.js` and every widget silently 404s.
`renderDashboardItem(target, context)` receives the DOM node and the
`InvenTreePluginContext` — `context.api` is an authenticated Axios instance,
`context.theme` the Mantine theme, and `context.context` the per-widget data
passed from `get_ui_dashboard_items()`.
