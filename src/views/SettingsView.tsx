import type { ReactNode } from "react";
import { useStore } from "../lib/store";
import type { CursorStyle, Layout, ThemePref } from "../lib/types";
import { Seg, Stepper, Toggle } from "../components/ui";

function Row({ label, desc, children }: { label: string; desc: string; children: ReactNode }) {
  return (
    <div className="settings-row">
      <div>
        <div className="label">{label}</div>
        <div className="desc">{desc}</div>
      </div>
      <div style={{ display: "flex", alignItems: "center" }}>{children}</div>
    </div>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="settings-group">
      <div className="caps">{title}</div>
      <div className="settings-card">{children}</div>
    </div>
  );
}

export function SettingsView() {
  const prefs = useStore((s) => s.prefs);
  const set = useStore((s) => s.setPrefs);

  return (
    <div className="page" style={{ paddingBottom: 56 }}>
      <div className="settings">
        <div className="page-title">Settings</div>
        <Group title="Appearance">
          <Row label="Theme" desc="System follows your OS setting.">
            <Seg<ThemePref>
              value={prefs.theme}
              onChange={(theme) => set({ theme })}
              options={[
                { value: "dark", label: "Dark" },
                { value: "light", label: "Light" },
                { value: "system", label: "System" },
              ]}
            />
          </Row>
          <Row label="Layout" desc="Sidebar, icon rail with a host list, a single top bar, or terminal only.">
            <Seg<Layout>
              value={prefs.layout}
              onChange={(layout) => set({ layout })}
              options={[
                { value: "sidebar", label: "Sidebar" },
                { value: "rail", label: "Rail" },
                { value: "minimal", label: "Minimal" },
                { value: "focus", label: "Focus" },
              ]}
            />
          </Row>
        </Group>
        <Group title="Terminal">
          <Row label="Font size" desc="Geist Mono, ligatures off.">
            <Stepper
              text={`${prefs.fontSize}px`}
              onDec={() => set({ fontSize: Math.max(10, prefs.fontSize - 1) })}
              onInc={() => set({ fontSize: Math.min(22, prefs.fontSize + 1) })}
            />
          </Row>
          <Row label="Line height" desc="Space between lines. Higher is airier; lower fits more on screen.">
            <Stepper
              text={prefs.lineHeight.toFixed(2)}
              onDec={() => set({ lineHeight: Math.max(1, Math.round((prefs.lineHeight - 0.05) * 100) / 100) })}
              onInc={() => set({ lineHeight: Math.min(2, Math.round((prefs.lineHeight + 0.05) * 100) / 100) })}
            />
          </Row>
          <Row label="Cursor" desc="Shape of the caret in sessions.">
            <Seg<CursorStyle>
              value={prefs.cursor}
              onChange={(cursor) => set({ cursor })}
              options={[
                { value: "block", label: "Block" },
                { value: "bar", label: "Bar" },
                { value: "underline", label: "Underline" },
              ]}
            />
          </Row>
          <Row
            label="Highlight output"
            desc="Makes log levels (INFO, WARN, ERROR) and HTTP methods bold and colored, and dims timestamps, including in less and journalctl. The message text, output that sets its own colors, and apps like vim or htop are left alone."
          >
            <Toggle on={prefs.highlight} onChange={(highlight) => set({ highlight })} />
          </Row>
          <Row label="Scrollback" desc="Lines kept per session.">
            <Seg<string>
              value={String(prefs.scrollback)}
              onChange={(v) => set({ scrollback: Number(v) })}
              options={[
                { value: "1000", label: "1,000" },
                { value: "10000", label: "10,000" },
                { value: "50000", label: "50,000" },
              ]}
            />
          </Row>
        </Group>
        <Group title="About">
          <Row label="Tern 0.1.0" desc="Free and open source under the MIT license.">
            <span className="mono" style={{ fontSize: 12, color: "var(--mu)" }}>
              SSH · SFTP
            </span>
          </Row>
        </Group>
      </div>
    </div>
  );
}
