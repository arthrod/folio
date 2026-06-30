/**
 * Bun test preload: install the canvas MeasureProvider before any test runs.
 *
 * The layout engine measures through the pure provider seam, whose default
 * provider throws until a backend is installed. Tests exercise real layout via
 * `withFakeTextMeasure` (which swaps `globalThis.document`, still read by the
 * canvas backend), so the canvas provider must be active. Wired through each
 * package's `bunfig.toml` [test] preload, so it covers every layout/measure
 * spec in both @stll/folio-core and @stll/folio-react.
 */

import { installCanvasMeasureProvider } from "../packages/core/src/layout-engine/measure/measureContainer";

installCanvasMeasureProvider();
