import { auth } from './auth';
import { realtimeService } from './websocket-with-fallback';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 
  (typeof window !== 'undefined' ? window.location.origin : 'https://sms-dashboard-api.workers.dev');

export async function fetchWithAuth(endpoint, options = {}) {
  const token = auth.token || localStorage.getItem('auth_token');
  
  const response = await fetch(`${API_BASE_URL}${endpoint}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': token ? `Bearer ${token}` : '',
      ...options.headers,
    },
  });
  
  if (response.status === 401) {
    // Token expired or invalid, redirect to login
    auth.logout();
    throw new Error('Authentication required');
  }
  
  // Check if response is ok before parsing JSON
  if (!response.ok) {
    const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(errorData.error || `Request failed with status ${response.status}`);
  }
  
  return response.json();
}

// WebSocket-first API with HTTP fallback
async function apiRequest(method, data = {}) {
  // Try WebSocket first
  if (realtimeService.isConnected() && realtimeService.getConnectionType() === 'websocket') {
    try {
      return await realtimeService.request(method, data);
    } catch (error) {
      console.warn(`WebSocket ${method} failed, falling back to HTTP:`, error);
    }
  }
  
  // Fallback to HTTP
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
  
  if (endpoint.method === 'GET' && data && Object.keys(data).length > 0 && !url.includes('/')) {
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
  
  // Messages
  async getMessages(params = {}) {
    try {
      const response = await apiRequest('getMessages', params);
      return response.success ? response : { data: [], pagination: {} };
    } catch (error) {
      console.warn('Failed to get messages via WebSocket, using empty array:', error);
      return { data: [], pagination: {} };
    }
  },
  
  async sendMessage(data) {
    try {
      return await apiRequest('sendMessage', data);
    } catch (error) {
      console.warn('Failed to send message via WebSocket:', error);
      // For message sending, we'll prefer WebSocket and show error if it fails
      throw error;
    }
  },
  
  // Stats
  async getStats() {
    try {
      const response = await apiRequest('getStats');
      return response.success ? response.data : {
        total_messages: 0,
        today_messages: 0,
        online_devices: 0,
        total_devices: 0,
        verification_rate: 0
      };
    } catch (error) {
      console.warn('Failed to get stats via WebSocket, using default values:', error);
      return {
        total_messages: 0,
        today_messages: 0,
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
        console.warn('Failed to list ICCID mappings via WebSocket, using HTTP fallback:', error);
        const query = new URLSearchParams(params).toString();
        return await fetchWithAuth(`/api/iccid-mappings?${query}`);
      }
    },
    
    async get(id) {
      try {
        return await apiRequest('getIccidMapping', { id });
      } catch (error) {
        console.warn('Failed to get ICCID mapping via WebSocket, using HTTP fallback:', error);
        return await fetchWithAuth(`/api/iccid-mappings/${id}`);
      }
    },
    
    async getByIccid(iccid) {
      try {
        return await apiRequest('getIccidMappingByIccid', { iccid });
      } catch (error) {
        console.warn('Failed to get ICCID mapping by ICCID via WebSocket, using HTTP fallback:', error);
        return await fetchWithAuth(`/api/iccid-mappings/by-iccid/${iccid}`);
      }
    },
    
    async create(data) {
      try {
        return await apiRequest('createIccidMapping', data);
      } catch (error) {
        console.warn('Failed to create ICCID mapping via WebSocket, using HTTP fallback:', error);
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
        console.warn('Failed to update ICCID mapping via WebSocket, using HTTP fallback:', error);
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
        console.warn('Failed to delete ICCID mapping via WebSocket, using HTTP fallback:', error);
        return await fetchWithAuth(`/api/iccid-mappings/${id}`, {
          method: 'DELETE',
        });
      }
    },
    
    async bulkImport(data) {
      try {
        return await apiRequest('bulkImportIccidMappings', data);
      } catch (error) {
        console.warn('Failed to bulk import ICCID mappings via WebSocket, using HTTP fallback:', error);
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