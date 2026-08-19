import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./app";
import { applyInitialTheme } from "./shared/hooks/use-theme";
import "./styles/index.css";

// 挂载前同步应用主题, 避免首帧闪烁 (FOUC)。
applyInitialTheme();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
