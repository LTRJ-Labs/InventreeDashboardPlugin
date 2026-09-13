"""Custom dashboard widgets for LTRJ Labs' InvenTree instance."""

from plugin import InvenTreePlugin
from plugin.mixins import SettingsMixin, UserInterfaceMixin

__version__ = "0.1.1"


class LTRJDashboardPlugin(SettingsMixin, UserInterfaceMixin, InvenTreePlugin):
    """Dashboard widgets: stock status, assembly unit cost, category mix."""

    NAME = "LTRJ Dashboard"
    SLUG = "ltrj-dashboard"
    TITLE = "LTRJ Labs Dashboard Widgets"
    DESCRIPTION = "Stock status, assembly unit cost breakdown, and category mix widgets."
    VERSION = __version__
    AUTHOR = "LTRJ Labs"

    SETTINGS = {
        "PRODUCT_PART_ID": {
            "name": "Product part",
            "description": (
                "Primary key of the assembly to cost in the unit-cost widget "
                "(e.g. the finished product)."
            ),
            "default": "",
            "validator": str,
        },
        "LOW_STOCK_FALLBACK": {
            "name": "Low stock threshold",
            "description": (
                "Treat a part as low stock when it has no minimum_stock set and "
                "holds fewer than this many units. Set 0 to disable."
            ),
            "default": "0",
            "validator": int,
        },
    }

    def get_ui_dashboard_items(self, request, context, **kwargs):
        """Register this plugin's dashboard widgets."""
        product_id = (self.get_setting("PRODUCT_PART_ID") or "").strip()
        try:
            low_stock = int(self.get_setting("LOW_STOCK_FALLBACK") or 0)
        except (TypeError, ValueError):
            low_stock = 0

        return [
            {
                "key": "ltrj-stock-status",
                "title": "Stock Status",
                "description": "Parts grouped by stock health.",
                "icon": "ti:chart-donut:outline",
                "source": self.plugin_static_file("stock_status.js"),
                "options": {"width": 4, "height": 4},
                "context": {"lowStockFallback": low_stock},
            },
            {
                "key": "ltrj-assembly-cost",
                "title": "Assembly Unit Cost",
                "description": "Unit cost of the product assembly, broken down by category.",
                "icon": "ti:currency-dollar:outline",
                "source": self.plugin_static_file("assembly_cost.js"),
                "options": {"width": 5, "height": 4},
                "context": {"productPartId": product_id},
            },
            {
                "key": "ltrj-category-mix",
                "title": "Parts by Category",
                "description": "How the part catalogue is distributed across categories.",
                "icon": "ti:category:outline",
                "source": self.plugin_static_file("category_mix.js"),
                "options": {"width": 4, "height": 4},
            },
        ]
