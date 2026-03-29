import { create } from 'zustand';
import { api } from '../api/client';
import type { Meeting } from '../../../shared/types';

interface MeetingsState {
  meetings: Meeting[];
  loading: boolean;
  fetchMeetings: () => Promise<void>;
}

export const useMeetingsStore = create<MeetingsState>((set) => ({
  meetings: [],
  loading: false,

  fetchMeetings: async () => {
    set({ loading: true });
    try {
      const meetings = await api.meetings.list();
      set({ meetings, loading: false });
    } catch {
      set({ loading: false });
    }
  },
}));
