import "./styles.css";
import "@stll/folio-react/editor.css";

import { setSegmentFitEngine } from "@stll/folio-core/layout-engine/measure/segmentFit";
import { pretextSegmentFitEngine } from "@stll/premirror-bridge";
import { createRoot } from "react-dom/client";

import { App } from "./App";

// Route plain-text line fitting through the pretext SegmentFitEngine (E-1 seam +
// E-2 @stll/premirror-bridge). `?segmentfit=off` restores the legacy walk for
// A/B measurement (the E-0 perf harness drives both). Parity is frozen in the
// bridge's pretextParity suite; production default is on.
const segmentFitDisabled = new URLSearchParams(window.location.search).get("segmentfit") === "off";
if (!segmentFitDisabled) {
  setSegmentFitEngine(pretextSegmentFitEngine);
  globalThis.__folioFeatureFlags = {
    ...globalThis.__folioFeatureFlags,
    segmentFitLineBreaking: true,
  };
}

const container = document.querySelector("#app");
if (container) {
  const root = createRoot(container);
  root.render(<App />);
}
