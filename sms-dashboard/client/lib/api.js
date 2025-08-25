import { auth } from './auth';
import { pollingService } from './polling-service';
import { trackApiError, addBreadcrumb, startSpan } from './sentry-utils';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 
  (typeof window !== 'undefined' ? window.location.origin : 'https://sms-dashboard-api.workers.dev');

export async function fetchWithAuth(endpoint, options = {}) {
  const token = auth.token || localStorage.getItem('auth_token');
  const fullUrl = `${API_BASE_URL}${endpoint}`;
  
  // Start performance tracking
  let span = null;
  try {
    span = startSpan(`api.${options.method || 'GET'} ${endpoint}`, 'http.client');
  } catch (e) {
    // Sentry span might not be available in all contexts
  }
  
  // Add breadcrumb for API call
  addBreadcrumb(`API ${options.method || 'GET'} ${endpoint}`, 'api', {
    url: fullUrl,
    method: options.method || 'GET'
  });
  
  console.debug(`[fetchWithAuth] Making request to: ${fullUrl}`);
  console.debug(`[fetchWithAuth] Options:`, options);
  console.debug(`[fetchWithAuth] Token present:`, !!token);
  
  try {
    const response = await fetch(fullUrl, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': token ? `Bearer ${token}` : '',
        ...options.headers,
      },
    });
    
    console.debug(`[fetchWithAuth] Response status: ${response.status}`);
    console.debug(`[fetchWithAuth] Response headers:`, Object.fromEntries(response.headers.entries()));
    
    if (response.status === 401) {
      console.log(`[fetchWithAuth] 401 Unauthorized - logging out`);
      // Track authentication error
      trackApiError(endpoint, 401, { error: 'Authentication required' }, options.body);
      // Token expired or invalid, redirect to login
      auth.logout();
      throw new Error('Authentication required');
    }
    
    // Check if response is ok before parsing JSON
    if (!response.ok) {
      const errorText = await response.text();
      console.debug(`[fetchWithAuth] Error response text:`, errorText);
      let errorData;
      try {
        errorData = JSON.parse(errorText);
      } catch (e) {
        errorData = { error: 'Unknown error' };
      }
      
      // Track API error
      trackApiError(endpoint, response.status, errorData, options.body);
      
      throw new Error(errorData.error || `Request failed with status ${response.status}`);
    }
    
    const responseData = await response.json();
    console.debug(`[fetchWithAuth] Response data:`, responseData);
    
    // Finish span successfully
    if (span && typeof span.end === 'function') {
      span.end();
    }
    
    return responseData;
  } catch (error) {
    // Finish span with error
    if (span && typeof span.end === 'function') {
      span.end();
    }
    
    // Track network errors
    if (error.message.includes('Failed to fetch') || error.message.includes('NetworkError')) {
      trackApiError(endpoint, 0, { error: 'Network error', message: error.message }, options.body);
    }
    
    throw error;
  }
}

// Polling-based API with HTTP fallback
async function apiRequest(method, data = {}) {
  // For polling service, we don't use request-response pattern
  // All communication is HTTP-based, so skip the polling service request attempt
  
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
        total_sent: 0,
        total_received: 0,
        today_sent: 0,
        today_received: 0,
        online_devices: 0,
        total_devices: 0,
        verification_rate: 0
      };
    } catch (error) {
      console.warn('Failed to get stats via WebSocket, using default values:', error);
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