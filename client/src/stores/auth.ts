import { create } from 'zustand';
import { api } from '../api/client';
import type { User } from '../../../shared/types';

interface AuthState {
  user: User | null;
  token: string | null;
  isAuthenticated: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, name: string) => Promise<void>;
  logout: () => void;
  loadFromStorage: () => void;
}

// Read before the first render, not in an effect afterwards. Loading it later meant that opening
// a page directly — /admin, or any link pasted into a fresh tab — was judged against a signed-out
// store and bounced to the dashboard before the session had even been read.
function fromStorage(): Pick<AuthState, 'user' | 'token' | 'isAuthenticated'> {
  try {
    const token = localStorage.getItem('token');
    const userStr = localStorage.getItem('user');
    if (token && userStr) return { user: JSON.parse(userStr) as User, token, isAuthenticated: true };
  } catch {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
  }
  return { user: null, token: null, isAuthenticated: false };
}

export const useAuthStore = create<AuthState>((set) => ({
  ...fromStorage(),

  login: async (email, password) => {
    const { token, user } = await api.auth.login(email, password);
    localStorage.setItem('token', token);
    localStorage.setItem('user', JSON.stringify(user));
    set({ user, token, isAuthenticated: true });
  },

  register: async (email, password, name) => {
    const { token, user } = await api.auth.register(email, password, name);
    localStorage.setItem('token', token);
    localStorage.setItem('user', JSON.stringify(user));
    set({ user, token, isAuthenticated: true });
  },

  logout: () => {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    set({ user: null, token: null, isAuthenticated: false });
  },

  loadFromStorage: () => set(fromStorage()),
}));
