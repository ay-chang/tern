import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles/tokens.css";
import "./styles/app.css";

const render = () => ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<App />);

// In a plain browser during development, fake the Rust side so the UI can be worked on alone.
if (import.meta.env.DEV && !("__TAURI_INTERNALS__" in window)) {
  void import("./dev/mockBackend").then(render);
} else {
  render();
}
