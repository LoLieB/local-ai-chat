import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";

function emitBootStage(stage: string) {
  window.dispatchEvent(new CustomEvent("local-ai-chat:boot-stage", { detail: stage }));
}

emitBootStage("main-module:loaded");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);

emitBootStage("react-render:submitted");
