import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
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

// Dev-Server proxyt /api und /ws ans Fastify-Backend (Port 3000).
// Dadurch braucht das Frontend keine absolute URL/CORS-Konfiguration.
const BACKEND = process.env.VITE_BACKEND_URL ?? "http://localhost:3000";

export default defineConfig({
  plugins: [react()],
  server: {
    https,
    // Wie in der PWA: im LAN erreichbar (Dashboard auf dem Tablet).
    // Der Dev-Server ist damit für jeden im selben Netz offen.
    host: true,
    port: 5173,
    proxy: {
      "/api": { target: BACKEND, changeOrigin: true },
      "/ws": { target: BACKEND, ws: true, changeOrigin: true },
    },
  },
});
