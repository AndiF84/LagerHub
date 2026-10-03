/// <reference lib="webworker" />
// LagerHub PWA – Service Worker (M4). Empfängt Web-Push und öffnet die App beim
// Klick auf eine Benachrichtigung. Läuft im WebWorker-Kontext (kein DOM) – daher
// aus dem tsc-Typecheck ausgenommen (siehe tsconfig `exclude`); esbuild kompiliert
// ihn beim Build.
import { precacheAndRoute } from "workbox-precaching";

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<{ url: string; revision: string | null } | string>;
};

// injectManifest ersetzt `self.__WB_MANIFEST` durch die Precache-Liste des Builds.
// precacheAndRoute cached die App-Shell (offline-fähig) und ist zugleich die
// Standard-Injection-Stelle, die den Token sicher im Bundle hält.
precacheAndRoute(self.__WB_MANIFEST);

self.addEventListener("install", () => {
  // Neue SW-Version sofort aktiv werden lassen (kein Warten auf alte Tabs).
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// Web-Push: der Server schickt { title, body, url? } als JSON (services/push.ts).
self.addEventListener("push", (event) => {
  let data: { title?: string; body?: string; url?: string } = {};
  try {
    if (event.data) data = event.data.json();
  } catch {
    data = { body: event.data?.text() };
  }
  event.waitUntil(
    self.registration.showNotification(data.title ?? "LagerHub", {
      body: data.body ?? "",
      icon: "/icon.svg",
      badge: "/icon.svg",
      // Vibration ist das Einzige am Signal, das die Seite selbst bestimmen kann.
      // Den TON legt Android fest: Web-Push laeuft ueber einen Benachrichtigungs-
      // Kanal von Chrome, und dessen Wichtigkeit/Ton stellt der Nutzer in den
      // Android-Einstellungen ein – kein Feld der Push-API aendert das.
      // Im Lager ist das Ruetteln ohnehin das verlaesslichere Signal: Telefon in
      // der Tasche, Umgebung laut.
      vibrate: [200, 100, 200],
      data: { url: data.url ?? "/" },
    }),
  );
});

// Klick auf die Benachrichtigung: bestehendes App-Fenster fokussieren, sonst öffnen.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data as { url?: string } | undefined)?.url ?? "/";
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of windows) {
        if ("focus" in client) return client.focus();
      }
      return self.clients.openWindow(url);
    })(),
  );
});
