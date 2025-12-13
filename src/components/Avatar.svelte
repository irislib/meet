<script lang="ts">
  import { minidenticon } from 'minidenticons'
  import { createProfileStore, getProfileName } from '../lib/profile'
  import { getAnimalName } from '../lib/animalNames'

  export let pubkey: string
  export let size: number = 32

  $: profileStore = pubkey ? createProfileStore(pubkey) : null
  $: profile = profileStore ? $profileStore : null
  $: name = getProfileName(profile) || getAnimalName(pubkey)

  let imgError = false
  $: pubkey, imgError = false

  $: identicon = minidenticon(pubkey, 90, 50)
</script>

{#if profile?.picture && !imgError}
  <img
    src={profile.picture}
    alt={name}
    title={name}
    width={size}
    height={size}
    class="rounded-full object-cover"
    on:error={() => imgError = true}
  />
{:else}
  <img
    src="data:image/svg+xml;utf8,{encodeURIComponent(identicon)}"
    alt={name}
    title={name}
    width={size}
    height={size}
    class="rounded-full"
  />
{/if}
