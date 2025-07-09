class Auth0Service {
  constructor() {
    this.baseUrl = import.meta.env.VITE_API_BASE_URL || 
      (typeof window !== 'undefined' ? window.location.origin : '');
    this.token = localStorage.getItem('auth_token');
    this.user = null;
  }

  async login() {
    window.location.href = `${this.baseUrl}/api/auth/login`;
  }

  async handleCallback() {
    const params = new URLSearchParams(window.location.search);
    const token = params.get('token');
    
    if (token) {
      this.token = token;
      localStorage.setItem('auth_token', token);
      
      // Clean up URL
      window.history.replaceState({}, document.title, window.location.pathname);
      
      // Get user info
      await this.getUser();
      
      return true;
    }
    
    return false;
  }

  async logout() {
    this.token = null;
    this.user = null;
    localStorage.removeItem('auth_token');
    
    // Redirect to Auth0 logout
    window.location.href = `${this.baseUrl}/api/auth/logout`;
  }

  async getUser() {
    if (!this.token) {
      return null;
    }

    try {
      const response = await fetch(`${this.baseUrl}/api/auth/me`, {
        headers: {
          'Authorization': `Bearer ${this.token}`
        }
      });

      if (response.ok) {
        const data = await response.json();
        this.user = data.user;
        return this.user;
      } else if (response.status === 401) {
        // Token expired or invalid
        this.token = null;
        localStorage.removeItem('auth_token');
        return null;
      }
    } catch (error) {
      console.error('Failed to get user:', error);
      return null;
    }
  }

  isAuthenticated() {
    return !!this.token;
  }

  getAuthHeaders() {
    if (!this.token) {
      return {};
    }
    
    return {
      'Authorization': `Bearer ${this.token}`
    };
  }

  // Helper method to make authenticated API calls
  async authenticatedFetch(url, options = {}) {
    const headers = {
      ...options.headers,
      ...this.getAuthHeaders()
    };

    const response = await fetch(url, {
      ...options,
      headers
    });

    if (response.status === 401) {
      // Token expired, redirect to login
      this.logout();
      throw new Error('Authentication required');
    }

    return response;
  }
}

export const auth = new Auth0Service();