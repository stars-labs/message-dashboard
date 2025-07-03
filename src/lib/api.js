const API_BASE_URL = import.meta.env.VITE_API_URL || 'https://sms-dashboard-api.workers.dev';

export async function fetchWithAuth(endpoint, options = {}) {
  const token = localStorage.getItem('auth_token');
  
  const response = await fetch(`${API_BASE_URL}${endpoint}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': token ? `Bearer ${token}` : '',
      ...options.headers,
    },
  });
  
  if (response.status === 401) {
    // Redirect to login
    window.location.href = `${API_BASE_URL}/api/auth/login`;
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
    await fetchWithAuth('/api/auth/logout', { method: 'POST' });
    localStorage.removeItem('auth_token');
    window.location.href = '/';
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