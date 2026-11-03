// API Client for Clearance Backend
// Centralized HTTP client with auth handling

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001/api';

// ==================== HTTP CLIENT ====================

interface RequestOptions extends Omit<RequestInit, 'body'> {
  body?: unknown;
}

interface ApiError {
  error: string;
  code?: string;
  statusCode?: number;
}

class ApiClientError extends Error {
  statusCode: number;
  code?: string;

  constructor(message: string, statusCode: number, code?: string) {
    super(message);
    this.name = 'ApiClientError';
    this.statusCode = statusCode;
    this.code = code;
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
      response.status,
      errorData.code
    );
  }
  
  return data as T;
}

/**
 * Upload a file.
 *
 * `extraFields` is appended to the SAME FormData after the file, so an endpoint that
 * needs a field alongside the upload (a `profileId`, a `title`) is one call rather than
 * two. Existing callers pass neither and get exactly the previous body: the file is
 * appended first, under `fieldName`, and nothing else is sent.
 */
async function uploadFile<T>(
  endpoint: string,
  file: File,
  fieldName: string = 'file',
  extraFields?: Record<string, string | undefined>
): Promise<T> {
  const formData: FormData = new FormData();
  if (extraFields) {
    for (const [key, value] of Object.entries(extraFields)) {
      // An `undefined` value is SKIPPED, not appended as the string "undefined": the
      // server's zod envelope treats an empty string as a supplied value, so appending a
      // blank would turn "no title" into "title: ''".
      if (typeof value === 'string') formData.append(key, value);
    }
  }
  formData.append(fieldName, file);

  const response = await fetch(`${API_BASE_URL}${endpoint}`, {
    method: 'POST',
    body: formData,
    credentials: 'include',
    // Don't set Content-Type - browser will set it with boundary
  });
  
  const data = await response.json();
  
  if (!response.ok) {
    throw new ApiClientError(data.error || 'Upload failed', response.status, data.code);
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
    let errorCode: string | undefined;
    try {
      const data = await response.json();
      errorMessage = data.error || errorMessage;
      errorCode = typeof data.code === 'string' ? data.code : undefined;
    } catch {
      // Ignore JSON parse error
    }
    throw new ApiClientError(errorMessage, response.status, errorCode);
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
    let errorCode: string | undefined;
    try {
      const data = await response.json();
      errorMessage = data.error || errorMessage;
      errorCode = typeof data.code === 'string' ? data.code : undefined;
    } catch {
      // Ignore JSON parse error
    }
    throw new ApiClientError(errorMessage, response.status, errorCode);
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
