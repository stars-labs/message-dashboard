import { auth } from './auth';
import { messageCache } from './message-cache';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 
  (typeof window !== 'undefined' ? window.location.origin : 'https://sms-dashboard-api.workers.dev');

export async function fetchWithAuth(endpoint, options = {}) {
  const token = auth.token || localStorage.getItem('auth_token');
  const fullUrl = `${API_BASE_URL}${endpoint}`;

  const response = await fetch(fullUrl, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': token ? `Bearer ${token}` : '',
      ...options.headers,
    },
  });

  if (response.status === 401) {
    auth.logout();
    throw new Error('Authentication required');
  }

  if (!response.ok) {
    const errorText = await response.text();
    let errorData;
    try {
      errorData = JSON.parse(errorText);
    } catch (e) {
      errorData = { error: 'Unknown error' };
    }
    throw new Error(errorData.error || `Request failed with status ${response.status}`);
  }

  return await response.json();
}

// Route API method names to HTTP endpoints
async function apiRequest(method, data = {}) {
  const httpEndpoints = {
    'getPhones': { url: '/api/phones', method: 'GET' },
    'getMessages': { url: '/api/messages', method: 'GET' },
    'sendMessage': { url: '/api/messages/send', method: 'POST' },
    'getStats': { url: '/api/stats', method: 'GET' },
    'getUser': { url: '/api/auth/me', method: 'GET' },
    'listIccidMappings': { url: '/api/iccid-mappings', method: 'GET' },
    'getIccidMapping': { url: (params) => `/api/iccid-mappings/${params.id}`, method: 'GET' },
    'getIccidMappingByIccid': { url: (params) => `/api/iccid-mappings/by-iccid/${params.iccid}`, method: 'GET' },
    'createIccidMapping': { url: '/api/iccid-mappings', method: 'POST' },
    'updateIccidMapping': { url: (params) => `/api/iccid-mappings/${params.id}`, method: 'PUT' },
    'deleteIccidMapping': { url: (params) => `/api/iccid-mappings/${params.id}`, method: 'DELETE' }
  };
  
  const endpoint = httpEndpoints[method];
  if (!endpoint) {
    throw new Error(`Unknown API method: ${method}`);
  }
  
  const url = typeof endpoint.url === 'function' ? endpoint.url(data) : endpoint.url;
  const options = {
    method: endpoint.method
  };
  
  if (endpoint.method === 'GET' && data && Object.keys(data).length > 0) {
    // Add query params for GET requests
    const queryString = new URLSearchParams(data).toString();
    return fetchWithAuth(`${url}?${queryString}`, options);
  } else if (endpoint.method !== 'GET') {
    // Add body for non-GET requests
    options.body = JSON.stringify(data);
  }
  
  return fetchWithAuth(url, options);
}

