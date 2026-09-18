import type { Meeting } from '../../../shared/types';
import type { DatabaseService } from './database';
import { googleOAuthOptions, isGoogleConfigured } from '../routes/google';
import { refreshAccessToken, listEventsAround, findEventForMeet, attendeesFromEvent } from './google-calendar';

// Look up the Google Calendar invite behind a Meet call and store its title + invited people.
// Best effort: any failure is logged and the meeting stays as it is.
export async function enrichMeetingFromCalendar(db: DatabaseService, meeting: Meeting): Promise<Meeting> {
  if (!isGoogleConfigured() || !meeting.meetUrl) return meeting;

  const account = await db.getGoogleAccount(meeting.userId);
  if (!account) return meeting;

  try {
    const options = googleOAuthOptions();
    const accessToken = await refreshAccessToken(account.refreshToken, options);
    const events = await listEventsAround(accessToken, new Date(meeting.startTime), 3, options);
    const event = findEventForMeet(events, meeting.meetUrl);
    if (!event) {
      console.log(`No calendar invite found for ${meeting.meetUrl} (${events.length} events checked)`);
      return meeting;
    }

    const attendees = attendeesFromEvent(event);
    await db.updateMeetingCalendarInfo(meeting.id, { title: event.summary, calendarEventId: event.id, attendees });
    console.log(`Calendar invite "${event.summary}": ${attendees.length} invited people`);
    return (await db.getMeeting(meeting.id)) ?? meeting;
  } catch (err) {
    console.error('Calendar lookup failed (non-fatal):', err instanceof Error ? err.message : err);
    return meeting;
  }
}
