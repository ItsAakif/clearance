// React Query hooks for Auth API
// Provides authentication state management with React Query

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { authApi } from '@/services/api';
import type { User, LoginCredentials } from '@/types/auth';
import { toast } from './use-toast';

// Query keys
export const authKeys = {
  user: ['auth', 'user'] as const,
};

/**
 * Get current authenticated user
 */
export function useCurrentUser() {
  return useQuery({
    queryKey: authKeys.user,
    queryFn: () => authApi.getCurrentUser(),
    staleTime: 1000 * 60 * 10, // 10 minutes
    retry: false, // Don't retry on 401
  });
}

/**
 * Check if user is authenticated
 */
export function useAuth() {
  const { data: user, isLoading, error } = useCurrentUser();
  
  return {
    user,
    isLoading,
    isAuthenticated: !!user && !error,
  };
}

/**
 * Login mutation
 */
export function useLogin() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (credentials: LoginCredentials) => authApi.login(credentials),
    onSuccess: (user) => {
      queryClient.setQueryData(authKeys.user, user);
      toast({
        title: 'Welcome back!',
        description: `Logged in as ${user.email}`,
      });
    },
    onError: (error: Error) => {
      toast({
        title: 'Login failed',
        description: error.message,
        variant: 'destructive',
      });
    },
  });
}

/**
 * Logout mutation
 */
export function useLogout() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => authApi.logout(),
    onSuccess: () => {
      // Clear all cached data
      queryClient.clear();
      toast({
        title: 'Logged out',
        description: 'You have been logged out.',
      });
    },
    onError: (error: Error) => {
      toast({
        title: 'Logout failed',
        description: error.message,
        variant: 'destructive',
      });
    },
  });
}

/**
 * Update user profile
 */
export function useUpdateProfile() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: Partial<User>) => authApi.updateProfile(data),
    onSuccess: (updatedUser) => {
      queryClient.setQueryData(authKeys.user, updatedUser);
      toast({
        title: 'Profile updated',
        description: 'Your profile has been updated.',
      });
    },
    onError: (error: Error) => {
      toast({
        title: 'Update failed',
        description: error.message,
        variant: 'destructive',
      });
    },
  });
}
