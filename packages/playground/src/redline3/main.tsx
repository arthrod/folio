import { setSegmentFitEngine } from "@stll/folio-core/layout-engine/measure/segmentFit";
import { pretextSegmentFitEngine } from "@stll/premirror-bridge";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { Redline3App } from "./Redline3App";
import "../styles.css";
import "./redline3.css";

// Line-fit the rendered redline through the pretext SegmentFitEngine (E-1 seam
// + E-2 bridge). `?segmentfit=off` restores the legacy walk for A/B.
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
  throw new Error("redline3: #root not found");
}
createRoot(container).render(
  <StrictMode>
    <Redline3App />
  </StrictMode>,
);
