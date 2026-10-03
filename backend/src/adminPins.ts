// Geheime Admin-PINs für die Dashboard-Vollansicht (Rolle ADMIN). Bewusst NICHT
// als Mitarbeiter/DB-Datensatz, sondern aus der .env – so bleiben sie geheim
// (gitignored) und es braucht keine Migration.
//
//   ADMIN_PINS="1234:Admin,5678:Chef"   (Platzhalter – echte PINs NUR in .env!)
//
// Format je Eintrag: "<4-stellige PIN>:<Anzeigename>". Fehlt der Name, gilt "Admin".
// Die echten PINs stehen ausschließlich in backend/.env (gitignored) – niemals hier
// im Quellcode, der versioniert wird.
// Lazy geparst + gecacht, damit die .env (via dotenv) garantiert geladen ist.
let cache: Map<string, string> | null = null;

function getAdminPins(): Map<string, string> {
  if (cache) return cache;
  cache = new Map();
  for (const entry of (process.env.ADMIN_PINS ?? "").split(",")) {
    const [pin, name] = entry.split(":").map((s) => s.trim());
    if (pin && /^\d{4}$/.test(pin)) cache.set(pin, name || "Admin");
  }
  return cache;
}

// Liefert den Anzeigenamen, wenn die PIN eine Admin-PIN ist, sonst null.
export function adminForPin(pin: string): { name: string } | null {
  const name = getAdminPins().get(pin);
  return name ? { name } : null;
}

// Ist diese PIN als Admin-PIN reserviert? (Damit sie nicht an einen MA vergeben wird.)
export function isAdminPin(pin: string): boolean {
  return getAdminPins().has(pin);
}
