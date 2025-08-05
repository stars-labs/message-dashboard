<script>
  import { onMount, onDestroy } from 'svelte';
  import { api } from './api.js';
  import { fade, slide } from 'svelte/transition';
  import { writable } from 'svelte/store';

  export const user = null;

  let isOpen = false;
  let isMinimized = false;
  let messages = [];
  let inputMessage = '';
  let isLoading = false;
  let conversationId = null;
  let conversations = [];
  let showConversationList = false;
  let chatContainer;
  let isTyping = false;
  let typingTimeout;
  
  // Auto-hide functionality
  let isHovered = false;
  let hideTimeout;
  let showButton = false;

  // Quick actions
  const quickActions = [
    { id: 'codes', label: '📱 Recent Codes', query: 'Show me recent verification codes' },
    { id: 'stats', label: '📊 Statistics', query: 'What are my messaging statistics for today?' },
    { id: 'phones', label: '📞 Phone Status', query: 'Which phones are online?' },
    { id: 'help', label: '❓ Help', query: 'What can you help me with?' }
  ];

  onMount(() => {
    // Load conversation history
    loadConversations();
    
    // Show button initially
    showButton = true;
    
    // Hide button after 2 seconds if not hovered
    hideTimeout = setTimeout(() => {
      if (!isHovered && !isOpen) {
        showButton = false;
      }
    }, 2000);
    
    // Add mouse movement listener for auto-show functionality
    document.addEventListener('mousemove', handleMouseMove);
  });
  
  onDestroy(() => {
    if (hideTimeout) clearTimeout(hideTimeout);
    document.removeEventListener('mousemove', handleMouseMove);
  });
  
  function handleMouseMove(event) {
    // Check if mouse is near bottom-right corner (within 150px)
    const threshold = 150;
    const distanceFromRight = window.innerWidth - event.clientX;
    const distanceFromBottom = window.innerHeight - event.clientY;
    
    if (distanceFromRight < threshold && distanceFromBottom < threshold) {
      showButton = true;
      if (hideTimeout) clearTimeout(hideTimeout);
    } else if (!isHovered && !isOpen && showButton) {
      // Hide quickly (500ms) when mouse moves away
      if (hideTimeout) clearTimeout(hideTimeout);
      hideTimeout = setTimeout(() => {
        if (!isHovered && !isOpen) {
          showButton = false;
        }
      }, 500);
    }
  }
  
  function handleMouseEnter() {
    isHovered = true;
    showButton = true;
    if (hideTimeout) clearTimeout(hideTimeout);
  }
  
  function handleMouseLeave() {
    isHovered = false;
    if (!isOpen) {
      // Hide quickly after mouse leaves the button
      hideTimeout = setTimeout(() => {
        if (!isHovered && !isOpen) {
          showButton = false;
        }
      }, 500);
    }
  }

  async function loadConversations() {
    try {
      const response = await api.get('/api/ai/chat/conversations');
      if (response.success) {
        conversations = response.data;
      }
    } catch (error) {
      console.error('Failed to load conversations:', error);
    }
  }

  async function loadConversation(convId) {
    try {
      const response = await api.get(`/api/ai/chat/conversations/${convId}`);
      if (response.success) {
        messages = response.data.messages.map(msg => ({
          role: msg.role,
          content: msg.content,
          timestamp: new Date(msg.created_at)
        }));
        conversationId = convId;
        showConversationList = false;
        scrollToBottom();
      }
    } catch (error) {
      console.error('Failed to load conversation:', error);
    }
  }

  function newConversation() {
    messages = [];
    conversationId = null;
    showConversationList = false;
    addMessage('assistant', "Hello! I'm your SMS Dashboard Assistant. I can help you:\n\n• Find and search messages\n• Extract verification codes\n• Check phone status\n• Analyze messaging patterns\n• Send SMS messages\n\nWhat would you like to do?");
  }

  function toggleChat() {
    isOpen = !isOpen;
    if (isOpen && messages.length === 0) {
      newConversation();
    }
    // When closing chat, start hide timer
    if (!isOpen) {
      if (hideTimeout) clearTimeout(hideTimeout);
      hideTimeout = setTimeout(() => {
        if (!isHovered) {
          showButton = false;
        }
      }, 500);
    }
  }

  function toggleMinimize() {
    isMinimized = !isMinimized;
  }

  function addMessage(role, content) {
    messages = [...messages, {
      role,
      content,
      timestamp: new Date()
    }];
    scrollToBottom();
  }

  async function sendMessage() {
    if (!inputMessage.trim() || isLoading) return;

    const userMessage = inputMessage.trim();
    inputMessage = '';
    
    console.log('[ChatAssistant] Sending message:', userMessage);
    addMessage('user', userMessage);
    isLoading = true;
    isTyping = true;

    // Add placeholder for assistant message
    const assistantMessageIndex = messages.length;
    messages = [...messages, {
      role: 'assistant',
      content: '',
      timestamp: new Date(),
      isStreaming: true
    }];

    // Check auth token
    const authToken = localStorage.getItem('auth_token');
    console.log('[ChatAssistant] Auth token:', authToken ? 'present' : 'missing');

    try {
      console.log('[ChatAssistant] Making fetch request to /api/ai/chat/stream');
      const response = await fetch('/api/ai/chat/stream', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${localStorage.getItem('auth_token')}`
        },
        body: JSON.stringify({
          message: userMessage,
          conversation_id: conversationId
        })
      });

      console.log('[ChatAssistant] Response received:', response.status, response.statusText);
      if (!response.ok) {
        const errorText = await response.text();
        console.log('[ChatAssistant] Error response:', errorText);
        throw new Error(`HTTP error! status: ${response.status}, body: ${errorText}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let streamedContent = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        let i = 0;
        while (i < lines.length) {
          const line = lines[i];
          if (line.startsWith('event:')) {
            const event = line.substring(6).trim();
            
            // Get the next line which should be the data
            const dataLine = lines[i + 1];
            if (dataLine && dataLine.startsWith('data:')) {
              try {
                const data = JSON.parse(dataLine.substring(5).trim());
                
                switch (event) {
                case 'conversation':
                  conversationId = data.conversation_id;
                  break;
                  
                case 'thinking':
                  messages[assistantMessageIndex].content = '🤔 Thinking...';
                  messages = [...messages];
                  break;
                  
                case 'functions':
                  messages[assistantMessageIndex].content = `🔧 Calling functions: ${data.functions.join(', ')}...`;
                  messages = [...messages];
                  break;
                  
                case 'processing':
                  messages[assistantMessageIndex].content = '⚙️ Processing results...';
                  messages = [...messages];
                  break;
                  
                case 'message':
                  if (data.chunk) {
                    streamedContent += data.chunk;
                    messages[assistantMessageIndex].content = streamedContent;
                    messages[assistantMessageIndex].isStreaming = true;
                    messages = [...messages];
                    scrollToBottom();
                  }
                  break;
                  
                case 'done':
                  messages[assistantMessageIndex].isStreaming = false;
                  messages = [...messages];
                  isTyping = false;
                  loadConversations();
                  break;
                  
                case 'error':
                  throw new Error(data.error || 'Stream error');
              }
              
              // Skip the data line
              i += 2;
              } catch (e) {
                console.error('Error parsing SSE data:', e);
                i++;
              }
            } else {
              i++;
            }
          } else {
            i++;
          }
        }
      }
    } catch (error) {
      console.error('[ChatAssistant] Chat error:', error);
      console.error('[ChatAssistant] Error details:', error.message, error.stack);
      messages[assistantMessageIndex].content = 'Sorry, I encountered an error. Please try again.';
      messages[assistantMessageIndex].isStreaming = false;
      messages = [...messages];
      isTyping = false;
    } finally {
      console.log('[ChatAssistant] Finally block, setting isLoading = false');
      isLoading = false;
    }
  }

  function handleKeyDown(event) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      sendMessage();
    }
  }

  function quickAction(action) {
    inputMessage = action.query;
    sendMessage();
  }

  function scrollToBottom() {
    if (chatContainer) {
      setTimeout(() => {
        chatContainer.scrollTop = chatContainer.scrollHeight;
      }, 100);
    }
  }

  function copyCode(code) {
    navigator.clipboard.writeText(code);
    // You could add a toast notification here
  }

  function formatMessage(content) {
    // Format verification codes
    content = content.replace(/\b(\d{4,6})\b/g, '<code class="verification-code" data-code="$1">$1</code>');
    
    // Format bullet points
    content = content.replace(/^[•·]/gm, '•');
    
    // Format line breaks
    content = content.replace(/\n/g, '<br>');
    
    return content;
  }
