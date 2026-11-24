import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { installPressFeedback, installTouchEffect } from "./motion";
import { applyFontSize, readFontSize } from "./font-size";
import { preventFocusZoom } from "./input-zoom";
import { installSfx } from "./sfx";
import "./fonts.css";
import "./styles.css";
import "./screens.css";

// Before the first render, so the chosen size never flashes.
applyFontSize(readFontSize());
// Typing in a field must not leave the page zoomed in (iOS).
preventFocusZoom();
installPressFeedback();
installTouchEffect();
installSfx();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

// The home-screen splash (index.html) stays at least ~0.9s, then fades out.
const splash = document.getElementById("splash");
if (splash) {
  const hide = () => {
    splash.classList.add("hide");
    setTimeout(() => splash.remove(), 400);
  };
  requestAnimationFrame(() => setTimeout(hide, Math.max(0, 900 - performance.now())));
}
