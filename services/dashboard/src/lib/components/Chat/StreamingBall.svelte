<script lang="ts">
  // No props — parent controls visibility by conditionally rendering.
</script>

<span class="streaming-ball" aria-hidden="true">
  <span class="blob b1"></span>
  <span class="blob b2"></span>
  <span class="blob b3"></span>
</span>

<style>
  .streaming-ball {
    display: inline-block;
    position: relative;
    width: 16px;
    height: 16px;
    vertical-align: middle;
    overflow: visible;
    margin-left: 0.15em;
    top: -0.05em;
  }

  .blob {
    position: absolute;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    filter: blur(2px);
    mix-blend-mode: screen;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
  }

  .b1 {
    background: var(--chat-aurora-1);
    animation: orbit1 2.1s ease-in-out infinite;
  }

  .b2 {
    background: var(--chat-aurora-2);
    animation: orbit2 2.7s ease-in-out infinite;
  }

  .b3 {
    background: var(--chat-aurora-3);
    animation: orbit3 3.3s ease-in-out infinite;
  }

  @keyframes orbit1 {
    0%   { transform: translate(-50%, -50%) translate(0px, 0px); }
    33%  { transform: translate(-50%, -50%) translate(3px, -3px); }
    66%  { transform: translate(-50%, -50%) translate(-3px, 2px); }
    100% { transform: translate(-50%, -50%) translate(0px, 0px); }
  }

  @keyframes orbit2 {
    0%   { transform: translate(-50%, -50%) translate(0px, 0px); }
    33%  { transform: translate(-50%, -50%) translate(-4px, -2px); }
    66%  { transform: translate(-50%, -50%) translate(2px, 3px); }
    100% { transform: translate(-50%, -50%) translate(0px, 0px); }
  }

  @keyframes orbit3 {
    0%   { transform: translate(-50%, -50%) translate(0px, 0px); }
    33%  { transform: translate(-50%, -50%) translate(2px, 4px); }
    66%  { transform: translate(-50%, -50%) translate(-2px, -3px); }
    100% { transform: translate(-50%, -50%) translate(0px, 0px); }
  }

  @media (prefers-reduced-motion: reduce) {
    .blob {
      animation: none;
      filter: none;
    }
    .b2,
    .b3 {
      display: none;
    }
    .b1 {
      background: var(--text-primary);
      width: 8px;
      height: 8px;
    }
  }
</style>
