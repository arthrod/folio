import { setSegmentFitEngine } from "@stll/folio-core/layout-engine/measure/segmentFit";
import { pretextSegmentFitEngine } from "@stll/premirror-bridge";
import { createApp } from "vue";

import { i18nPlugin } from "@stll/folio-vue";
import "@stll/folio-vue/editor.css";

// Line-fit through the pretext SegmentFitEngine (E-1 seam + E-2 bridge),
// same as the React entry. `?segmentfit=off` restores the legacy walk.
const segmentFitDisabled = new URLSearchParams(window.location.search).get("segmentfit") === "off";
if (!segmentFitDisabled) {
  setSegmentFitEngine(pretextSegmentFitEngine);
  globalThis.__folioFeatureFlags = {
    ...globalThis.__folioFeatureFlags,
    segmentFitLineBreaking: true,
  };
}

import { FvueApp } from "./FvueApp";
import "../../styles.css";
import "../redline3.css";

const container = document.getElementById("root");
if (!container) {
  throw new Error("redline3-fvue: #root not found");
}
const app = createApp(FvueApp);
app.use(i18nPlugin, "en");
app.mount(container);
