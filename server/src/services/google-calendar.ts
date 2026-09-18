// Google Calendar: find the invite behind a Meet call and who was invited (names + emails)

export interface CalendarEvent {
  id: string;
  summary?: string;
  hangoutLink?: string;
  conferenceData?: { entryPoints?: { entryPointType?: string; uri?: string }[] };
  start?: { dateTime?: string; date?: string };
  attendees?: { email?: string; displayName?: string; self?: boolean; resource?: boolean; responseStatus?: string }[];
}

export interface Attendee {
  name: string;
  email: string;
}

export interface GoogleOAuthOptions {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  // Test hooks
  oauthBaseUrl?: string;
  apiBaseUrl?: string;
}

export const GOOGLE_SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/calendar.events.readonly',
];

export function meetCodeFromUrl(url: string): string | null {
  return url.match(/^https:\/\/meet\.google\.com\/([a-z]{3}-[a-z]{4}-[a-z]{3})/)?.[1] ?? null;
}

// The event whose Meet link carries the same meeting code as the call
export function findEventForMeet(events: CalendarEvent[], meetUrl: string): CalendarEvent | null {
  const code = meetCodeFromUrl(meetUrl);
  if (!code) return null;
  return events.find(event => {
    const links = [event.hangoutLink, ...(event.conferenceData?.entryPoints ?? []).map(p => p.uri)];
    return links.some(link => link && meetCodeFromUrl(link) === code);
  }) ?? null;
}

// Invited people (meeting rooms and other resources left out)
export function attendeesFromEvent(event: CalendarEvent): Attendee[] {
  return (event.attendees ?? [])
    .filter(a => a.email && !a.resource)
    .map(a => ({ name: a.displayName?.trim() || a.email!, email: a.email! }));
}

// Map each transcript speaker name to an invited person's email: full name first, then first name
export function matchSpeakersToAttendees(speakers: string[], attendees: Attendee[]): Record<string, string> {
  const normalize = (s: string) => s.trim().toLowerCase();
  const matches: Record<string, string> = {};

  for (const speaker of speakers) {
    const wanted = normalize(speaker);
    const exact = attendees.find(a => normalize(a.name) === wanted);
    const byFirstName = attendees.filter(a => normalize(a.name).split(/\s+/)[0] === wanted.split(/\s+/)[0]);
    const match = exact ?? (byFirstName.length === 1 ? byFirstName[0] : undefined);
    if (match) matches[speaker] = match.email;
  }

  return matches;
}

// ── OAuth + API calls ──────────────────────────────────────────────────────

export function googleAuthUrl(state: string, options: GoogleOAuthOptions): string {
  const params = new URLSearchParams({
    client_id: options.clientId,
    redirect_uri: options.redirectUri,
    response_type: 'code',
    scope: GOOGLE_SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

async function tokenRequest(body: Record<string, string>, options: GoogleOAuthOptions): Promise<Record<string, any>> {
  const response = await fetch(`${options.oauthBaseUrl ?? 'https://oauth2.googleapis.com'}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: options.clientId, client_secret: options.clientSecret, ...body }),
  });
  if (!response.ok) {
    throw new Error(`Google token error: ${response.status} - ${await response.text()}`);
  }
  return response.json() as Promise<Record<string, any>>;
}

// Exchange the OAuth code for tokens; the id_token carries the Google account's email
export async function exchangeCode(code: string, options: GoogleOAuthOptions): Promise<{ refreshToken: string; email: string }> {
  const data = await tokenRequest({ code, grant_type: 'authorization_code', redirect_uri: options.redirectUri }, options);
  if (!data.refresh_token) {
    throw new Error('Google did not return a refresh token — remove the app at myaccount.google.com/permissions and connect again');
  }
  return { refreshToken: data.refresh_token, email: emailFromIdToken(data.id_token) };
}

export async function refreshAccessToken(refreshToken: string, options: GoogleOAuthOptions): Promise<string> {
  const data = await tokenRequest({ refresh_token: refreshToken, grant_type: 'refresh_token' }, options);
  return data.access_token as string;
}

function emailFromIdToken(idToken: string | undefined): string {
  if (!idToken) return '';
  try {
    const payload = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url').toString('utf-8'));
    return payload.email ?? '';
  } catch {
    return '';
  }
}

// Events on the user's primary calendar around a point in time (± hours)
export async function listEventsAround(accessToken: string, at: Date, hours: number, options: GoogleOAuthOptions): Promise<CalendarEvent[]> {
  const params = new URLSearchParams({
    timeMin: new Date(at.getTime() - hours * 3600_000).toISOString(),
    timeMax: new Date(at.getTime() + hours * 3600_000).toISOString(),
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: '50',
  });
  const response = await fetch(`${options.apiBaseUrl ?? 'https://www.googleapis.com'}/calendar/v3/calendars/primary/events?${params}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    throw new Error(`Google Calendar error: ${response.status} - ${await response.text()}`);
  }
  const data = await response.json() as { items?: CalendarEvent[] };
  return data.items ?? [];
}
