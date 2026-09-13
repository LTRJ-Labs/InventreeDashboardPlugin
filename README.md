# inventree-ltrj-dashboard

Custom dashboard widgets for LTRJ Labs' InvenTree instance.

| Widget | Shows |
| :--- | :--- |
| **Stock Status** | Parts grouped into in-stock / below-minimum / out-of-stock |
| **Assembly Unit Cost** | Unit cost of the product assembly, broken down by category, with zero-priced lines called out |
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

Then activate the plugin, and add the widgets from the dashboard's
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

## Development

Static assets live at `ltrj_dashboard/static/plugins/ltrj-dashboard/`, which is
where `plugin_static_file()` resolves to (`static/plugins/<slug>/<file>`).
`renderDashboardItem(target, context)` receives the DOM node and the
`InvenTreePluginContext` — `context.api` is an authenticated Axios instance,
`context.theme` the Mantine theme, and `context.context` the per-widget data
passed from `get_ui_dashboard_items()`.
