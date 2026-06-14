import React from "react";
import ReactDOM from "react-dom/client";
import App from "@/App";
import { initStores } from "@/stores";
import "@/styles/globals.css";

const rootEl = document.getElementById("root");
if (!rootEl) {
  throw new Error("Root element #root was not found in index.html");
}

/**
 * Wire the client stores to the IPC event stream and load initial data once on
 * startup (task 17.1). `initStores` is safe to call outside Electron and returns
 * a teardown that detaches its subscriptions; we run it on window unload so the
 * single-window app cleans up listeners on shutdown/reload.
 */
const teardownStores = initStores();
window.addEventListener("beforeunload", teardownStores, { once: true });

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
