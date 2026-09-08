"use client";

import { useState, type FormEvent } from "react";
import { signIn } from "next-auth/react";

export default function LoginPage(): JSX.Element {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setSubmitting(true);
    setError(undefined);
    // redirect: false so we control navigation ourselves instead of Auth.js's own redirect — makes the
    // error path (wrong credentials) simple to show inline rather than as a query-string error on a
    // redirected page.
    const result = await signIn("credentials", { email, password, redirect: false });
    setSubmitting(false);
    if (!result || result.error) {
      setError("Email o password non corrette.");
      return;
    }
    window.location.href = "/";
  }

  return (
    <main className="login-main">
      <section className="panel login-panel">
        <h1>ARALD — Specchio</h1>
        <p className="muted">Accesso operatori. Le credenziali sono create da un Admin ARALD, nessuna registrazione pubblica.</p>
        <form onSubmit={handleSubmit} className="login-form">
          <label>
            Email
            <input type="email" required autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
          <label>
            Password
            <input type="password" required autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
          {error && <p className="login-error">{error}</p>}
          <button type="submit" disabled={submitting}>
            {submitting ? "Accesso in corso…" : "Accedi"}
          </button>
        </form>
      </section>
    </main>
  );
}
