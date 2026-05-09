<script lang="ts">
  let email = $state("");
  let password = $state("");
  let error = $state<string | null>(null);
  let submitting = $state(false);

  async function submit(e: Event) {
    e.preventDefault();
    error = null;
    submitting = true;
    try {
      const r = await fetch("/api/auth/sign-in/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      if (!r.ok) {
        const data = (await r.json().catch(() => ({}))) as { message?: string };
        error = data.message ?? `${r.status} ${r.statusText}`;
        return;
      }
      window.location.href = "/";
    } catch (err: unknown) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      submitting = false;
    }
  }
</script>

<div class="login-screen">
  <form class="card login-card" onsubmit={submit}>
    <h1>Friday</h1>
    <p class="page-lead">Sign in.</p>

    <label class="field">
      <span class="field-label">Email</span>
      <input
        class="page-input"
        type="email"
        bind:value={email}
        autocomplete="username"
        required />
    </label>
    <label class="field">
      <span class="field-label">Password</span>
      <input
        class="page-input"
        type="password"
        bind:value={password}
        autocomplete="current-password"
        required />
    </label>

    {#if error}
      <div class="error">{error}</div>
    {/if}

    <button type="submit" class="primary" disabled={submitting}>
      {submitting ? "Signing in…" : "Sign in"}
    </button>

    <p class="hint">
      No account? Create one with <code>friday setup</code> on the host machine.
    </p>
  </form>
</div>

<style>
  .login-screen {
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 1rem;
    background: var(--bg-primary);
  }
  .login-card {
    width: 100%;
    max-width: 380px;
    padding: 2rem;
    display: flex;
    flex-direction: column;
    gap: 0.85rem;
    box-shadow: var(--shadow-lg);
  }
  .login-card h1 { margin-bottom: 0.25rem; }
  .field { display: flex; flex-direction: column; gap: 0.3rem; }
  .field-label {
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-tertiary);
    font-weight: 600;
  }
  .error {
    background: var(--status-error-bg);
    color: var(--status-error);
    padding: 0.5rem 0.75rem;
    border-radius: var(--radius-sm);
    font-size: 0.85rem;
  }
  .hint {
    color: var(--text-tertiary);
    font-size: 0.78rem;
    margin: 0;
  }
  .hint code {
    background: var(--bg-code);
    padding: 0.1rem 0.35rem;
    border-radius: 3px;
    font-family: var(--font-mono);
  }
</style>