</script>

<div class="chat-assistant" class:open={isOpen} class:minimized={isMinimized}>
  {#if !isOpen}
    {#if showButton}
      <button 
        class="chat-toggle" 
        on:click={toggleChat}
        on:mouseenter={handleMouseEnter}
        on:mouseleave={handleMouseLeave}
        transition:fade={{duration: 200}}
      >
        <div class="chat-icon">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
            <path d="M12 2C6.48 2 2 6.48 2 12C2 17.52 6.48 22 12 22C17.52 22 22 17.52 22 12C22 6.48 17.52 2 12 2ZM12 20C7.58 20 4 16.42 4 12C4 7.58 7.58 4 12 4C16.42 4 20 7.58 20 12C20 16.42 16.42 20 12 20Z" fill="currentColor"/>
            <path d="M12 6C9.79 6 8 7.79 8 10H10C10 8.9 10.9 8 12 8C13.1 8 14 8.9 14 10C14 12 11 11.75 11 15H13C13 12.75 16 12.5 16 10C16 7.79 14.21 6 12 6ZM11 16H13V18H11V16Z" fill="currentColor"/>
          </svg>
        </div>
        <span class="chat-label">AI Assistant</span>
      </button>
    {/if}
  {:else}
    <div class="chat-window" transition:slide>
      <div class="chat-header">
        <div class="header-left">
          <h3>AI Assistant</h3>
          <span class="status-indicator" class:online={!isLoading}>
            {isLoading ? '🟡' : '🟢'}
          </span>
        </div>
        <div class="header-actions">
          <button class="header-btn" on:click={() => showConversationList = !showConversationList} title="Conversations">
            📋
          </button>
          <button class="header-btn" on:click={newConversation} title="New conversation">
            ➕
          </button>
          <button class="header-btn" on:click={toggleMinimize} title="Minimize">
            ➖
          </button>
          <button class="header-btn" on:click={toggleChat} title="Close">
            ✖️
          </button>
        </div>
      </div>

      {#if showConversationList}
        <div class="conversation-list" transition:slide>
          <h4>Recent Conversations</h4>
          {#each conversations as conv}
            <button class="conversation-item" on:click={() => loadConversation(conv.id)}>
              <span class="conv-preview">{conv.last_message || 'New conversation'}</span>
              <span class="conv-time">{new Date(conv.last_message_at).toLocaleDateString()}</span>
            </button>
          {/each}
        </div>
      {/if}

      {#if !isMinimized}
        <div class="chat-messages" bind:this={chatContainer}>
          {#each messages as message}
            <div class="message {message.role}" in:fade>
              {#if message.role === 'assistant'}
                <div class="message-avatar">🤖</div>
              {/if}
              <div class="message-content {message.isStreaming ? 'streaming' : ''}">
                {@html formatMessage(message.content)}
                {#if message.isStreaming}
                  <span class="cursor-blink">▊</span>
                {/if}
              </div>
              {#if message.role === 'user'}
                <div class="message-avatar">👤</div>
              {/if}
            </div>
          {/each}
          
          {#if isTyping}
            <div class="message assistant typing" in:fade>
              <div class="message-avatar">🤖</div>
              <div class="typing-indicator">
                <span></span>
                <span></span>
                <span></span>
              </div>
            </div>
          {/if}
        </div>

        <div class="quick-actions">
          {#each quickActions as action}
            <button 
              class="quick-action-btn" 
              on:click={() => quickAction(action)}
              disabled={isLoading}
            >
              {action.label}
            </button>
          {/each}
        </div>

        <div class="chat-input">
          <textarea
            bind:value={inputMessage}
            on:keydown={handleKeyDown}
            placeholder="Ask me anything..."
            disabled={isLoading}
            rows="1"
          ></textarea>
          <button 
            on:click={sendMessage} 
            disabled={!inputMessage.trim() || isLoading}
            class="send-btn"
          >
            {#if isLoading}
              <div class="spinner"></div>
            {:else}
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                <path d="M2 21L23 12L2 3V10L17 12L2 14V21Z" fill="currentColor"/>
              </svg>
            {/if}
          </button>
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .chat-assistant {
    position: fixed;
    bottom: 20px;
    right: 20px;
    z-index: 1000;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  }

  .chat-toggle {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px 20px;
    background: var(--bg-card, #1a1a1a);
    border: 1px solid var(--border-color, #333);
    border-radius: 30px;
    color: var(--text-primary, #fff);
    cursor: pointer;
    box-shadow: 0 4px 12px rgba(0, 255, 255, 0.2);
    transition: all 0.3s ease;
    opacity: 0.9;
  }

  .chat-toggle:hover {
    transform: translateY(-2px);
    box-shadow: 0 6px 20px rgba(0, 255, 255, 0.3);
    border-color: var(--accent-color, #00ffff);
    opacity: 1;
  }
  
  /* Subtle hint dot when button is hidden */
  .chat-assistant::after {
    content: '';
    position: fixed;
    bottom: 30px;
    right: 30px;
    width: 8px;
    height: 8px;
    background: var(--accent-color, #00ffff);
    border-radius: 50%;
    opacity: 0;
    transition: opacity 0.3s ease;
    pointer-events: none;
    animation: pulse 2s ease-in-out infinite;
  }
  
  .chat-assistant:not(:has(.chat-toggle)):not(.open)::after {
    opacity: 0.4;
  }
  
  @keyframes pulse {
    0%, 100% { transform: scale(1); }
    50% { transform: scale(1.2); }
  }

  .chat-icon {
    width: 24px;
    height: 24px;
    color: var(--accent-color, #00ffff);
  }

  .chat-window {
    position: fixed;
    bottom: 20px;
    right: 20px;
    width: 400px;
    max-width: calc(100vw - 40px);
    height: 600px;
    max-height: calc(100vh - 100px);
    background: var(--bg-card, #1a1a1a);
    border: 1px solid var(--border-color, #333);
    border-radius: 16px;
    box-shadow: 0 10px 40px rgba(0, 0, 0, 0.5);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .chat-assistant.minimized .chat-window {
    height: auto;
  }

  .chat-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 16px;
    background: var(--bg-secondary, #222);
    border-bottom: 1px solid var(--border-color, #333);
  }

  .header-left {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .chat-header h3 {
    margin: 0;
    font-size: 16px;
    color: var(--text-primary, #fff);
  }

  .status-indicator {
    font-size: 10px;
  }

  .header-actions {
    display: flex;
    gap: 8px;
  }

  .header-btn {
    background: none;
    border: none;
    cursor: pointer;
    font-size: 16px;
    padding: 4px 8px;
    border-radius: 4px;
    transition: background 0.2s;
  }

  .header-btn:hover {
    background: rgba(255, 255, 255, 0.1);
  }

  .conversation-list {
    padding: 12px;
    background: var(--bg-secondary, #222);
    border-bottom: 1px solid var(--border-color, #333);
    max-height: 200px;
    overflow-y: auto;
  }

  .conversation-list h4 {
    margin: 0 0 8px 0;
    font-size: 14px;
    color: var(--text-secondary, #aaa);
  }

  .conversation-item {
    display: flex;
    justify-content: space-between;
    width: 100%;
    padding: 8px;
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid transparent;
    border-radius: 6px;
    cursor: pointer;
    margin-bottom: 4px;
    transition: all 0.2s;
  }

  .conversation-item:hover {
    background: rgba(255, 255, 255, 0.1);
    border-color: var(--accent-color, #00ffff);
  }

  .conv-preview {
    font-size: 13px;
    color: var(--text-primary, #fff);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
    text-align: left;
  }

  .conv-time {
    font-size: 11px;
    color: var(--text-secondary, #aaa);
  }

  .chat-messages {
    flex: 1;
    overflow-y: auto;
    padding: 16px;
    background: var(--bg-primary, #111);
  }

  .message {
    display: flex;
    gap: 10px;
    margin-bottom: 16px;
    align-items: flex-start;
  }

  .message.user {
    flex-direction: row-reverse;
  }

  .message-avatar {
    width: 32px;
    height: 32px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 18px;
    background: rgba(255, 255, 255, 0.1);
    flex-shrink: 0;
  }

  .message-content {
    max-width: 70%;
    padding: 10px 14px;
    border-radius: 12px;
    font-size: 14px;
    line-height: 1.5;
  }

  .message.assistant .message-content {
    background: var(--bg-card, #1a1a1a);
    color: var(--text-primary, #fff);
    border: 1px solid var(--border-color, #333);
  }

  .message.user .message-content {
    background: var(--accent-color, #00ffff);
    color: #000;
  }

  .typing-indicator {
    display: flex;
    gap: 4px;
    padding: 10px 14px;
  }

  .typing-indicator span {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--accent-color, #00ffff);
    animation: typing 1.4s infinite;
  }

  .typing-indicator span:nth-child(2) {
    animation-delay: 0.2s;
  }

  .typing-indicator span:nth-child(3) {
    animation-delay: 0.4s;
  }

  @keyframes typing {
    0%, 60%, 100% {
      opacity: 0.3;
      transform: translateY(0);
    }
    30% {
      opacity: 1;
      transform: translateY(-10px);
    }
  }

  /* Streaming message styles */
  .message-content.streaming {
    position: relative;
  }

  .cursor-blink {
    display: inline-block;
    animation: cursor-blink 1s infinite;
    color: var(--accent-color, #00ffff);
    font-weight: bold;
    margin-left: 2px;
  }

  @keyframes cursor-blink {
    0%, 50% {
      opacity: 1;
    }
    51%, 100% {
      opacity: 0;
    }
  }

  .quick-actions {
    display: flex;
    gap: 8px;
    padding: 8px 16px;
    background: var(--bg-secondary, #222);
    border-top: 1px solid var(--border-color, #333);
    overflow-x: auto;
  }

  .quick-action-btn {
    padding: 6px 12px;
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid var(--border-color, #333);
    border-radius: 16px;
    color: var(--text-primary, #fff);
    font-size: 12px;
    cursor: pointer;
    white-space: nowrap;
    transition: all 0.2s;
  }

  .quick-action-btn:hover:not(:disabled) {
    background: rgba(255, 255, 255, 0.1);
    border-color: var(--accent-color, #00ffff);
  }

  .quick-action-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .chat-input {
    display: flex;
    gap: 8px;
    padding: 16px;
    background: var(--bg-secondary, #222);
    border-top: 1px solid var(--border-color, #333);
  }

  .chat-input textarea {
    flex: 1;
    padding: 10px 14px;
    background: var(--bg-primary, #111);
    border: 1px solid var(--border-color, #333);
    border-radius: 24px;
    color: var(--text-primary, #fff);
    font-size: 14px;
    resize: none;
    outline: none;
    transition: border-color 0.2s;
    min-height: 40px;
    max-height: 100px;
  }

  .chat-input textarea:focus {
    border-color: var(--accent-color, #00ffff);
  }

  .send-btn {
    width: 40px;
    height: 40px;
    border-radius: 50%;
    background: var(--accent-color, #00ffff);
    color: #000;
    border: none;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.2s;
    flex-shrink: 0;
  }

  .send-btn:hover:not(:disabled) {
    transform: scale(1.1);
    box-shadow: 0 0 20px rgba(0, 255, 255, 0.5);
  }

  .send-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .spinner {
    width: 16px;
    height: 16px;
    border: 2px solid transparent;
    border-top-color: #000;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  /* Code highlighting */
  :global(.verification-code) {
    display: inline-block;
    padding: 2px 8px;
    background: rgba(0, 255, 255, 0.2);
    border: 1px solid var(--accent-color, #00ffff);
    border-radius: 4px;
    font-family: monospace;
    font-size: 14px;
    cursor: pointer;
    transition: all 0.2s;
  }

  :global(.verification-code:hover) {
    background: rgba(0, 255, 255, 0.3);
    transform: scale(1.05);
  }

  /* Mobile responsiveness */
  @media (max-width: 500px) {
    .chat-window {
      width: calc(100vw - 20px);
      right: 10px;
      bottom: 10px;
    }
  }
</style>