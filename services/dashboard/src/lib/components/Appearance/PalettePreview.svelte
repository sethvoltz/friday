<script lang="ts">
  import type { PaletteName } from "$lib/theme/palettes";

  interface Props {
    palette: PaletteName;
    label: string;
  }

  let { palette, label }: Props = $props();

  // The parent `<button class="palette-{name}">` wraps this component
  // in the named palette's CSS scope, so every `var(--*)` inside this
  // template resolves against THAT palette's tokens — not the active
  // palette's. This is the key to AC #25 (each preview renders in its
  // own scope regardless of which palette the user is currently using).
  //
  // The mini-page mocks Friday's primary surface (chat) so a reader
  // can identify a palette at a glance from its accent + bubble +
  // status pills + aurora hint without learning a separate vocabulary.
  // Aspect ratio is 3:2 (BLOCKED ON OWNER #2 default).
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  void palette;
</script>

<div class="preview">
  <header class="preview-head">
    <span class="preview-title">{label}</span>
    <span class="preview-dot" aria-hidden="true"></span>
  </header>

  <div class="preview-chat" aria-hidden="true">
    <div class="bubble bubble-ai">
      <span class="bubble-line" style="width: 92%"></span>
      <span class="bubble-line" style="width: 76%"></span>
    </div>
    <div class="bubble bubble-user">
      <span class="bubble-line user-line" style="width: 80%"></span>
    </div>
  </div>

  <div class="preview-pills" aria-hidden="true">
    <span class="pill pill-ok">ok</span>
    <span class="pill pill-warn">warn</span>
    <span class="pill pill-error">error</span>
  </div>

  <div class="preview-aurora" aria-hidden="true"></div>
</div>

<style>
  /* 3:2 aspect, mobile-friendly minimum. The grid in Appearance card
     uses auto-fill minmax(220px, 1fr) so cards collapse to one per row
     under ~440px viewport width. */
  .preview {
    aspect-ratio: 3 / 2;
    display: grid;
    grid-template-rows: auto 1fr auto auto;
    gap: 0.5rem;
    padding: 0.7rem 0.85rem 0.55rem;
    background: var(--bg-card);
    color: var(--text-primary);
    font-family: var(--font-sans);
  }

  /* Header: palette name + a small accent dot (a fingerprint for the
     accent-primary hue). */
  .preview-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .preview-title {
    font-size: 0.9rem;
    font-weight: 600;
    letter-spacing: -0.01em;
    color: var(--text-primary);
  }
  .preview-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--accent-primary);
    box-shadow: 0 0 0 3px var(--accent-glow);
  }

  /* Chat mock: an AI-style ghost bubble + a user-style accent bubble.
     The real chat (ChatMessages.svelte:803) renders assistant content
     chromeless, but in a tiny preview an invisible AI bubble means the
     card reads as "user only." We give the AI side a ghost envelope
     (subtle bg + hairline border) so both sides of the conversation
     register at a glance. Bubble widths are explicit because the
     percentage-width `bubble-line` children would otherwise collapse
     the bubble to ~0 in a flex-column with no intrinsic width. */
  .preview-chat {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    min-height: 0;
    justify-content: center;
  }
  .bubble {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    padding: 0.4rem 0.55rem;
    border-radius: var(--radius-sm);
    box-sizing: border-box;
  }
  .bubble-ai {
    background: var(--bg-secondary);
    border: 1px solid var(--border-subtle);
    align-self: flex-start;
    width: 72%;
  }
  .bubble-user {
    background: var(--accent-primary);
    align-self: flex-end;
    width: 62%;
  }
  .bubble-line {
    display: block;
    height: 5px;
    border-radius: 2px;
    background: var(--text-secondary);
    opacity: 0.55;
  }
  .bubble-user .user-line {
    background: var(--text-inverse);
    opacity: 0.75;
  }

  /* Status pills — three small chips signaling the ok/warn/error
     hues. A palette's status spread is one of the most identifiable
     visual signatures. */
  .preview-pills {
    display: flex;
    gap: 0.3rem;
  }
  .pill {
    font-size: 0.6rem;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    padding: 0.05rem 0.35rem;
    border-radius: 99px;
  }
  .pill-ok {
    background: var(--status-ok-bg);
    color: var(--status-ok);
  }
  .pill-warn {
    background: var(--status-warn-bg);
    color: var(--status-warn);
  }
  .pill-error {
    background: var(--status-error-bg);
    color: var(--status-error);
  }

  /* Aurora hint — a thin gradient strip at the bottom hinting at the
     chat-input aurora animation without actually animating. Reads as
     "this palette ships these signature hues." */
  .preview-aurora {
    height: 4px;
    border-radius: 2px;
    background: linear-gradient(
      90deg,
      var(--chat-aurora-1) 0%,
      var(--chat-aurora-2) 50%,
      var(--chat-aurora-3) 100%
    );
    opacity: 0.7;
  }
</style>
