# Unitty bot

Joins a Google Meet call and records one audio file per participant.

## One-time setup

    cd bot
    npm install
    npx playwright install chromium

The bot signs in to Google once, by hand, into the profile it will reuse:

    npm run sign-in

Sign in as the account the bot should appear as, then close the window. The session is kept in
`bot/profile/`, which is not committed.

## Joining a call

    npm run join -- https://meet.google.com/abc-defg-hij

The bot joins with its camera and microphone off and leaves when the call ends.

## Why it reads the transport and not the screen

Meet does not send one audio stream per person. It sends the loudest speakers as a handful of RTP
streams, and each packet carries contributing-source (CSRC) identifiers saying whose voice is in
it. The bot wraps `RTCPeerConnection` before Meet's own code runs and reads those identifiers, so
who said what comes from the connection rather than from anything drawn on screen. Window size, UI
language and Meet's redesigns therefore do not affect it.
