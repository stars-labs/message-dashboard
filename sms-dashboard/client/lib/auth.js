// Client-side auth state.
//
// There is deliberately no token here. The session credential is an HttpOnly `auth_token`
// cookie set by the login callback, which JavaScript cannot read and the browser attaches
// automatically to same-origin requests. Previously the token was passed to the SPA in a
// redirect URL query parameter and kept in localStorage, which leaked a live 24-hour
// credential via the Referer header, browser history and Workers request logs.
// See docs/SECURITY-REVIEW.md finding 4.
//
// Authentication state is therefore whether /api/auth/me answers, not whether a string
// exists on the client.
class Auth0Service {
  constructor() {
    this.baseUrl = import.meta.env.VITE_API_BASE_URL ||
      (typeof window !== 'undefined' ? window.location.origin : '');
    this.user = null;
  }

  async login() {
    // Use replace to prevent back button issues
    window.location.replace(`${this.baseUrl}/login`);
  }

  async logout() {
    this.user = null;
    // The server clears the cookie and deletes the KV session, then redirects to Auth0.
    window.location.href = `${this.baseUrl}/logout`;
  }

  async getUser() {
    try {
      const response = await fetch(`${this.baseUrl}/api/auth/me`, {
        credentials: 'same-origin'
      });

      if (response.ok) {
        const data = await response.json();
        this.user = data.user;
        return this.user;
      }

      // 401/403 — no usable session.
      this.user = null;
      if (response.status === 401 || response.status === 403) return null;
      // Any other status is the server failing, not the user being signed out.
      // Returning null here sent an operator to the login screen during an
      // outage, where logging in bounced straight back.
      throw new Error(`身份服务返回 ${response.status}`);
    } catch (error) {
      this.user = null;
      throw error;
    }
  }

  isAuthenticated() {
    return !!this.user;
  }

  // Helper method to make authenticated API calls
  async authenticatedFetch(url, options = {}) {
    const response = await fetch(url, {
      ...options,
      credentials: 'same-origin'
    });

    if (response.status === 401) {
      this.logout();
      throw new Error('Authentication required');
    }

    return response;
  }
}

export const auth = new Auth0Service();
