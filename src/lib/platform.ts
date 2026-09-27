export const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** Label for the primary shortcut modifier, e.g. "⌘K" on macOS and "Ctrl+Shift+K" elsewhere. */
export function shortcut(key: string): string {
  return isMac ? `⌘${key}` : `Ctrl+Shift+${key}`;
}

export const credentialStoreName = isMac
  ? "macOS Keychain"
  : navigator.userAgent.includes("Windows")
    ? "Windows Credential Manager"
    : "the system keyring";
