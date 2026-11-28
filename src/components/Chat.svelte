<script lang="ts">
  import { tick } from 'svelte'
  import { chatMessages, sendChatMessage, clearUnreadCount, type ChatMessage } from '../lib/meetingSession'
  import { identity } from '../lib/identity'

  export let isOpen = false

  let messageInput = ''
  let messagesContainer: HTMLDivElement | undefined
  let inputEl: HTMLInputElement | undefined
  let wasOpen = false
  let lastCount = 0

  function scrollToBottom() {
    void tick().then(() => {
      const container = messagesContainer
      if (container) container.scrollTop = container.scrollHeight
    })
  }

  function onOpened() {
    clearUnreadCount()
    void tick().then(() => {
      inputEl?.focus()
      const container = messagesContainer
      if (container) container.scrollTop = container.scrollHeight
    })
  }

  $: if (isOpen !== wasOpen) {
    wasOpen = isOpen
    if (isOpen) {
      lastCount = $chatMessages.length
      onOpened()
    }
  }

  $: if (isOpen && $chatMessages.length !== lastCount) {
    lastCount = $chatMessages.length
    scrollToBottom()
  }

  function handleSend() {
    if (!messageInput.trim()) return
    if (sendChatMessage(messageInput)) messageInput = ''
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  function formatTime(timestamp: number): string {
    return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }

  function isOwnMessage(msg: ChatMessage): boolean {
    return $identity?.pubkey === msg.from
  }

  function getBubbleClass(isOwn: boolean, isFirst: boolean, isLast: boolean): string {
    const base = isOwn ? 'bg-primary text-white' : 'bg-surface-light text-gray-200'
    if (isFirst && isLast) return `${base} rounded-2xl`
    if (isFirst) return `${base} rounded-t-2xl ${isOwn ? 'rounded-bl-2xl rounded-br-sm' : 'rounded-br-2xl rounded-bl-sm'}`
    if (isLast) return `${base} rounded-b-2xl ${isOwn ? 'rounded-tl-2xl rounded-tr-sm' : 'rounded-tr-2xl rounded-tl-sm'}`
    return `${base} ${isOwn ? 'rounded-l-2xl rounded-r-sm' : 'rounded-r-2xl rounded-l-sm'}`
  }

  const URL_RE = /(https?:\/\/[^\s<]+[^\s<.,;:!?"'\])>])/g

  function parseMessageWithLinks(text: string): Array<{ type: 'text' | 'link'; content: string }> {
    const parts: Array<{ type: 'text' | 'link'; content: string }> = []
    let lastIndex = 0
    for (const match of text.matchAll(URL_RE)) {
      const start = match.index ?? 0
      if (start > lastIndex) parts.push({ type: 'text', content: text.slice(lastIndex, start) })
      parts.push({ type: 'link', content: match[0] })
      lastIndex = start + match[0].length
    }
    if (lastIndex < text.length) parts.push({ type: 'text', content: text.slice(lastIndex) })
    return parts.length ? parts : [{ type: 'text', content: text }]
  }
</script>

{#if isOpen}
  <div class="w-80 h-full bg-surface border-l border-surface-lighter flex flex-col shrink-0">
    <!-- Header -->
    <div class="px-4 py-3 border-b border-surface-lighter flex items-center justify-between">
      <h3 class="font-medium text-white">In-call messages</h3>
      <button
        class="text-gray-400 hover:text-white p-1"
        on:click={() => isOpen = false}
        title="Close chat"
      >
        <span class="i-carbon-close w-5 h-5"></span>
      </button>
    </div>

    <!-- Messages -->
    <div
      bind:this={messagesContainer}
      class="flex-1 overflow-y-auto p-2"
    >
      {#if $chatMessages.length === 0}
        <p class="text-gray-500 text-sm text-center py-4">No messages yet</p>
      {:else}
        {#each $chatMessages as msg, i (msg.id)}
          {@const prevMsg = $chatMessages[i - 1]}
          {@const nextMsg = $chatMessages[i + 1]}
          {@const isFirst = prevMsg?.from !== msg.from}
          {@const isLast = nextMsg?.from !== msg.from}
          {@const isOwn = isOwnMessage(msg)}
          <div class="{isFirst ? 'mt-3' : 'mt-0.5'}">
            {#if isFirst}
              <div class="flex items-center gap-2 mb-1 {isOwn ? 'justify-end' : ''}">
                <span class="text-xs text-gray-400 font-medium">{isOwn ? 'You' : msg.fromName}</span>
                <span class="text-xs text-gray-600">{formatTime(msg.timestamp)}</span>
              </div>
            {/if}
            <div class="flex {isOwn ? 'justify-end' : ''}">
              <div class="max-w-[85%] px-3 py-1 text-sm break-words overflow-hidden {getBubbleClass(isOwn, isFirst, isLast)}">{#each parseMessageWithLinks(msg.text) as part}{#if part.type === 'link'}<a href={part.content} target="_blank" rel="noopener noreferrer" class="underline hover:opacity-80 break-all {isOwn ? 'text-white' : 'text-primary'}">{part.content}</a>{:else}{part.content}{/if}{/each}</div>
            </div>
          </div>
        {/each}
      {/if}
    </div>

    <!-- Input -->
    <div class="p-3 border-t border-surface-lighter pb-20">
      <div class="flex gap-2">
        <input
          bind:this={inputEl}
          bind:value={messageInput}
          type="text"
          placeholder="Type a message..."
          class="flex-1 px-3 py-2 bg-surface-light rounded-lg text-white text-sm outline-none b-1 b-solid b-surface-lighter focus:b-primary"
          on:keydown={handleKeydown}
        />
        <button
          class="px-3 py-2 bg-primary hover:bg-primary-dark rounded-lg text-white transition-colors"
          on:click={handleSend}
          disabled={!messageInput.trim()}
          aria-label="Send message"
          title="Send message"
        >
          <span class="i-carbon-send w-5 h-5"></span>
        </button>
      </div>
    </div>
  </div>
{/if}
