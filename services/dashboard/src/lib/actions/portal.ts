/**
 * Svelte action: move the bound element to `document.body` for the duration
 * of its lifetime. Useful for modals/overlays whose `position: fixed` would
 * otherwise be trapped inside a parent stacking context (e.g. a parent with
 * `transform`, `filter`, `backdrop-filter`, or `will-change`).
 */
export function portal(node: HTMLElement, target: HTMLElement | string = document.body) {
  const dest =
    typeof target === "string"
      ? (document.querySelector(target) as HTMLElement | null) ?? document.body
      : target;
  dest.appendChild(node);
  return {
    destroy() {
      node.remove();
    },
  };
}
