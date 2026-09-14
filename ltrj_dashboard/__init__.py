"""Custom dashboard widgets for LTRJ Labs' InvenTree instance."""

from pathlib import Path

from plugin import InvenTreePlugin
from plugin.mixins import SettingsMixin, UserInterfaceMixin

try:  # keep the reported version tied to what pip actually installed
    from importlib.metadata import version as _pkg_version

    __version__ = _pkg_version("inventree-ltrj-dashboard")
except Exception:  # source checkout, or metadata unavailable
    __version__ = "0.4.0"

# Set once the widget assets have been confirmed in static storage, so the
# check below runs at most once per process rather than on every dashboard load.
_ASSETS_READY = False


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

    def _asset_report(self) -> dict:
        """Report whether the widget JS actually shipped with the package.

        The widgets are served from static storage, which is populated by a
        copy step InvenTree runs at install time. When that copy does not
        happen -- or the assets never made it into the built wheel -- every
        widget renders blank with no server-side error. This puts the answer
        somewhere readable (the dashboard feature API) instead of requiring a
        shell inside the container.
        """
        here = Path(__file__).resolve().parent
        static_dir = here / "static"
        try:
            files = sorted(f.name for f in static_dir.glob("*.js")) if static_dir.is_dir() else []
        except OSError as exc:
            return {"error": str(exc)}
        return {
            "staticDirExists": static_dir.is_dir(),
            "jsFiles": files,
        }

    def _ensure_assets_collected(self) -> None:
        """Make sure the widget JS has been copied into static storage.

        InvenTree copies plugin static files during installation, but that only
        happens on a path that can be skipped -- and when it is skipped the
        failure is silent: the plugin loads, registers its widgets, and every
        one of them renders blank because the JS 404s. Rather than depend on
        the installer having done it, verify and self-heal.
        """
        global _ASSETS_READY
        if _ASSETS_READY:
            return

        try:
            from django.conf import settings
            from django.contrib.staticfiles.storage import StaticFilesStorage

            storage = StaticFilesStorage()
            probe = f"plugins/{self.SLUG}/stock_status.js"
            self._copy_report = {"staticRoot": str(getattr(settings, "STATIC_ROOT", None)),
                                 "storageLocation": str(getattr(storage, "location", None)),
                                 "existedBefore": storage.exists(probe)}
            if storage.exists(probe):
                _ASSETS_READY = True
                return

            from plugin.staticfiles import copy_plugin_static_files

            copy_plugin_static_files(self.SLUG, check_reload=False)
            self._copy_report["existsAfter"] = storage.exists(probe)
            try:
                dirs, files = storage.listdir(f"plugins/{self.SLUG}")
                self._copy_report["listdir"] = sorted(files)
            except Exception as exc:
                self._copy_report["listdirError"] = str(exc)
            _ASSETS_READY = storage.exists(probe)
        except Exception as exc:
            self._copy_report = {"exception": f"{type(exc).__name__}: {exc}"}
            # Never let asset housekeeping break the dashboard API.
            from InvenTree.exceptions import log_error

            log_error("ensure_assets_collected", scope="plugins")

    def _asset(self, filename: str) -> str:
        """Static URL for a widget.

        A `?v=` cache-busting query was tried here and removed: it broke widget
        loading in the frontend, which resolves plugin sources through
        `new URL()` and a ':' split before importing them. Cache busting, if
        needed again, belongs in the filename -- InvenTree's plugin_static_file
        already prefers a hashed variant when one is shipped.
        """
        return self.plugin_static_file(filename)

    def get_ui_panels(self, request, context, **kwargs):
        """Add a cost breakdown panel to Part detail pages.

        `context` carries `target_model` / `target_id` for the page being
        viewed, so the panel is only offered where it means something. The
        frontend hands the panel the part itself (`ctx.instance`), so nothing
        needs passing through here to identify it.
        """
        self._ensure_assets_collected()

        if (context or {}).get("target_model") != "part":
            return []

        return [
            {
                "key": "ltrj-cost-breakdown",
                "title": "Cost Breakdown",
                "description": "BOM cost at any build quantity, with live supplier pricing.",
                "icon": "ti:currency-dollar:outline",
                "source": self._asset("cost_panel.js:renderCostPanel"),
            }
        ]

    def get_ui_dashboard_items(self, request, context, **kwargs):
        """Register this plugin's dashboard widgets."""
        self._ensure_assets_collected()
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
                "source": self._asset("stock_status.js"),
                "options": {"width": 4, "height": 4},
                "context": {"lowStockFallback": low_stock, "assets": self._asset_report()},  # noqa
            },
            {
                "key": "ltrj-assembly-cost",
                "title": "Assembly Unit Cost",
                "description": "Browse the BOM at any build quantity, priced at that volume.",
                "icon": "ti:currency-dollar:outline",
                "source": self._asset("assembly_cost.js"),
                "options": {"width": 5, "height": 4},
                "context": {"productPartId": product_id},
            },
            {
                "key": "ltrj-category-mix",
                "title": "Parts by Category",
                "description": "How the part catalogue is distributed across categories.",
                "icon": "ti:category:outline",
                "source": self._asset("category_mix.js"),
                "options": {"width": 4, "height": 4},
            },
        ]
