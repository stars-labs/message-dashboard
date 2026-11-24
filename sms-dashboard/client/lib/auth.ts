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

import { ORPCError } from '@orpc/client';
import { ValidationError } from '@orpc/contract';
import { textOr } from '../../shared/text.js';
import type { MeResponse } from '../../shared/api/auth.js';
import { contractClient } from './contract-link.js';

/** The user the server returns from /api/auth/me. */
type AuthUser = MeResponse['user'];

class Auth0Service {
  baseUrl: string;
  user: AuthUser | null;

  // Not contractApi: that one signs the user out on a 401, which here only means
  // there is no session yet.
  private readonly api = contractClient(
    () => this.baseUrl,
    (request) => fetch(request, { credentials: 'same-origin' }),
  );

  constructor() {
    this.baseUrl = textOr(
      import.meta.env.VITE_API_BASE_URL,
      typeof window !== 'undefined' ? window.location.origin : '',
    );
    this.user = null;
  }

  login(): void {
    // Use replace to prevent back button issues
    window.location.replace(`${this.baseUrl}/login`);
  }

  logout(): void {
    this.user = null;
    // The server clears the cookie and deletes the KV session, then redirects to Auth0.
    window.location.href = `${this.baseUrl}/logout`;
  }

  async getUser(): Promise<AuthUser | null> {
    try {
      this.user = (await this.api.auth.me()).user;
      return this.user;
    } catch (error) {
      this.user = null;
      if (error instanceof ORPCError) {
        // 401/403 — no usable session.
        if (error.status === 401 || error.status === 403) return null;
        // Any other status is the server failing, not the user being signed out.
        // Returning null here sent an operator to the login screen during an
        // outage, where logging in bounced straight back.
        throw new Error(`身份服务返回 ${String(error.status)}`, { cause: error });
      }
      if (error instanceof ValidationError) {
        throw new Error(`身份服务响应格式不符：${error.message}`, { cause: error });
      }
      throw error;
    }
  }

  isAuthenticated(): boolean {
    return this.user !== null;
  }
}

export const auth = new Auth0Service();
