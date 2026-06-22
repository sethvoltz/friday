<script lang="ts">
  // FRI-172 — thin deep-link wrapper. A cold load of /memory/<id> renders the
  // SAME <MemoryPage> as the index, but seeds the open accordion from
  // $page.params.id (page.state is empty across a full document load). The SSR
  // [id]/+page.server.ts 404 loader still gates the route; MemoryPage sources
  // its list from Zero (not the loader's single `entry`). The list IS the page
  // now, so the old detail-route nav link is intentionally absent.
  import { page } from "$app/stores";
  import MemoryPage from "$lib/components/Memory/MemoryPage.svelte";
</script>

<MemoryPage initialOpenId={$page.params.id} />
