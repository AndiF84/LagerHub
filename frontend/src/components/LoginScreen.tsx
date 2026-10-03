// Schlanke Dashboard-Anmeldung per 4-stelligem PIN. Liefert bei Erfolg den
// SessionUser (Rolle/Name) nach oben; daraus ergeben sich die sichtbaren Tabs.
import { useState } from "react";
import { usePinLogin } from "../api/queries";
import type { SessionUser } from "../api/types";

export function LoginScreen({ onLogin }: { onLogin: (user: SessionUser) => void }) {
  const [pin, setPin] = useState("");
  const login = usePinLogin();

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (pin.length !== 4) return;
    login.mutate(pin, {
      onSuccess: (user) => onLogin(user),
    });
  };

  return (
    <div className="login">
      <form className="card login__card" onSubmit={submit}>
        <h1 style={{ marginTop: 0 }}>LagerHub</h1>
        <p className="muted" style={{ marginTop: 0 }}>Mit deinem 4-stelligen PIN anmelden.</p>
        <input
          className="pin-input"
          type="password"
          inputMode="numeric"
          autoFocus
          maxLength={4}
          placeholder="••••"
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 4))}
        />
        <button
          className="btn btn--primary btn--block"
          type="submit"
          disabled={pin.length !== 4 || login.isPending}
        >
          {login.isPending ? "Anmelden…" : "Anmelden"}
        </button>
        {login.isError && (
          <p className="error">{String((login.error as Error)?.message ?? login.error)}</p>
        )}
      </form>
    </div>
  );
}
