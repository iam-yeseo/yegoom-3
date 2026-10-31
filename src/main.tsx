import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { installPressFeedback } from "./motion";
import "./fonts.css";
import "./styles.css";
import "./screens.css";

installPressFeedback();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
