# Unitty: production recorder built on a meeting bot

Date: 2026-09-23
Status: agreed with the product owner, not yet built

## Why this exists

The current system records from a Chrome extension on the salesperson's own machine and
works out who said what by reading Google Meet's captions off that person's screen. Two
things are wrong with it, and both are fatal for a product we intend to sell:

1. **Wrong names.** Captions are read from the page, arrive a few seconds late, and Google
   revises them. A short interjection lands inside somebody else's long caption block and
   is attributed to them. The transcript then states, with full confidence, that a person
   said something they did not.
2. **It depends on the user's screen.** Browser build, window size, UI language and Meet's
   own redesigns all change what the extension finds. What works on one laptop fails on
   another.

The fix is to stop inferring. A bot that joins the call receives each participant's audio
as its own stream, already labelled by Meet with who it belongs to. Nothing is guessed.

## What we are building

A bot joins the call as a participant, captures **one audio track per person**, and the
server transcribes each track separately. A name on a transcript line is the name of the
person whose microphone produced that audio — there is no attribution step that can fail.

### Decisions taken

| Question | Decision |
|---|---|
| Who is it for | A product sold to other companies (multi-tenant) |
| How recording happens | Our own bot joins the call |
| Bot: build or buy | Build it ourselves (headless Chrome we control) |
| Platforms at launch | Google Meet only; Zoom and Teams later |
| How the bot is invited | Both: automatic from the calendar, and a pasted link |
| Languages | Georgian first; adding a language is a setting, not a rewrite |
| Concurrency | 10–50 calls at once |

### The hard requirement

**The system never writes a name it is not sure of.** Where a stream's owner is known, the
name is used. Where it is not, the line says `Speaker 2`. A missing name is a small
annoyance; a wrong name destroys trust in every transcript we produce.

## How it works

```
Calendar watcher ─┐
                  ├─► Bot dispatcher ─► Bot (headless Chrome, one per call)
"Join now" button ─┘                      │
                                          │ per-participant audio + names
                                          ▼
                                    Recording service
                                          │
                                          ├─► Gemini, one track at a time ─► transcript
                                          ├─► notes (Georgian)
                                          └─► Word file ─► Zoho CRM
```

### 1. The bot

One containerised headless Chrome per call. It signs in, joins the meeting, and announces
itself in the chat. A script injected into the page before Meet's own code runs hooks
`RTCPeerConnection` so that every inbound audio track is captured as it is created, along
with the participant it belongs to.

Meet's web client receives the loudest speakers as separate RTP streams; each packet
carries a contributing-source (CSRC) identifier that Meet assigns per participant. The
hook maps those identifiers to participant names from Meet's own session data, so each
captured track is tagged with a person, not a guess.

This is the part with real engineering risk and the part that needs maintenance when
Google changes Meet. It is also the part that makes the product correct, which is why we
are building it rather than reading a screen.

The bot also records: when each person joined and left, the meeting title, and the
participant list.

**Before anything else is built, this must be proved on a real call.** If per-participant
audio cannot be captured reliably, the architecture changes and we should find that out in
week one, not week five.

### 2. Transcription

Each person's audio is transcribed on its own with Gemini. Because the track came from one
microphone, the speaker is known outright. Segments from all tracks are then merged by
time into a single transcript.

Two people sharing one laptop are one participant to Meet and will share a name. Voice
analysis can separate them later; it is not in the first release.

### 3. Getting the bot into the call

- **From the calendar.** A company connects Google Calendar. A watcher looks ahead for
  events carrying a Meet link and dispatches a bot a minute before each one.
- **By hand.** Paste a link, or press "join now" for a call already running.

### 4. Running 10–50 calls at once

Each call is a container. A queue holds pending joins, a dispatcher starts containers and
stops them when the call ends, and the pool scales with demand. Railway suits the API and
database but not a fleet of browsers; the bots need a container platform with more control
over CPU and lifetime.

### 5. Companies and people

Organisations own their data. Each has its own members, language, CRM connection and
retention setting. Nothing crosses between organisations.

## What survives from today

Most of the server: transcription pipeline, notes, Word export, Zoho attachment, the site,
the database schema. The Chrome extension is no longer needed; it can stay as an option for
people who would rather not have a bot in the room.

## What could go wrong

| Risk | What we do about it |
|---|---|
| Meet's internals change and the hook breaks | It breaks in one place we control, not on every user's laptop. Pin the Chrome version, monitor every call for silent tracks, alert on a drop. |
| The bot is not admitted to the call | Report it on the meeting as "not admitted" rather than failing silently. |
| Per-participant audio proves impossible | Find out in the first week from the proof, then reconsider: a bot platform such as Recall.ai already solves it for a per-hour fee. |
| A call costs more than we charge | Measure per-call cost from day one: bot minutes plus Gemini. |

## Order of work

1. **Proof: per-participant audio from a real Meet call.** Everything else depends on it.
2. Bot container: join, announce, capture, upload, leave.
3. Server: accept per-participant tracks, transcribe each, merge.
4. Dispatcher and queue; "join now" from the site.
5. Calendar watcher.
6. Organisations and multi-tenancy.
7. Scale and cost tests at 10, then 50 concurrent calls.
