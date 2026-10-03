import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

// --- HTTPS im Dev --------------------------------------------------------
// Zertifikat kommt aus ../certs (einmalig per `.\dev-certs.ps1` erzeugen).
// Fehlt es, laeuft der Server wie bisher ueber http – dann gibt es aber keinen
// Secure Context: Web-Push und PWA-Installation bleiben aus (siehe CLAUDE.md).
const certDir = fileURLToPath(new URL("../certs/", import.meta.url));
const keyFile = certDir + "lagerhub-dev.key";
const crtFile = certDir + "lagerhub-dev.crt";
const https =
  fs.existsSync(keyFile) && fs.existsSync(crtFile)
    ? { key: fs.readFileSync(keyFile), cert: fs.readFileSync(crtFile) }
    : undefined;
if (!https) {
  console.warn("[lagerhub] Kein Zertifikat in certs/ – Dev-Server laeuft ueber http. Abhilfe: .\\dev-certs.ps1");
}

// Dev-Server proxyt /api und /ws ans Fastify-Backend (Port 3000) – wie das
// Manager-Frontend. Same-origin-Prinzip: in Produktion liefert der Reverse-Proxy
// auf dem Firmenserver PWA + /api + /ws unter EINEM Origin aus, dieselben
// relativen Pfade funktionieren dann unverändert.
const BACKEND = process.env.VITE_BACKEND_URL ?? "http://localhost:3000";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      // M4: eigener Service Worker (src/sw.ts) für Web-Push-Empfang → injectManifest
      // statt generiertem SW. Auto-Registrierung via Plugin (injectRegister).
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.ts",
      injectRegister: "auto",
      // Dev-SW aktiv, damit Push unter http://localhost (Secure Context) testbar ist;
      // type:module erlaubt ESM/TS im Dev-Worker.
      devOptions: { enabled: true, type: "module" },
      manifest: {
        name: "LagerHub – Mitarbeiter",
        short_name: "LagerHub",
        description: "Mitarbeiter-App für die Lager-Aufgabenverwaltung",
        lang: "de",
        display: "standalone",
        orientation: "portrait",
        start_url: "/",
        scope: "/",
        theme_color: "#212c3d",
        background_color: "#ffffff",
        icons: [
          { src: "icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
          { src: "icon.svg", sizes: "any", type: "image/svg+xml", purpose: "maskable" },
        ],
      },
    }),
  ],
  server: {
    https,
    // Auf allen Schnittstellen lauschen, nicht nur localhost: die PWA soll im
    // LAN vom Handy/Tablet erreichbar sein (https://<LAN-IP>:5174). Achtung:
    // damit ist der Dev-Server für jeden im selben Netz offen. Die LAN-IP steckt
    // im Zertifikat – zusammen mit der auf dem Handy installierten Dev-CA gibt es
    // dort einen Secure Context, Web-Push und Installation funktionieren also
    // auch am Handy (siehe CLAUDE.md, PWA M4).
    host: true,
    port: 5174,
    proxy: {
      "/api": { target: BACKEND, changeOrigin: true },
      "/ws": { target: BACKEND, ws: true, changeOrigin: true },
    },
  },
});
