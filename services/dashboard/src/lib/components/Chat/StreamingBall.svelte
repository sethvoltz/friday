<script lang="ts">
  // No props — parent controls visibility by conditionally rendering.
</script>

<span class="streaming-ball" aria-hidden="true"></span>

<style>
  .streaming-ball {
    display: inline-block;
    width: 0.65em;
    height: 0.65em;
    border-radius: 50%;
    margin-left: 0.2em;
    vertical-align: middle;
    position: relative;
    top: -0.05em;

    /* Aurora gradient that scrolls along the X axis */
    background: linear-gradient(
      90deg,
      var(--accent-primary),
      color-mix(in srgb, var(--accent-primary) 60%, var(--text-primary)),
      var(--accent-primary),
      color-mix(in srgb, var(--accent-primary) 40%, transparent)
    );
    background-size: 300% 100%;

    animation:
      aurora 2.4s linear infinite,
      streaming-motion 3.2s ease-in-out infinite;
  }

  @keyframes aurora {
    0%   { background-position: 0% 50%; }
    100% { background-position: 300% 50%; }
  }

  /* Combines subtle travel + breathe into a single transform timeline. */
  @keyframes streaming-motion {
    0%   { transform: translate(0, 0) scale(1); }
    25%  { transform: translate(0.06em, -0.06em) scale(0.88); }
    50%  { transform: translate(0.03em, 0.04em) scale(1); }
    75%  { transform: translate(-0.04em, -0.03em) scale(0.88); }
    100% { transform: translate(0, 0) scale(1); }
  }

  @media (prefers-reduced-motion: reduce) {
    .streaming-ball {
      animation: none;
      background: var(--text-tertiary);
    }
  }
</style>
