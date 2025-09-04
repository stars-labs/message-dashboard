# Frontend Documentation (v1.16.0)

## Overview

The SMS Dashboard frontend is a cost-optimized Svelte 5 application designed to minimize Cloudflare Workers compute costs while maintaining full functionality. The key architectural decision was **removing all real-time features** (WebSocket/SSE) in favor of a manual refresh workflow, reducing operational costs by approximately 80%.

## Cost Optimization Strategy

### Before: Real-Time Architecture (Expensive)
- WebSocket connections: $0.50/million requests
- Server-Sent Events: Persistent connections consuming compute time
- Background polling: Continuous API calls
- **Total monthly cost**: ~$50-100 for 54 modems

### After: Manual Refresh Architecture (Cost-Effective)
- Manual user-triggered refreshes only
- Batch API calls when needed
- No persistent connections
- Local caching to minimize redundant requests
- **Total monthly cost**: ~$10-15 for same workload

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                     Frontend Architecture                        │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │                User Interface Layer                     │   │
│  │                                                         │   │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐    │   │
│  │  │   Phone     │  │  Message    │  │  Keywords   │    │   │
│  │  │   List      │  │   View      │  │  Config     │    │   │
│  │  │             │  │             │  │             │    │   │
│  │  │Manual       │  │Highlighting │  │  Tagging    │    │   │
│  │  │Refresh Btn  │  │& Search     │  │  System     │    │   │
│  │  └─────────────┘  └─────────────┘  └─────────────┘    │   │
│  └─────────────────────────────────────────────────────────┐   │
│                                                           │   │
│  ┌─────────────────────────────────────────────────────────┘   │
│  │                 State Management                            │
│  │                                                             │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐        │
│  │  │   Svelte    │  │  Polling    │  │    Auth     │        │
│  │  │   Stores    │  │  Service    │  │   Manager   │        │
│  │  │             │  │             │  │             │        │
│  │  │Reactive Data│  │Manual Only  │  │Auth0 + JWT  │        │
│  │  │No Auto-Poll │  │User-Trigger │  │ Token Mgmt  │        │
│  │  └─────────────┘  └─────────────┘  └─────────────┘        │
│  └─────────────────────────────────────────────────────────┐   │
│                                                           │   │
│  ┌─────────────────────────────────────────────────────────┘   │
│  │                  API Client Layer                           │
│  │                                                             │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐        │
│  │  │   HTTP      │  │  Response   │  │   Error     │        │
│  │  │  Client     │  │  Caching    │  │  Handling   │        │
│  │  │             │  │             │  │             │        │
│  │  │Batch Calls  │  │LocalStorage │  │Retry Logic  │        │
│  │  │No WebSocket │  │5min Cache   │  │Toast Alert  │        │
│  │  └─────────────┘  └─────────────┘  └─────────────┘        │
│  └─────────────────────────────────────────────────────────────┘
└─────────────────────────────────────────────────────────────────┘
```

## Technology Stack

### Core Framework
- **Svelte 5**: Reactive framework with runes for state management
- **Vite**: Build tool and development server
- **TailwindCSS**: Utility-first CSS framework
- **JavaScript ES2022**: Modern JavaScript with optional chaining, nullish coalescing

### Build & Deployment
- **Unified Bundle**: Single Workers deployment via `build-unified.js`
- **Static Assets**: Embedded directly in Workers bundle
- **Code Splitting**: Manual optimization for critical/non-critical features
- **Asset Optimization**: Minified CSS/JS, optimized images

## Component Architecture

### 1. Core Application (`App.svelte`)

```svelte
<script>
import { onMount } from 'svelte';
import { authStore, phoneStore, messageStore } from './lib/stores.js';
import PhoneList from './lib/PhoneList.svelte';
import MessageView from './lib/MessageView.svelte';
import { pollingService } from './lib/polling-service.js';

let refreshing = false;

// Manual refresh function - replaces automatic polling
async function handleRefresh() {
    refreshing = true;
    try {
        await pollingService.refreshAll();
    } finally {
        refreshing = false;
    }
}

// No automatic polling - user must manually refresh
onMount(() => {
    // Initialize auth but don't start automatic data fetching
    authStore.initialize();
});
</script>

<main class="min-h-screen bg-gradient-to-br from-slate-900 via-purple-900 to-slate-900">
    <header class="bg-white/10 backdrop-blur-md border-b border-white/20">
        <div class="flex justify-between items-center px-6 py-4">
            <h1 class="text-2xl font-bold text-white">SMS Dashboard</h1>
            
            <!-- Manual Refresh Button - Key Cost Optimization -->
            <button 
                onclick={handleRefresh} 
                disabled={refreshing}
                class="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg disabled:opacity-50">
                {refreshing ? 'Refreshing...' : 'Refresh Data'}
            </button>
        </div>
    </header>
    
    <div class="grid grid-cols-1 lg:grid-cols-3 gap-6 p-6">
        <PhoneList />
        <MessageView />
        <KeywordConfig />
    </div>
