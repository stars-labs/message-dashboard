# Component Communication Architecture

## Current Anti-Pattern (AVOID)
```
MessageView ←→ MessageHighlight
     ↕
  messageTags Map (shared mutable state)
```

## Recommended Pattern (USE THIS)
```
MessageView → TagStore ← MessageHighlight
     ↓            ↓
  Subscribe    Subscribe
   to Tags      to Tags
```

## Implementation Guidelines

### 1. Parent Component (MessageView)
- **Responsibility**: Coordinate batch operations and display
- **Communication**: Subscribe to store, trigger batch loads
- **State**: Local UI state only (filters, sorting, etc.)

```javascript
// MessageView.svelte pattern
import { tagActions, messageTags } from './tag-store.js';

// Subscribe to centralized state
$: currentTags = $messageTags;

// Trigger batch operations
async function handleMessagesChanged(newMessages) {
  const messageIds = newMessages.map(m => m.id);
  await tagActions.batchLoadTags(messageIds);
}
```

### 2. Child Component (MessageHighlight)
- **Responsibility**: Display highlighting and handle individual fallbacks
- **Communication**: Subscribe to store, emit events upward
- **State**: No shared state management

```javascript
// MessageHighlight.svelte pattern  
import { tagService, keywords } from './tag-store.js';

// Subscribe to keywords (loaded once globally)
$: currentKeywords = $keywords;

// Fallback for individual messages
async function handleFallback(messageId, content) {
  return tagService.extractClientTags(messageId, content, currentKeywords);
}
```

### 3. Event Communication
- **Upward**: Events for user actions (click, select, etc.)
- **Downward**: Props for display data only
- **Sideways**: Store subscriptions for shared state

## Benefits
- ✅ **Single Source of Truth**: All tag state in one place
- ✅ **Testability**: Each component can be tested in isolation
- ✅ **Maintainability**: Changes to tag logic only affect store
- ✅ **Scalability**: Easy to add new tag consumers
- ✅ **Performance**: Prevents duplicate API calls and reactive loops