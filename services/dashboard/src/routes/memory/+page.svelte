<script lang="ts">
  // FRI-172 — thin index wrapper. The full Memories surface lives in
  // <MemoryPage>; this route passes the SSR warm-baseline `entries` through and
  // opens via $page.state.memoryId (no initialOpenId — that's the cold deep-link
  // case handled by the [id] route).
  import type { PageData } from "./$types";
  import MemoryPage from "$lib/components/Memory/MemoryPage.svelte";

  let { data }: { data: PageData } = $props();
</script>

<MemoryPage data={{ entries: data.entries }} />