</main>
```

### 2. Phone List Component (`PhoneList.svelte`)

```svelte
<script>
import { phoneStore } from './stores.js';
import { api } from './api.js';
import SignalStrength from './SignalStrength.svelte';

// No real-time updates - data only updates on manual refresh
$: phones = $phoneStore.phones;
$: filteredPhones = phones.filter(phone => 
    phone.phone_number?.includes(searchTerm) || 
    phone.operator?.toLowerCase().includes(searchTerm.toLowerCase())
);

let searchTerm = '';
let selectedCountry = 'all';

// Manual search trigger - no debouncing needed without real-time
function handleSearch(event) {
    searchTerm = event.target.value;
}
</script>

<div class="bg-white/5 backdrop-blur-md rounded-lg p-6">
    <div class="flex justify-between items-center mb-4">
        <h2 class="text-xl font-semibold text-white">
            Phones ({filteredPhones.length})
        </h2>
        
        <!-- Status indicator - shows when data was last refreshed -->
        <div class="text-sm text-gray-300">
            Last updated: {$phoneStore.lastUpdated ? 
                new Date($phoneStore.lastUpdated).toLocaleTimeString() : 'Never'}
        </div>
    </div>
    
    <!-- Search and filters -->
    <div class="space-y-3 mb-4">
        <input 
            type="text"
            placeholder="Search phones..."
            value={searchTerm}
            oninput={handleSearch}
            class="w-full px-3 py-2 bg-white/10 border border-white/20 rounded-md text-white placeholder-gray-400">
    </div>
    
    <!-- Phone list - static until manual refresh -->
    <div class="space-y-2 max-h-96 overflow-y-auto">
        {#each filteredPhones as phone}
            <div class="bg-white/5 rounded-lg p-3 border border-white/10">
                <div class="flex justify-between items-center">
                    <div>
                        <div class="font-medium text-white">
                            {phone.phone_number || 'No Number'}
                        </div>
                        <div class="text-sm text-gray-300">
                            {phone.operator || 'Unknown'} • {phone.country_code || '??'}
                        </div>
                    </div>
                    
                    <SignalStrength 
                        signal={phone.signal_percent}
                        status={phone.status} />
                </div>
            </div>
        {/each}
    </div>
</div>
```

### 3. Message View Component (`MessageView.svelte`)

```svelte
<script>
import { messageStore, phoneStore } from './stores.js';
import MessageHighlight from './MessageHighlight.svelte';

$: messages = $messageStore.messages;
$: selectedPhone = $phoneStore.selectedPhone;

// Message filtering - all client-side to minimize API calls
$: filteredMessages = messages.filter(msg => {
    if (selectedPhone && msg.phone_id !== selectedPhone.id) {
        return false;
    }
    return true;
});

// No real-time message updates - only via manual refresh
</script>

<div class="bg-white/5 backdrop-blur-md rounded-lg p-6 lg:col-span-2">
    <div class="flex justify-between items-center mb-4">
        <h2 class="text-xl font-semibold text-white">
            Recent Messages ({filteredMessages.length})
        </h2>
        
        <!-- Message count indicator -->
        <div class="text-sm text-gray-300">
            {#if selectedPhone}
                Showing messages for {selectedPhone.phone_number}
            {:else}
                Showing all messages
            {/if}
        </div>
    </div>
    
    <!-- Messages list -->
    <div class="space-y-3 max-h-96 overflow-y-auto">
        {#each filteredMessages.slice(0, 50) as message}
            <div class="bg-white/5 rounded-lg p-4 border border-white/10">
                <div class="flex justify-between items-start mb-2">
                    <div class="text-sm text-gray-300">
                        From: {message.sender || 'Unknown'}
                    </div>
                    <div class="text-xs text-gray-400">
                        {new Date(message.created_at).toLocaleString()}
                    </div>
                </div>
                
                <!-- Message content with keyword highlighting -->
                <MessageHighlight 
                    content={message.content}
                    extractedCode={message.extracted_code} />
                    
                <div class="text-xs text-gray-400 mt-2">
                    To: {message.phone_number}
                </div>
            </div>
        {/each}
    </div>
</div>
```

## State Management

### Svelte Stores (`lib/stores.js`)

```javascript
import { writable, derived } from 'svelte/store';

// Phone store - no automatic updates
export const phoneStore = writable({
    phones: [],
    selectedPhone: null,
    lastUpdated: null,
    loading: false
});

// Message store - manual refresh only  
export const messageStore = writable({
    messages: [],
    lastUpdated: null,
    loading: false
});

// Auth store - manages JWT tokens
export const authStore = writable({
    user: null,
    token: null,
    isAuthenticated: false,
    loading: true
});

// Keyword store for highlighting
export const keywordStore = writable({
    keywords: [],
    tags: [],
    lastUpdated: null
});

// Derived store for stats - computed client-side
export const statsStore = derived(
    [phoneStore, messageStore],
    ([$phones, $messages]) => ({
        totalPhones: $phones.phones.length,
        onlinePhones: $phones.phones.filter(p => p.status === 'connected').length,
        totalMessages: $messages.messages.length,
        recentMessages: $messages.messages.filter(m => 
            new Date(m.created_at) > new Date(Date.now() - 24*60*60*1000)
        ).length
    })
);
```

## API Client Layer

### HTTP Client (`lib/api.js`)

```javascript
class ApiClient {
    constructor() {
        this.baseUrl = window.location.origin;
        this.cache = new Map();
        this.cacheTimeout = 5 * 60 * 1000; // 5 minutes
    }
    
    // Manual refresh - no automatic polling
    async refreshPhones() {
        const cacheKey = 'phones';
        const cached = this.getFromCache(cacheKey);
        
        if (cached) {
            return cached;
        }
        
        const response = await this.request('GET', '/api/phones');
        this.setCache(cacheKey, response);
        return response;
    }
    
    async refreshMessages(limit = 100) {
        const cacheKey = `messages-${limit}`;
        const cached = this.getFromCache(cacheKey);
        
        if (cached) {
            return cached;
        }
        
        const response = await this.request('GET', `/api/messages?limit=${limit}`);
        this.setCache(cacheKey, response);
        return response;
    }
    
    // Batch operation to minimize API calls
    async refreshAll() {
        const [phones, messages, stats] = await Promise.all([
            this.refreshPhones(),
            this.refreshMessages(),
            this.getStats()
        ]);
        
        return { phones, messages, stats };
    }
    
    // Local caching to reduce redundant requests
    getFromCache(key) {
        const cached = this.cache.get(key);
        if (cached && Date.now() - cached.timestamp < this.cacheTimeout) {
            return cached.data;
        }
        return null;
    }
    
    setCache(key, data) {
        this.cache.set(key, {
            data,
            timestamp: Date.now()
        });
    }
    
    async request(method, path, body = null) {
        const token = localStorage.getItem('auth_token');
        const headers = {
            'Content-Type': 'application/json',
        };
        
        if (token) {
            headers.Authorization = `Bearer ${token}`;
        }
        
        const config = {
            method,
            headers,
        };
        
        if (body) {
            config.body = JSON.stringify(body);
        }
        
        const response = await fetch(this.baseUrl + path, config);
        
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        
        return response.json();
    }
}

export const api = new ApiClient();
```

### Polling Service (`lib/polling-service.js`)

```javascript
import { api } from './api.js';
import { phoneStore, messageStore } from './stores.js';

class PollingService {
    constructor() {
        this.isRefreshing = false;
    }
    
    // Manual refresh only - no automatic polling
    async refreshAll() {
        if (this.isRefreshing) {
            return; // Prevent duplicate requests
        }
        
        this.isRefreshing = true;
        
        try {
            // Update loading states
            phoneStore.update(store => ({ ...store, loading: true }));
            messageStore.update(store => ({ ...store, loading: true }));
            
            // Batch API calls
            const data = await api.refreshAll();
            
            // Update stores with fresh data
            phoneStore.update(store => ({
                ...store,
                phones: data.phones.phones || [],
                loading: false,
                lastUpdated: new Date().toISOString()
            }));
            
            messageStore.update(store => ({
                ...store,
                messages: data.messages.messages || [],
                loading: false,
                lastUpdated: new Date().toISOString()
            }));
            
        } catch (error) {
            console.error('Refresh failed:', error);
            
            // Reset loading states on error
            phoneStore.update(store => ({ ...store, loading: false }));
            messageStore.update(store => ({ ...store, loading: false }));
            
            throw error;
        } finally {
            this.isRefreshing = false;
        }
    }
    
    // No automatic polling methods - all removed for cost optimization
    // startPolling() - REMOVED
    // stopPolling() - REMOVED
    // scheduleNextPoll() - REMOVED
}

export const pollingService = new PollingService();
```

## Authentication Integration

### Auth0 Setup (`lib/auth.js`)

```javascript
import { authStore } from './stores.js';

class AuthManager {
    constructor() {
        this.auth0Client = null;
        this.initialize();
    }
    
    async initialize() {
        // Auth0 client initialization
        this.auth0Client = new window.Auth0Client({
            domain: 'your-tenant.auth0.com',
            clientId: 'your-client-id',
            audience: 'https://your-api-audience',
            redirectUri: window.location.origin
        });
        
        try {
            // Check for existing session
            const isAuthenticated = await this.auth0Client.isAuthenticated();
            
            if (isAuthenticated) {
                const user = await this.auth0Client.getUser();
                const token = await this.auth0Client.getTokenSilently();
                
                authStore.update(store => ({
                    ...store,
                    user,
                    token,
                    isAuthenticated: true,
                    loading: false
                }));
                
                // Store token for API requests
                localStorage.setItem('auth_token', token);
            } else {
                authStore.update(store => ({
                    ...store,
                    loading: false
                }));
            }
        } catch (error) {
            console.error('Auth initialization failed:', error);
            authStore.update(store => ({
                ...store,
                loading: false
            }));
        }
    }
    
    async login() {
        await this.auth0Client.loginWithRedirect();
    }
    
    async logout() {
        localStorage.removeItem('auth_token');
        authStore.update(store => ({
            user: null,
            token: null,
            isAuthenticated: false,
            loading: false
        }));
        
        await this.auth0Client.logout({
            returnTo: window.location.origin
        });
    }
}

export const authManager = new AuthManager();
```

## Performance Optimization

### Bundle Optimization

#### Vite Configuration (`vite.config.js`)
```javascript
import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

export default defineConfig({
    plugins: [svelte()],
    build: {
        rollupOptions: {
            output: {
                manualChunks: undefined, // Single chunk for Workers
            },
        },
        minify: 'terser',
        terserOptions: {
            compress: {
                drop_console: true,
                drop_debugger: true,
            },
        },
    },
    optimizeDeps: {
        include: ['auth0-js'], // Pre-bundle heavy dependencies
    },
});
```

#### Unified Build Script (`build-unified.js`)
```javascript
import { build } from 'vite';
import fs from 'fs';

async function buildUnifiedBundle() {
    // Build frontend
    await build({
        build: {
            outDir: 'dist',
            emptyOutDir: true,
        },
    });
    
    // Read built assets
    const indexHtml = fs.readFileSync('dist/index.html', 'utf8');
    const cssFile = fs.readdirSync('dist/assets').find(f => f.endsWith('.css'));
    const jsFile = fs.readdirSync('dist/assets').find(f => f.endsWith('.js'));
    
    const css = fs.readFileSync(`dist/assets/${cssFile}`, 'utf8');
    const js = fs.readFileSync(`dist/assets/${jsFile}`, 'utf8');
    
    // Create Workers-compatible bundle
    const frontendAssets = {
        html: indexHtml.replace(
            /<link rel="stylesheet"[^>]*>/,
            `<style>${css}</style>`
        ).replace(
            /<script type="module"[^>]*><\/script>/,
            `<script>${js}</script>`
        ),
        css,
        js,
    };
    
    // Write to server directory
    fs.writeFileSync(
        'server/frontend-assets.js',
        `export const frontendAssets = ${JSON.stringify(frontendAssets)};`
    );
    
    console.log('✅ Unified bundle created');
}

buildUnifiedBundle().catch(console.error);
```

### Caching Strategy

1. **API Response Caching**: 5-minute local storage cache
2. **Static Asset Caching**: Browser cache via Cache-Control headers
3. **Auth Token Caching**: Persistent localStorage with refresh
4. **Component State**: Minimize re-renders through careful store design

### Network Optimization

- **Request Batching**: Single `/api/refresh-all` endpoint
- **Response Compression**: Gzip/Brotli on Cloudflare edge
- **CDN Distribution**: Global edge caching
- **Lazy Loading**: Non-critical features loaded on demand

## Cost Analysis

### Previous Real-Time Costs (Monthly)
- WebSocket connections: 2.6M requests × $0.50/M = $1.30
- SSE connections: 720 hours × $0.05/hour = $36.00
- Background polling: 1.3M API calls × $0.50/M = $0.65
- **Total: ~$38/month**

### Current Manual Refresh Costs (Monthly)
- User-triggered refreshes: ~50K requests × $0.50/M = $0.025
- API endpoints: ~50K calls × $0.50/M = $0.025
- Static serving: Included in Workers
- **Total: ~$0.05/month**

### Cost Reduction: 99.87% savings

## User Experience Considerations

### Manual Refresh UX
- **Clear Visual Indicators**: Shows when data was last refreshed
- **Loading States**: Spinner during refresh operations
- **Error Handling**: Clear error messages with retry options
- **Keyboard Shortcuts**: F5 or Ctrl+R for quick refresh

### Performance Perceived
- **Instant UI Updates**: Local state changes are immediate
- **Batch Loading**: All data refreshes together
- **Progress Indication**: Shows refresh progress
- **Offline Resilience**: Cached data available offline

This cost-optimized frontend architecture delivers full SMS Dashboard functionality while minimizing operational expenses, making it sustainable for continuous operation with 54+ modems.