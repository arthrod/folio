import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { RedlineApp } from "./RedlineApp";
import "../styles.css";
import "./redline.css";

const container = document.getElementById("root");
if (!container) {
  throw new Error("redline: #root not found");
}
createRoot(container).render(
  <StrictMode>
    <RedlineApp />
  </StrictMode>,
);
