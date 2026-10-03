// PIN-Anmeldung der Mitarbeiter-PWA (mobil, großer Ziffern-Input). Bindet das
// Gerät via deviceId und reicht den angemeldeten MA nach oben.
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { api } from "../api/client";
import { getDeviceId } from "../api/session";
import type { MaUser } from "../api/types";

// Technische Fehlermeldung des Wrappers in eine MA-taugliche übersetzen.
function loginErrorText(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes("Gerät nicht autorisiert")) {
    return "Dieses Gerät ist bereits einem anderen Mitarbeiter zugeordnet. Bitte den Manager um einen Geräte-Reset bitten.";
  }
  if (msg.includes("Ungültiger PIN")) return "Ungültiger PIN.";
  return msg;
}

export function LoginScreen({ onLogin }: { onLogin: (user: MaUser) => void }) {
  const [pin, setPin] = useState("");
  const login = useMutation({
    mutationFn: (p: string) => api.deviceLogin(p, getDeviceId()),
    onSuccess: (user) => onLogin(user),
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (pin.length === 4) login.mutate(pin);
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
        {login.isError && <p className="error">{loginErrorText(login.error)}</p>}
      </form>
    </div>
  );
}
