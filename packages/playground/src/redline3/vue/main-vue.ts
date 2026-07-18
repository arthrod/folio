import { createApp } from "vue";

import { VueRedline3App } from "./VueRedline3App";
import "../../styles.css";
import "../redline3.css";

const container = document.getElementById("root");
if (!container) {
  throw new Error("redline3-vue: #root not found");
}
createApp(VueRedline3App).mount(container);
