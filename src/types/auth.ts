// Authentication types for Clearance

export interface User {
  id: string;
  email: string;
  name?: string;
  avatarUrl?: string;
  emailVerified?: boolean;
  isAdmin?: boolean;
  createdAt: string;
}

export interface AuthState {
  user: User | null;
  isLoading: boolean;
  isAuthenticated: boolean;
}

export interface LoginCredentials {
  email: string;
  password: string;
}

export interface SignupCredentials {
  email: string;
  password: string;
  name?: string;
}

export interface SignupResult {
  user: User;
  verificationEmailSent: boolean;
}
