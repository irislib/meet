<script lang="ts">
  import { createProfileStore, getProfileName } from '../lib/profile'
  import { getAnimalName } from '../lib/animalNames'

  export let pubkey: string

  $: profileStore = pubkey ? createProfileStore(pubkey) : null
  $: profile = profileStore ? $profileStore : null
  $: profileName = getProfileName(profile)
  $: animalName = getAnimalName(pubkey)
</script>

{#if profileName}
  <span class="truncate">{profileName}</span>
{:else}
  <span class="truncate italic opacity-70">{animalName}</span>
{/if}
