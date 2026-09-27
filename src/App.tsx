import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";
import { Chrome } from "./components/Chrome";
import { Dialogs } from "./components/Dialogs";
import { Palette } from "./components/Palette";
import { isMac } from "./lib/platform";
import { onTransferEvent } from "./lib/sftp";
import { useStore } from "./lib/store";
import { applyPrefs, closeSession, focus } from "./lib/terminals";
import { onSystemThemeChange, resolveTheme } from "./lib/theme";
import type { TransferEvent } from "./lib/types";
import { HostsView } from "./views/HostsView";
import { KeychainView } from "./views/KeychainView";
import { SettingsView } from "./views/SettingsView";
import { SftpView } from "./views/SftpView";
import { TerminalView } from "./views/TerminalView";

const PROBE_INTERVAL_MS = 60_000;

function runAction(action: string) {
  const s = useStore.getState();
  switch (action) {
    case "palette":
      useStore.setState({ paletteOpen: !s.paletteOpen });
      break;
    case "new-connection":
      useStore.setState({ paletteOpen: true });
      break;
    case "new-host":
      useStore.setState({ view: "hosts", editor: { hostId: null }, selectedHostId: null, paletteOpen: false });
      break;
    case "close-tab":
      if (s.view === "term" && s.activeId) closeSession(s.activeId);
      break;
    case "toggle-sidebar":
      useStore.setState({ sidebarHidden: !s.sidebarHidden });
      break;
    case "settings":
      s.setView("settings");
      break;
  }
}

/** On macOS these come from menu accelerators; elsewhere they're Ctrl+Shift chords. */
const CHORDS: Record<string, string> = {
  k: "palette",
  t: "new-connection",
  n: "new-host",
  w: "close-tab",
  b: "toggle-sidebar",
};

function useThemeAttr() {
  const pref = useStore((s) => s.prefs.theme);
  const [, bump] = useState(0);
  useEffect(() => onSystemThemeChange(() => bump((n) => n + 1)), []);
  const theme = resolveTheme(pref);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    applyPrefs();
  }, [theme]);
}

export default function App() {
  const view = useStore((s) => s.view);
  const layout = useStore((s) => s.prefs.layout);
  const paletteOpen = useStore((s) => s.paletteOpen);
  const hasActive = useStore((s) => s.sessions.some((x) => x.id === s.activeId));
  const fontSize = useStore((s) => s.prefs.fontSize);
  const cursor = useStore((s) => s.prefs.cursor);
  const scrollback = useStore((s) => s.prefs.scrollback);
  const highlight = useStore((s) => s.prefs.highlight);
  const lineHeight = useStore((s) => s.prefs.lineHeight);
  useThemeAttr();

  useEffect(() => applyPrefs(), [fontSize, cursor, scrollback, highlight, lineHeight]);

  // Give the keyboard back to the terminal once an overlay closes.
  const overlayOpen = useStore((s) => s.paletteOpen || s.prompts.length > 0 || s.textPrompt !== null);
  useEffect(() => {
    const { view, activeId } = useStore.getState();
    if (!overlayOpen && view === "term" && activeId) focus(activeId);
  }, [overlayOpen]);

  useEffect(() => {
    const { refreshHosts, probe } = useStore.getState();
    void refreshHosts().then(probe);
    const timer = window.setInterval(() => void useStore.getState().probe(), PROBE_INTERVAL_MS);
    const unlisteners = [
      listen("hosts-changed", () => void useStore.getState().refreshHosts()),
      listen<TransferEvent>("transfer", (e) => onTransferEvent(e.payload)),
      listen<string>("menu", (e) => runAction(e.payload)),
    ];
    return () => {
      window.clearInterval(timer);
      unlisteners.forEach((u) => void u.then((f) => f()));
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = isMac ? e.metaKey : e.ctrlKey;
      if (mod && !e.shiftKey && !e.altKey && /^[1-9]$/.test(e.key)) {
        const { sessions } = useStore.getState();
        const target = e.key === "9" ? sessions[sessions.length - 1] : sessions[Number(e.key) - 1];
        if (target) {
          e.preventDefault();
          useStore.setState({ activeId: target.id, view: "term" });
        }
        return;
      }
      if (!isMac && e.ctrlKey && e.shiftKey && CHORDS[e.key.toLowerCase()]) {
        e.preventDefault();
        runAction(CHORDS[e.key.toLowerCase()]);
      }
      if (!isMac && e.ctrlKey && e.key === ",") {
        e.preventDefault();
        runAction("settings");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const shown = view === "term" && !hasActive ? "hosts" : view;

  return (
    <div className={`app ${isMac ? "mac" : ""}`}>
      <Chrome />
      <main className="main">
        <Chrome.Top />
        <div className={`content ${layout === "focus" ? "focus" : ""}`}>
          <TerminalView visible={shown === "term"} />
          {shown === "hosts" && <HostsView />}
          {shown === "sftp" && <SftpView />}
          {shown === "keys" && <KeychainView />}
          {shown === "settings" && <SettingsView />}
        </div>
      </main>
      {paletteOpen && <Palette />}
      <Dialogs />
    </div>
  );
}
