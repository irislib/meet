<script lang="ts">
  import { onMount, afterUpdate } from 'svelte'
  import { chatMessages, sendChatMessage, clearUnreadCount, type ChatMessage } from '../lib/webrtc'
  import { identity } from '../lib/identity'

  export let isOpen = false

  let messageInput = ''
  let messagesContainer: HTMLDivElement
  let inputEl: HTMLInputElement

  $: if (isOpen) {
    clearUnreadCount()
    // Focus input when opening
    setTimeout(() => inputEl?.focus(), 100)
  }

  afterUpdate(() => {
    // Scroll to bottom when new messages arrive
    if (messagesContainer) {
      messagesContainer.scrollTop = messagesContainer.scrollHeight
    }
  })

  function handleSend() {
    if (!messageInput.trim()) return
    sendChatMessage(messageInput)
    messageInput = ''
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

    if (isFirst && isLast) {
      return `${base} rounded-2xl`
    }
    if (isFirst) {
      return isOwn
        ? `${base} rounded-t-2xl rounded-bl-2xl rounded-br-sm`
        : `${base} rounded-t-2xl rounded-br-2xl rounded-bl-sm`
    }
    if (isLast) {
      return isOwn
        ? `${base} rounded-b-2xl rounded-tl-2xl rounded-tr-sm`
        : `${base} rounded-b-2xl rounded-tr-2xl rounded-tl-sm`
    }
    return isOwn
      ? `${base} rounded-l-2xl rounded-r-sm`
      : `${base} rounded-r-2xl rounded-l-sm`
  }

  // Simple URL regex
  const urlRegex = /(https?:\/\/[^\s<]+[^\s<.,;:!?"'\])>])/g

  function parseMessageWithLinks(text: string): Array<{ type: 'text' | 'link', content: string }> {
    const parts: Array<{ type: 'text' | 'link', content: string }> = []
    let lastIndex = 0
    let match

    while ((match = urlRegex.exec(text)) !== null) {
      if (match.index > lastIndex) {
        parts.push({ type: 'text', content: text.slice(lastIndex, match.index) })
      }
      parts.push({ type: 'link', content: match[0] })
      lastIndex = urlRegex.lastIndex
    }

    if (lastIndex < text.length) {
      parts.push({ type: 'text', content: text.slice(lastIndex) })
    }

    // Reset regex state
    urlRegex.lastIndex = 0

    return parts.length > 0 ? parts : [{ type: 'text', content: text }]
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
        >
          <span class="i-carbon-send w-5 h-5"></span>
        </button>
      </div>
    </div>
  </div>
{/if}
