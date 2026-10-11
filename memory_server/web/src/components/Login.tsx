import { useState } from "preact/hooks";
import { api, saveToken, setToken } from "../api.js";
import { logIn } from "../state.js";

export function Login() {
  const [value, setValue] = useState("");
  const [remember, setRemember] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  const submit = async (event: Event) => {
    event.preventDefault();
    const candidate = value.trim();
    if (!candidate) return;
    setBusy(true);
    setError(undefined);
    setToken(candidate);
    try {
      await api.stores();
      saveToken(candidate, remember);
      logIn(candidate);
    } catch (e) {
      setToken(undefined);
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="login">
      <form onSubmit={submit}>
        <h1>Memory</h1>
        <p class="muted">Paste a token: the viewer token (read-only) is meant for this page.</p>
        <label>
          Token
          <input type="password" autoComplete="current-password" value={value} autoFocus
            onInput={(e) => setValue((e.target as HTMLInputElement).value)} />
        </label>
        <label class="inline">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember((e.target as HTMLInputElement).checked)} />
          Remember on this browser
        </label>
        {error && <div class="error" role="alert">{error}</div>}
        <button type="submit" disabled={busy || value.trim() === ""}>Open</button>
      </form>
    </div>
  );
}
