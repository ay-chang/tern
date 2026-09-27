import type { ITheme } from "@xterm/xterm";
import type { ThemePref } from "./types";

// xterm needs sRGB colors, so the design's OKLCH accents are pre-converted here.
export const XTERM_THEMES: Record<"dark" | "light", ITheme> = {
  dark: {
    background: "#131416",
    // A step down from the UI's text color: long runs of log output read easier slightly gray.
    foreground: "#c4c1bb",
    cursor: "#68d7a1",
    cursorAccent: "#131416",
    selectionBackground: "rgba(104, 215, 161, 0.25)",
    black: "#2a2b2f",
    red: "#f07f77",
    green: "#68d7a1",
    yellow: "#edbb64",
    blue: "#7fc5ff",
    magenta: "#cda4ec",
    cyan: "#64d1d7",
    white: "#c9c7c2",
    brightBlack: "#6b6965",
    brightRed: "#fb9890",
    brightGreen: "#85e9b6",
    brightYellow: "#fad18a",
    brightBlue: "#9fd8ff",
    brightMagenta: "#ddbbf7",
    brightCyan: "#90e1e6",
    brightWhite: "#f4f2ee",
  },
  light: {
    background: "#fcfbf9",
    foreground: "#1c1b19",
    cursor: "#007d50",
    cursorAccent: "#fcfbf9",
    selectionBackground: "rgba(0, 125, 80, 0.18)",
    black: "#1c1b19",
    red: "#bd413f",
    green: "#007d50",
    yellow: "#ae6700",
    blue: "#1f6cb0",
    magenta: "#814ea4",
    cyan: "#008388",
    white: "#8b8985",
    brightBlack: "#6b6965",
    brightRed: "#a82d2e",
    brightGreen: "#006b40",
    brightYellow: "#9a5500",
    brightBlue: "#005a9d",
    brightMagenta: "#703c91",
    brightCyan: "#007177",
    brightWhite: "#b8b6b1",
  },
};

const media = window.matchMedia("(prefers-color-scheme: light)");

export function resolveTheme(pref: ThemePref): "dark" | "light" {
  if (pref === "system") return media.matches ? "light" : "dark";
  return pref;
}

export function onSystemThemeChange(cb: () => void): () => void {
  media.addEventListener("change", cb);
  return () => media.removeEventListener("change", cb);
}
