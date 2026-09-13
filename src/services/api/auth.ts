// Auth API service - single application password auth

import type { User, LoginCredentials } from "@/types/auth";
import { apiClient } from "./client";

interface BackendUser {
  id: string;
  email: string;
  name?: string;
  avatarUrl?: string;
  isAdmin?: boolean;
  createdAt: string;
}

function transformUser(backendUser: BackendUser): User {
  return {
    id: backendUser.id,
    email: backendUser.email,
    name: backendUser.name,
    avatarUrl: backendUser.avatarUrl,
    isAdmin: backendUser.isAdmin,
    createdAt: backendUser.createdAt,
  };
}

export const authApi = {
  async login(credentials: LoginCredentials): Promise<User> {
    const response = await apiClient.post<{ user: BackendUser }>('/auth/login', {
      password: credentials.password,
    });
    return transformUser(response.user);
  },

  async logout(): Promise<void> {
    await apiClient.post('/auth/logout');
  },

  async getCurrentUser(): Promise<User | null> {
    try {
      const user = await apiClient.get<BackendUser>('/auth/me');
      return user ? transformUser(user) : null;
    } catch (error: unknown) {
      if (error instanceof Error && 'statusCode' in error && (error as { statusCode: number }).statusCode === 401) {
        return null;
      }
      throw error;
    }
  },

  async updateProfile(data: Partial<User>): Promise<User> {
    const updated = await apiClient.put<BackendUser>('/auth/profile', {
      name: data.name,
      avatarUrl: data.avatarUrl,
    });
    return transformUser(updated);
  },
};