export const api = {
  // Cache management
  cache: {
    async getStats() {
      return await messageCache.getCacheStats();
    },
    async clear() {
      return await messageCache.clearCache();
    },
    async prune(maxPerPhone = 200) {
      return await messageCache.pruneCache(maxPerPhone);
    }
  },

  // Generic HTTP methods for AI features
  async get(url, options = {}) {
    return await fetchWithAuth(url, { ...options, method: 'GET' });
  },
  
  async post(url, data = {}, options = {}) {
    return await fetchWithAuth(url, {
      ...options,
      method: 'POST',
      body: JSON.stringify(data)
    });
  },
  
  async put(url, data = {}, options = {}) {
    return await fetchWithAuth(url, {
      ...options,
      method: 'PUT',
      body: JSON.stringify(data)
    });
  },
  
  async delete(url, options = {}) {
    return await fetchWithAuth(url, { ...options, method: 'DELETE' });
  },
  
  // Auth
  async getUser() {
    try {
      return await apiRequest('getUser');
    } catch (error) {
      // Fallback to HTTP for auth (needed for initial login)
      return await fetchWithAuth('/api/auth/me');
    }
  },
  
  async logout() {
    auth.logout();
  },
  
  getAuthToken() {
    return auth.token;
  },
  
  // Phones
  async getPhones() {
    try {
      const response = await apiRequest('getPhones');
      return response.success ? response.data : [];
    } catch (error) {
      console.warn('Failed to get phones:', error);
      // Return empty array instead of throwing
      return [];
    }
  },
  
  // Messages - with client-side caching for reduced D1 reads
  async getMessages(params = {}) {
    const phoneIccid = params.phone_iccid || null;
    const cacheKey = phoneIccid || 'global';
    const forceRefresh = params.force_refresh || false;

    // Auditing view ("显示已过滤"). Bypass IndexedDB entirely — neither read nor
    // write — so spam never lands in the cache that backs the default view.
    if (params.include_filtered) {
      return await apiRequest('getMessages', params);
    }

    try {
      // Step 1: Get cached messages first for immediate display
      let cachedMessages = [];
      let lastSyncTime = null;

      if (!forceRefresh) {
        try {
          cachedMessages = await messageCache.getCachedMessages(phoneIccid, params.limit || 500);
          lastSyncTime = await messageCache.getLastSyncTime(cacheKey);
        } catch (cacheErr) {
          console.warn('[API] Cache read failed:', cacheErr);
        }
      }

      // Step 2: Fetch new messages from API (incremental if we have cache)
      const apiParams = { ...params };
      if (lastSyncTime && !forceRefresh) {
        apiParams.since = lastSyncTime;
        // Reduce limit for incremental sync since we're only getting new messages
        apiParams.limit = Math.min(params.limit || 100, 100);
      }

      const response = await apiRequest('getMessages', apiParams);

      if (response.success) {
        const newMessages = response.data || [];
        const serverTime = response.sync?.server_time || new Date().toISOString();


        // Step 3: Cache new messages
        if (newMessages.length > 0) {
          try {
            await messageCache.cacheMessages(newMessages);
            // Prune old messages to keep IndexedDB bounded
            messageCache.pruneCache(200).catch(() => {});
          } catch (cacheErr) {
            console.warn('[API] Cache write failed:', cacheErr);
          }
        }

        // Step 4: Update last sync time
        try {
          await messageCache.setLastSyncTime(cacheKey, serverTime);
        } catch (cacheErr) {
          console.warn('[API] Failed to update sync time:', cacheErr);
        }

        // Step 5: Merge new messages with cached (avoiding duplicates)
        if (response.sync?.is_incremental && cachedMessages.length > 0) {
          const existingIds = new Set(cachedMessages.map(m => m.id));
          const uniqueNewMessages = newMessages.filter(m => !existingIds.has(m.id));
          const merged = [...uniqueNewMessages, ...cachedMessages];
          // Sort by timestamp descending and limit
          merged.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
          const limitedMerged = merged.slice(0, params.limit || 500);


          return {
            success: true,
            data: limitedMerged,
            pagination: response.pagination,
            sync: { ...response.sync, from_cache: cachedMessages.length, new_count: uniqueNewMessages.length }
          };
        }

        // Full refresh - return API data directly
        return response;
      }

      // API failed - return cached data if available
      if (cachedMessages.length > 0) {
        return {
          success: true,
          data: cachedMessages,
          pagination: { limit: params.limit || 500, offset: 0, total: cachedMessages.length },
          sync: { from_cache: cachedMessages.length, is_offline: true }
        };
      }

      return { data: [], pagination: {} };
    } catch (error) {
      console.warn('Failed to get messages:', error);

      // Try to return cached data on error
      try {
        const cachedMessages = await messageCache.getCachedMessages(phoneIccid, params.limit || 500);
        if (cachedMessages.length > 0) {
          return {
            success: true,
            data: cachedMessages,
            pagination: { limit: params.limit || 500, offset: 0, total: cachedMessages.length },
            sync: { from_cache: cachedMessages.length, is_offline: true }
          };
        }
      } catch (cacheErr) {
        console.warn('[API] Cache fallback failed:', cacheErr);
      }

      return { data: [], pagination: {} };
    }
  },
  
  async sendMessage(data) {
    try {
      return await apiRequest('sendMessage', data);
    } catch (error) {
      console.warn('Failed to send message:', error);
      throw error;
    }
  },
  
  // Stats
  async getStats() {
    try {
      const response = await apiRequest('getStats');
      // Stats API returns data at root level, not under .data
      return response.success ? response : {
        total_messages: 0,
        today_messages: 0,
        total_sent: 0,
        total_received: 0,
        today_sent: 0,
        today_received: 0,
        online_devices: 0,
        total_devices: 0,
        verification_rate: 0
      };
    } catch (error) {
      console.warn('Failed to get stats:', error);
      return {
        total_messages: 0,
        today_messages: 0,
        total_sent: 0,
        total_received: 0,
        today_sent: 0,
        today_received: 0,
        online_devices: 0,
        total_devices: 0,
        verification_rate: 0
      };
    }
  },
  
  // ICCID Mappings
  iccidMappings: {
    async list(params = {}) {
      try {
        return await apiRequest('listIccidMappings', params);
      } catch (error) {
        console.warn('Failed to list ICCID mappings :', error);
        const query = new URLSearchParams(params).toString();
        return await fetchWithAuth(`/api/iccid-mappings?${query}`);
      }
    },
    
    async get(id) {
      try {
        return await apiRequest('getIccidMapping', { id });
      } catch (error) {
        console.warn('Failed to get ICCID mapping :', error);
        return await fetchWithAuth(`/api/iccid-mappings/${id}`);
      }
    },
    
    async getByIccid(iccid) {
      try {
        return await apiRequest('getIccidMappingByIccid', { iccid });
      } catch (error) {
        console.warn('Failed to get ICCID mapping by ICCID :', error);
        return await fetchWithAuth(`/api/iccid-mappings/by-iccid/${iccid}`);
      }
    },
    
    async create(data) {
      try {
        return await apiRequest('createIccidMapping', data);
      } catch (error) {
        console.warn('Failed to create ICCID mapping :', error);
        return await fetchWithAuth('/api/iccid-mappings', {
          method: 'POST',
          body: JSON.stringify(data),
        });
      }
    },
    
    async update(id, data) {
      try {
        return await apiRequest('updateIccidMapping', { id, ...data });
      } catch (error) {
        console.warn('Failed to update ICCID mapping :', error);
        return await fetchWithAuth(`/api/iccid-mappings/${id}`, {
          method: 'PUT',
          body: JSON.stringify(data),
        });
      }
    },
    
    async delete(id) {
      try {
        return await apiRequest('deleteIccidMapping', { id });
      } catch (error) {
        console.warn('Failed to delete ICCID mapping :', error);
        return await fetchWithAuth(`/api/iccid-mappings/${id}`, {
          method: 'DELETE',
        });
      }
    },
    
    async bulkImport(data) {
      try {
        return await apiRequest('bulkImportIccidMappings', data);
      } catch (error) {
        console.warn('Failed to bulk import ICCID mappings :', error);
        return await fetchWithAuth('/api/iccid-mappings/bulk', {
          method: 'POST',
          body: JSON.stringify(data),
        });
      }
    }
  }
};

// Check for auth token in URL on page load
if (typeof window !== 'undefined') {
  const urlParams = new URLSearchParams(window.location.search);
  const token = urlParams.get('token');
  
  if (token) {
    localStorage.setItem('auth_token', token);
    window.history.replaceState({}, document.title, window.location.pathname);
  }
}