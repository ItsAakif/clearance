// Custom error classes for Clearance backend
// Per security.md: Error messages must be safe and minimal
// Never expose stack traces or backend logic to users

import { Response } from 'express';

export class HttpError extends Error {
  statusCode: number;
  isOperational: boolean;

  constructor(statusCode: number, message: string, isOperational = true) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = isOperational;
    this.name = 'HttpError';

    // Capture stack trace (server-side only, never sent to client)
    Error.captureStackTrace(this, this.constructor);
  }
}

// Specific error types
export class NotFoundError extends HttpError {
  constructor(resource: string = 'Resource') {
    super(404, `${resource} not found`);
    this.name = 'NotFoundError';
  }
}

export class UnauthorizedError extends HttpError {
  constructor(message: string = 'Authentication required') {
    super(401, message);
    this.name = 'UnauthorizedError';
  }
}

export class ForbiddenError extends HttpError {
  constructor(message: string = 'Access denied') {
    super(403, message);
    this.name = 'ForbiddenError';
  }
}

export class BadRequestError extends HttpError {
  constructor(message: string = 'Bad request') {
    super(400, message);
    this.name = 'BadRequestError';
  }
}

export class ConflictError extends HttpError {
  constructor(message: string = 'Resource conflict') {
    super(409, message);
    this.name = 'ConflictError';
  }
}

// T1030 added a `UnprocessableEntityError` (422) here, on the reasoning that the gate
// needed 409 ("confirm this claim and retry") to stay distinct from 422 ("the request
// itself cannot be acted on"). Nothing ever threw it: a schema failure is a 400 from
// `ResumeJsonValidationError`, and every gate refusal is a 409. A status code with no
// producer is a number someone will eventually rely on, so it is gone rather than left
// mapped in a branch nothing reaches. The distinction it was added for is real and is
// carried instead by `code` + `reason` on the 409 body (see `RevisionAuditError` and
// `PreRenderGateError` in backend/src/), which a client can branch on precisely.

export class RateLimitError extends HttpError {
  constructor(message: string = 'Too many requests. Please try again later.') {
    super(429, message);
    this.name = 'RateLimitError';
  }
}

export class InternalError extends HttpError {
  constructor(internalMessage: string) {
    // User sees generic message, internal message is logged server-side
    super(500, 'An unexpected error occurred', false);
    this.name = 'InternalError';
    
    // Log the actual error server-side only (never exposed to client)
    console.error(`[INTERNAL ERROR] ${internalMessage}`);
  }
}

// Error handler for API routes
export function handleApiError(error: unknown, res: Response): void {
  // Log error details server-side
  const timestamp = new Date().toISOString();
  
  if (error instanceof HttpError) {
    // Operational errors - safe to show message to user
    if (error.isOperational) {
      console.error(`[${timestamp}] [${error.statusCode}] ${error.message}`);
      res.status(error.statusCode).json({ error: error.message });
    } else {
      // Non-operational errors - show generic message
      console.error(`[${timestamp}] [${error.statusCode}] [NON-OP] ${error.stack}`);
      res.status(500).json({ error: 'An unexpected error occurred' });
    }
  } else if (error instanceof Error) {
    // Unknown errors - log full details, show generic message
    console.error(`[${timestamp}] [500] [UNKNOWN] ${error.stack}`);
    res.status(500).json({ error: 'An unexpected error occurred' });
  } else {
    // Non-Error thrown - very unusual
    console.error(`[${timestamp}] [500] [NON-ERROR] ${String(error)}`);
    res.status(500).json({ error: 'An unexpected error occurred' });
  }
}

// Security event logger (for important security events)
export function logSecurityEvent(
  event: 'login_failed' | 'unauthorized_access' | 'rate_limited' | 'invalid_webhook' | 'suspicious_activity' | 'oauth_failed',
  details: Record<string, unknown>
): void {
  const timestamp = new Date().toISOString();
  
  // Sanitize details - never log passwords, tokens, or sensitive data
  const sanitizedDetails = { ...details };
  const sensitiveKeys = ['password', 'token', 'apiKey', 'secret', 'authorization'];
  for (const key of sensitiveKeys) {
    if (key in sanitizedDetails) {
      sanitizedDetails[key] = '[REDACTED]';
    }
  }
  
  console.error(`[${timestamp}] [SECURITY] [${event}]`, JSON.stringify(sanitizedDetails));
}
