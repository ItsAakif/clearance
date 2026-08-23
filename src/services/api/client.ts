// API Client for Clearance Backend
// Centralized HTTP client with auth handling

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001/api';

// ==================== HTTP CLIENT ====================

interface RequestOptions extends Omit<RequestInit, 'body'> {
  body?: unknown;
}

interface ApiError {
  error: string;
  statusCode?: number;
}

class ApiClientError extends Error {
  statusCode: number;
  
  constructor(message: string, statusCode: number) {
    super(message);
    this.name = 'ApiClientError';
    this.statusCode = statusCode;
  }
}

/**
 * Make an authenticated API request
 */
async function request<T>(
  endpoint: string,
  options: RequestOptions = {}
): Promise<T> {
  const { body, headers: customHeaders, ...rest } = options;
  
  const headers: HeadersInit = {
    'Content-Type': 'application/json',
    ...customHeaders,
  };
  
  const config: RequestInit = {
    ...rest,
    headers,
    credentials: 'include', // Send cookies for session auth
  };
  
  if (body !== undefined) {
    config.body = JSON.stringify(body);
  }
  
  const response = await fetch(`${API_BASE_URL}${endpoint}`, config);
  
  // Handle no-content responses
  if (response.status === 204) {
    return undefined as T;
  }
  
  // Try to parse JSON response
  let data: T | ApiError;
  try {
    data = await response.json();
  } catch {
    if (!response.ok) {
      throw new ApiClientError('Request failed', response.status);
    }
    return undefined as T;
  }
  
  if (!response.ok) {
    const errorData = data as ApiError;
    throw new ApiClientError(
      errorData.error || 'Request failed',
      response.status
    );
  }
  
  return data as T;
}

/**
 * Upload a file
 */
async function uploadFile<T>(
  endpoint: string,
  file: File,
  fieldName: string = 'file'
): Promise<T> {
  const formData = new FormData();
  formData.append(fieldName, file);
  
  const response = await fetch(`${API_BASE_URL}${endpoint}`, {
    method: 'POST',
    body: formData,
    credentials: 'include',
    // Don't set Content-Type - browser will set it with boundary
  });
  
  const data = await response.json();
  
  if (!response.ok) {
    throw new ApiClientError(data.error || 'Upload failed', response.status);
  }
  
  return data;
}

/**
 * Download a file (returns Blob)
 */
async function downloadFile(endpoint: string): Promise<Blob> {
  const response = await fetch(`${API_BASE_URL}${endpoint}`, {
    method: 'GET',
    credentials: 'include',
  });
  
  if (!response.ok) {
    let errorMessage = 'Download failed';
    try {
      const data = await response.json();
      errorMessage = data.error || errorMessage;
    } catch {
      // Ignore JSON parse error
    }
    throw new ApiClientError(errorMessage, response.status);
  }
  
  return response.blob();
}

/**
 * Download a file via POST (for sending data to generate the download)
 */
async function downloadFilePost(endpoint: string, body: unknown): Promise<Blob> {
  const response = await fetch(`${API_BASE_URL}${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    credentials: 'include',
  });
  
  if (!response.ok) {
    let errorMessage = 'Download failed';
    try {
      const data = await response.json();
      errorMessage = data.error || errorMessage;
    } catch {
      // Ignore JSON parse error
    }
    throw new ApiClientError(errorMessage, response.status);
  }
  
  return response.blob();
}

// ==================== EXPORTS ====================

export const apiClient = {
  get: <T>(endpoint: string) => request<T>(endpoint, { method: 'GET' }),
  
  post: <T>(endpoint: string, body?: unknown) => 
    request<T>(endpoint, { method: 'POST', body }),
  
  put: <T>(endpoint: string, body?: unknown) => 
    request<T>(endpoint, { method: 'PUT', body }),
  
  patch: <T>(endpoint: string, body?: unknown) => 
    request<T>(endpoint, { method: 'PATCH', body }),
  
  delete: <T>(endpoint: string) => 
    request<T>(endpoint, { method: 'DELETE' }),
  
  upload: uploadFile,
  download: downloadFile,
  downloadPost: downloadFilePost,
};

export { ApiClientError };
export default apiClient;
