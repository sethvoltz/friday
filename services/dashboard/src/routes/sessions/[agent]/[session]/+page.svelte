<script lang="ts">
  import { page } from "$app/stores";
  import ChatShell from "$lib/components/Chat/ChatShell.svelte";

  let agent = $derived($page.params.agent ?? "");
  let sessionId = $derived($page.params.session ?? "");
</script>

<ChatShell {agent} {sessionId} />
