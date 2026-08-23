// Auth API service - connected to Express backend
// JWT stored in HTTP-only cookie, handled automatically

import type { User, LoginCredentials, SignupCredentials, SignupResult } from "@/types/auth";
import { apiClient } from "./client";

// Backend response types
interface BackendUser {
  id: string;
  email: string;
  name?: string;
  avatarUrl?: string;
  emailVerified?: boolean;
  isAdmin?: boolean;
  createdAt: string;
}

interface AuthResponse {
  user: BackendUser;
  token: string;
  verificationEmailSent?: boolean;
}

// Transform backend user to frontend User type
function transformUser(backendUser: BackendUser): User {
  return {
    id: backendUser.id,
    email: backendUser.email,
    name: backendUser.name,
    avatarUrl: backendUser.avatarUrl,
    emailVerified: backendUser.emailVerified,
    isAdmin: backendUser.isAdmin,
    createdAt: backendUser.createdAt,
  };
}

export const authApi = {
  /**
   * Login with email/password
   */
  async login(credentials: LoginCredentials): Promise<User> {
    const response = await apiClient.post<AuthResponse>('/auth/login', {
      email: credentials.email,
      password: credentials.password,
    });
    
    return transformUser(response.user);
  },

  /**
   * Signup with email/password
   */
  async signup(credentials: SignupCredentials): Promise<SignupResult> {
    const response = await apiClient.post<AuthResponse>('/auth/signup', {
      email: credentials.email,
      password: credentials.password,
      name: credentials.name,
    });
    
    return {
      user: transformUser(response.user),
      verificationEmailSent: Boolean(response.verificationEmailSent),
    };
  },

  /**
   * Logout current user
   */
  async logout(): Promise<void> {
    await apiClient.post('/auth/logout');
  },

  /**
   * Permanently delete current account
   */
  async deleteAccount(): Promise<void> {
    await apiClient.delete('/auth/account');
  },

  /**
   * Get current authenticated user
   */
  async getCurrentUser(): Promise<User | null> {
    try {
      const user = await apiClient.get<BackendUser>('/auth/me');
      return user ? transformUser(user) : null;
    } catch (error: unknown) {
      // 401 means not authenticated, which is fine
      if (error instanceof Error && 'statusCode' in error && (error as { statusCode: number }).statusCode === 401) {
        return null;
      }
      throw error;
    }
  },

  /**
   * Request password reset email
   */
  async forgotPassword(email: string): Promise<void> {
    await apiClient.post('/auth/forgot-password', { email });
  },

  /**
   * Reset password with token
   */
  async resetPassword(token: string, password: string): Promise<void> {
    await apiClient.post('/auth/reset-password', { token, password });
  },

  async verifyEmail(token: string): Promise<User> {
    const response = await apiClient.post<{ success: boolean; user: BackendUser }>('/auth/verify-email', { token });
    return transformUser(response.user);
  },

  async resendVerificationEmail(): Promise<void> {
    await apiClient.post('/auth/resend-verification');
  },

  /**
   * Update user profile
   */
  async updateProfile(data: Partial<User>): Promise<User> {
    const updated = await apiClient.put<BackendUser>('/auth/profile', {
      name: data.name,
      avatarUrl: data.avatarUrl,
    });
    return transformUser(updated);
  },

  /**
   * Login with Google OAuth (redirect to Google)
   */
  getGoogleAuthUrl(): string {
    const apiUrl = import.meta.env.VITE_API_URL || 'http://localhost:3001/api';
    return `${apiUrl}/auth/google`;
  },
};
