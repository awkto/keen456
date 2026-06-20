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
  android: {
    // Route key events to the WebView so the emulator/keyboard get them (it's a game).
    captureInput: true,
  },
};

export default config;
