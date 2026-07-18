import { createApp } from "vue";

import { i18nPlugin } from "@stll/folio-vue";
import "@stll/folio-vue/editor.css";

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
