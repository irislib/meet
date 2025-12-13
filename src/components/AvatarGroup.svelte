<script lang="ts">
  import Avatar from './Avatar.svelte'

  export let pubkeys: string[] = []
  export let size: number = 28
  export let maxDisplay: number = 5
  export let onClick: (() => void) | undefined = undefined

  $: displayPubkeys = pubkeys.slice(0, maxDisplay)
  $: overflow = pubkeys.length - maxDisplay
</script>

<button
  class="flex items-center"
  on:click={onClick}
  disabled={!onClick}
>
  {#each displayPubkeys as pubkey, index (pubkey)}
    <div
      class="flex-shrink-0 rounded-full ring-2 ring-surface"
      style="margin-left: {index > 0 ? `-${size / 3}px` : '0'}; z-index: {displayPubkeys.length - index};"
    >
      <Avatar {pubkey} {size} />
    </div>
  {/each}
  {#if overflow > 0}
    <div
      class="flex-shrink-0 rounded-full ring-2 ring-surface bg-surface-light flex items-center justify-center text-xs font-medium text-gray-300"
      style="margin-left: -{size / 3}px; width: {size}px; height: {size}px; z-index: 0;"
    >
      +{overflow}
    </div>
  {/if}
</button>
