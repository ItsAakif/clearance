// Authorization helpers
// Per security.md: Access control must always be enforced on the server

import { ForbiddenError, NotFoundError, UnauthorizedError, logSecurityEvent } from './errors.js';

type AuthContext = {
  user?: {
    id: string;
    email: string;
    isAdmin?: boolean;
    emailVerified?: boolean;
  };
};

type SanitizableUser = {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  emailVerified: boolean;
  createdAt: Date;
};

/**
 * Ensures the authenticated user owns the requested resource
 * MUST be called before any operation on user-owned resources
 */
export async function ensureOwnership(
  currentUserId: string | undefined,
  resourceUserId: string,
  resourceType: string
): Promise<void> {
  if (!currentUserId) {
    throw new UnauthorizedError('Authentication required');
  }
  
  if (currentUserId !== resourceUserId) {
    // Log unauthorized access attempt (without sensitive data)
    logSecurityEvent('unauthorized_access', {
      attemptedResourceType: resourceType,
      // Never log the actual user IDs in production for privacy
      // Just log that an attempt was made
      event: 'cross-user-access-attempt'
    });
    
    throw new ForbiddenError('Access denied');
  }
}

/**
 * Gets user from context or throws
 */
export function requireUser(context: AuthContext) {
  if (!context.user) {
    throw new UnauthorizedError('Authentication required');
  }
  return context.user;
}

/**
 * Sanitizes user object for client response (removes sensitive fields)
 */
export function sanitizeUser(user: SanitizableUser, isAdmin = false): Record<string, unknown> {
  const {
    id,
    email,
    name,
    avatarUrl,
    emailVerified,
    createdAt
  } = user;
  
  return {
    id,
    email,
    name,
    avatarUrl,
    emailVerified,
    createdAt,
    isAdmin,
  };
}
