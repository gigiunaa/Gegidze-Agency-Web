const API_BASE = '/api';

function getToken(): string | null {
  return localStorage.getItem('token');
}

async function request<T>(url: string, options: RequestInit = {}): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {
    ...(options.headers as Record<string, string> || {}),
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  // Don't set Content-Type for FormData (browser sets it with boundary)
  if (!(options.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
  }

  const res = await fetch(`${API_BASE}${url}`, {
    ...options,
    headers,
  });

  if (res.status === 401) {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    window.location.href = '/login';
    throw new Error('Unauthorized');
  }

  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(error.error || 'Request failed');
  }

  return res.json();
}

function get<T>(url: string): Promise<T> {
  return request<T>(url);
}

function post<T>(url: string, body?: unknown): Promise<T> {
  return request<T>(url, {
    method: 'POST',
    body: body instanceof FormData ? body : JSON.stringify(body),
  });
}

function patch<T>(url: string, body: unknown): Promise<T> {
  return request<T>(url, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

function del<T>(url: string): Promise<T> {
  return request<T>(url, { method: 'DELETE' });
}

// ─── API Methods ────────────────────────────────────────────────────
import type { Meeting, Transcription, Summary, AuthResponse, User } from '../../../shared/types';

export const api = {
  auth: {
    login: (email: string, password: string) =>
      post<AuthResponse>('/auth/login', { email, password }),
    register: (email: string, password: string, name: string) =>
      post<AuthResponse>('/auth/register', { email, password, name }),
  },

  meetings: {
    list: () => get<Meeting[]>('/meetings'),
    get: (id: string) => get<Meeting | null>(`/meetings/${id}`),
    create: (data: Partial<Meeting>) => post<Meeting>('/meetings', data),
    delete: (id: string) => del<{ ok: boolean }>(`/meetings/${id}`),
  },

  recordings: {
    upload: (formData: FormData) => post<any>('/recordings/upload', formData),
  },

  transcription: {
    get: (meetingId: string) => get<Transcription | null>(`/transcriptions/${meetingId}`),
  },

  summary: {
    get: (meetingId: string) => get<Summary | null>(`/summaries/${meetingId}`),
    generate: (transcriptionId: string) => post('/summaries/generate', { transcriptionId }),
  },

  settings: {
    get: () => get<Record<string, string>>('/settings'),
    update: (settings: Record<string, string>) => patch('/settings', settings),
  },

  zoho: {
    search: (query: string) => get<any[]>(`/zoho/search?q=${encodeURIComponent(query)}`),
    getDeals: (leadId: string) => get<any[]>(`/zoho/leads/${leadId}/deals`),
    pushSummary: (meetingId: string, leadId: string) => post<{ ok: boolean; lead: boolean; dealsUpdated: string[] }>('/zoho/push-summary', { meetingId, leadId }),
  },

  admin: {
    users: () => get<User[]>('/admin/users'),
    meetings: () => get<Meeting[]>('/admin/meetings'),
    stats: () => get<{ totalUsers: number; totalMeetings: number; completedMeetings: number; failedMeetings: number }>('/admin/stats'),
    updateRole: (userId: string, role: User['role']) =>
      patch<User>(`/admin/users/${userId}/role`, { role }),
    deleteUser: (userId: string) =>
      del<{ ok: boolean }>(`/admin/users/${userId}`),
    inviteUser: (data: { email: string; name: string; role: User['role']; password: string }) =>
      post<User>('/admin/users/invite', data),
  },
};
