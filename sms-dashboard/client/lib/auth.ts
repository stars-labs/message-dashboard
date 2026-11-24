// No token lives here: the session is an HttpOnly `auth_token` cookie that JavaScript cannot
// read. Authentication state is whether /api/auth/me answers.

import { ORPCError } from '@orpc/client';
import { ValidationError } from '@orpc/contract';
import { textOr } from '../../shared/text.js';
import type { MeResponse } from '../../shared/api/auth.js';
import { contractClient } from './contract-link.js';

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
    window.location.replace(`${this.baseUrl}/login`);
  }

  logout(): void {
    this.user = null;
    window.location.href = `${this.baseUrl}/logout`;
  }

  async getUser(): Promise<AuthUser | null> {
    try {
      this.user = (await this.api.auth.me()).user;
      return this.user;
    } catch (error) {
      this.user = null;
      if (error instanceof ORPCError) {
        if (error.status === 401 || error.status === 403) return null;
        // Any other status is the server failing, not a sign-out; null would send the
        // operator to a login screen that bounces straight back.
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
