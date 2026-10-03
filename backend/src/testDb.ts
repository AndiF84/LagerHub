/**
 * Adresse der Test-Datenbank – abgeleitet aus DATABASE_URL.
 *
 * Bewusst abgeleitet statt als eigener Eintrag in der .env: die Tests sollen
 * denselben Server und dieselbe Rolle benutzen wie die Entwicklung, nur eine
 * andere Datenbank. Ein zweiter Satz Zugangsdaten waere eine weitere Stelle,
 * an der etwas auseinanderlaufen kann.
 */
export const TEST_DB_NAME = "lagerhub_test";

/** Tauscht den Datenbanknamen in einer Postgres-URL aus. */
export function testDatabaseUrl(base: string, name: string = TEST_DB_NAME): string {
  const url = new URL(base);
  url.pathname = `/${name}`;
  return url.toString();
}
