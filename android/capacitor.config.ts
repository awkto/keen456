import type { CapacitorConfig } from "@capacitor/cli";

// Phase 1: a direct WebView port of the web app. The static site is bundled into
// www/ (see build-www.sh) and runs from the https://localhost Capacitor scheme;
// js-dos itself still loads from the CDN (see GitLab issue #2 for offline).
const config: CapacitorConfig = {
  appId: "com.awkto.keen456",
  appName: "Commander Keen 4·5·6",
  webDir: "www",
  server: {
    androidScheme: "https",
  },
  // No android.captureInput: it replaces the WebView's IME connection with a raw
  // BaseInputConnection (no editable field), so the soft keyboard dismisses
  // immediately / never opens and `beforeinput` never fires on the ⌨ proxy input.
  // Hardware keys still reach the page as normal keydown events without it.
};

export default config;
