import { auth } from './auth';

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
    return;
  }
  
  return response.json();
}

export const api = {
  // Auth
  async getUser() {
    return fetchWithAuth('/api/auth/me');
  },
  
  async logout() {
    auth.logout();
  },
  
  getAuthToken() {
    return auth.token;
  },
  
  // Phones
  async getPhones() {
    const response = await fetchWithAuth('/api/phones');
    return response.success ? response.data : [];
  },
  
  // Messages
  async getMessages(params = {}) {
    const query = new URLSearchParams(params).toString();
    const response = await fetchWithAuth(`/api/messages?${query}`);
    return response.success ? response : { data: [], pagination: {} };
  },
  
  async sendMessage(data) {
    return fetchWithAuth('/api/messages/send', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },
  
  // Stats
  async getStats() {
    const response = await fetchWithAuth('/api/stats');
    return response.success ? response.data : {
      total_messages: 0,
      today_messages: 0,
      online_devices: 0,
      total_devices: 0,
      verification_rate: 0
    };
  },
  
  // ICCID Mappings
  iccidMappings: {
    async list(params = {}) {
      const query = new URLSearchParams(params).toString();
      return fetchWithAuth(`/api/iccid-mappings?${query}`);
    },
    
    async get(id) {
      return fetchWithAuth(`/api/iccid-mappings/${id}`);
    },
    
    async getByIccid(iccid) {
      return fetchWithAuth(`/api/iccid-mappings/by-iccid/${iccid}`);
    },
    
    async create(data) {
      return fetchWithAuth('/api/iccid-mappings', {
        method: 'POST',
        body: JSON.stringify(data),
      });
    },
    
    async update(id, data) {
      return fetchWithAuth(`/api/iccid-mappings/${id}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      });
    },
    
    async delete(id) {
      return fetchWithAuth(`/api/iccid-mappings/${id}`, {
        method: 'DELETE',
      });
    },
    
    async bulkImport(data) {
      return fetchWithAuth('/api/iccid-mappings/bulk', {
        method: 'POST',
        body: JSON.stringify(data),
      });
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