import { setSegmentFitEngine } from "@stll/folio-core/layout-engine/measure/segmentFit";
import { pretextSegmentFitEngine } from "@stll/premirror-bridge";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { RedlineApp } from "./RedlineApp";
import "../styles.css";
import "./redline.css";

// Route plain-text line fitting through @chenglou/pretext's prepare-once,
// fit-by-arithmetic engine (premirror port: folio-core E-1 seam + the E-2
// @stll/premirror-bridge). Parity with the legacy word-walk is frozen in the
// bridge's pretextParity suite; installing the engine + turning the flag on
// makes the seam live. Append `?segmentfit=off` to A/B against the legacy walk
// (used by the E-0 perf baseline and dogfooding).
const segmentFitDisabled = new URLSearchParams(window.location.search).get("segmentfit") === "off";
if (!segmentFitDisabled) {
  setSegmentFitEngine(pretextSegmentFitEngine);
  globalThis.__folioFeatureFlags = {
    ...globalThis.__folioFeatureFlags,
    segmentFitLineBreaking: true,
  };
}

const container = document.getElementById("root");
if (!container) {
  throw new Error("redline: #root not found");
}
createRoot(container).render(
  <StrictMode>
    <RedlineApp />
  </StrictMode>,
);
