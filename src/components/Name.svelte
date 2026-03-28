<script lang="ts">
  import { createProfileStore, getProfileName, type Profile } from '../lib/profile'
  import { getAnimalName } from '../lib/animalNames'

  export let pubkey: string

  let profile: Profile | undefined

  $: profileStore = pubkey ? createProfileStore(pubkey) : null
  $: profile = profileStore ? ($profileStore ?? undefined) : undefined
  $: profileName = getProfileName(profile)
  $: animalName = getAnimalName(pubkey)
</script>

{#if profileName}
  <span class="truncate">{profileName}</span>
{:else}
  <span class="truncate italic opacity-70">{animalName}</span>
{/if}
