import { EventEmitter } from "node:events";

// ---------------------------------------------------------------------------
// Ereignis-Verteiler (früher Redis Pub/Sub, Kanal "lagerhub")
//
// Redis war hier nie Datenspeicher, sondern reiner Verteiler: eine Route
// schreibt nach PostgreSQL und meldet danach, WAS passiert ist, damit /ws die
// Meldung an alle verbundenen Clients weiterreicht. Solange genau EIN
// Backend-Prozess läuft, geht das prozessintern – ohne zusätzlichen Dienst.
//
// Ausschlaggebend war der Umzug auf Windows Server: ein offizielles Redis gibt
// es dort nicht, und der Redis-kompatible Ersatz (Memurai) wäre ein weiterer
// Dienst samt Lizenzfrage gewesen, für eine Aufgabe, die ein EventEmitter
// vollständig abdeckt.
//
// ⚠️ GRENZE, die diese Datei setzt: Das funktioniert NUR bei einem einzigen
// Backend-Prozess. Sobald zwei Instanzen laufen (Lastverteilung, zweiter
// Server), sieht ein Client nur noch die Ereignisse SEINES Prozesses – dann
// braucht es wieder einen echten Broker (Redis/Memurai) oder Postgres
// LISTEN/NOTIFY. Die Aufrufstellen (`publish("lagerhub", …)`) bleiben dabei
// unverändert; auszutauschen wäre allein dieses Modul.
// ---------------------------------------------------------------------------

const CHANNEL = "lagerhub";

const bus = new EventEmitter();
// Es hängt genau EIN Zuhörer am Kanal (der Verteiler in server.ts, der das
// clients-Set selbst hält). Der großzügige Wert ist nur Vorsorge, damit ein
// zusätzlicher Zuhörer nicht als Leck-Warnung erscheint.
bus.setMaxListeners(50);

/**
 * Ereignis melden. Signatur und Kanal-Literal sind absichtlich unverändert
 * gegenüber der Redis-Fassung, damit die ~35 Aufrufstellen gleich bleiben.
 *
 * Zustellung erfolgt über `setImmediate`, also NACH der laufenden Arbeit des
 * Aufrufers – wie zuvor bei Redis, wo der Netzweg dasselbe bewirkte. Damit
 * kann ein langsamer oder fehlerhafter Empfänger den Request nicht aufhalten,
 * und ein `publish` bleibt das, was es war: melden und weitergehen.
 */
export function publish(channel: string, payload: unknown) {
  let message: string;
  try {
    message = JSON.stringify(payload);
  } catch (err) {
    // Ein nicht serialisierbares Payload darf den Request nicht scheitern
    // lassen – die Daten stehen zu diesem Zeitpunkt bereits in PostgreSQL.
    console.error("[events] Payload nicht serialisierbar:", (err as Error).message);
    return;
  }
  setImmediate(() => bus.emit(channel, message));
}

/**
 * Auf Ereignisse hören. Der Empfänger bekommt die fertige JSON-Zeichenkette,
 * genau wie zuvor von `redisSub.on("message", …)` – /ws reicht sie unverändert
 * an die Clients weiter.
 *
 * Fehler im Empfänger werden hier abgefangen: `emit` ruft die Zuhörer synchron
 * auf, eine Ausnahme daraus würde sonst als unbehandelter Fehler im
 * setImmediate-Callback den Prozess beenden.
 */
export function subscribe(handler: (message: string) => void) {
  bus.on(CHANNEL, (message: string) => {
    try {
      handler(message);
    } catch (err) {
      console.error("[events] Zustellung fehlgeschlagen:", (err as Error).message);
    }
  });
}
