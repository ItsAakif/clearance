export interface User {
  id: string;
  email: string;
  name?: string;
  avatarUrl?: string;
  isAdmin?: boolean;
  createdAt: string;
}

export interface AuthState {
  user: User | null;
  isLoading: boolean;
  isAuthenticated: boolean;
}

export interface LoginCredentials {
  password: string;
}