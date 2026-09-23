# Unitty Bot — Per-Participant Capture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A command-line bot that joins a Google Meet call, records one audio file per participant labelled with that participant's name, and writes them to a folder with a manifest.

**Architecture:** Node + Playwright drive a real (non-headless) Chrome. A script injected before Meet's own code wraps `RTCPeerConnection`, so every inbound audio track is captured as it is created. Meet multiplexes several speakers into few RTP streams, so who is talking comes from the contributing-source (CSRC) identifiers on each stream, not from anything on screen. All decision logic — speaking intervals, name resolution, file naming — lives in pure functions in Node that are unit-tested without a browser; the browser side only gathers raw observations.

**Tech Stack:** TypeScript, Node 20+, Playwright (Chromium), `node:test` via `tsx --test` (same runner as `server/`), WebRTC `getContributingSources()`, `MediaRecorder`.

**Spec:** `docs/superpowers/specs/2026-09-23-unitty-bot-design.md`

## Global Constraints

- **The system never writes a name it is not sure of.** Where a stream's owner is known, the name is used. Where it is not, the label is `Speaker 2`. A missing name is a small annoyance; a wrong name destroys trust in every transcript we produce. (Spec: "The hard requirement".)
- **Google Meet only.** Zoom and Teams are out of scope for this plan.
- **This plan stops at local files.** Uploading to the server, the dispatcher/queue, the calendar watcher and multi-tenancy are separate plans. The deliverable here is a bot that produces correct per-participant audio on disk.
- **Task 3 is a go/no-go gate.** The spec says: "Before anything else is built, this must be proved on a real call. If per-participant audio cannot be captured reliably, the architecture changes and we should find that out in week one, not week five." If Task 3 fails, stop and report — do not proceed to Task 4.
- **New code lives in `bot/`**, a sibling of `server/` and `client/`, with its own `package.json`. Do not add Playwright to `server/`.
- **Follow the surrounding code's style:** comments explain *why*, not *what*; no decorative section banners beyond the `// ── Name ──` form already used in `server/src` and `extension/`.

---

### Task 1: Bot package that joins and leaves a real call

**Files:**
- Create: `bot/package.json`
- Create: `bot/tsconfig.json`
- Create: `bot/src/meet-url.ts`
- Create: `bot/src/meet-url.test.ts`
- Create: `bot/src/browser.ts`
- Create: `bot/src/join.ts`
- Create: `bot/src/index.ts`
- Create: `bot/README.md`
- Create: `bot/.gitignore`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `meetingCodeFrom(input: string): string | null`
  - `launchBot(opts: { profileDir: string; headless?: boolean }): Promise<{ context: BrowserContext; page: Page; close: () => Promise<void> }>`
  - `joinCall(page: Page, meetUrl: string, displayName?: string): Promise<void>`
  - `leaveCall(page: Page): Promise<void>`
  - `isInCall(page: Page): Promise<boolean>`

- [ ] **Step 1: Write the failing test**

Create `bot/src/meet-url.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { meetingCodeFrom } from './meet-url';

test('reads the code out of a Meet link', () => {
  assert.equal(meetingCodeFrom('https://meet.google.com/abc-defg-hij'), 'abc-defg-hij');
});

test('ignores query strings and trailing slashes', () => {
  assert.equal(meetingCodeFrom('https://meet.google.com/abc-defg-hij/?authuser=1'), 'abc-defg-hij');
});

test('accepts a bare meeting code', () => {
  assert.equal(meetingCodeFrom('abc-defg-hij'), 'abc-defg-hij');
});

test('refuses Meet pages that are not a call', () => {
  assert.equal(meetingCodeFrom('https://meet.google.com/home'), null);
  assert.equal(meetingCodeFrom('https://meet.google.com/new'), null);
});

test('refuses links to other services', () => {
  assert.equal(meetingCodeFrom('https://zoom.us/j/123456'), null);
  assert.equal(meetingCodeFrom(''), null);
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `cd bot && npm test`
Expected: FAIL — `Cannot find module './meet-url'`.

- [ ] **Step 3: Create the package so the test can run**

Create `bot/package.json`:

```json
{
  "name": "unitty-bot",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc",
    "test": "tsx --test \"src/**/*.test.ts\"",
    "join": "tsx src/index.ts"
  },
  "dependencies": {
    "playwright": "^1.49.0"
  },
  "devDependencies": {
    "@types/node": "^22.10.0",
    "tsx": "^4.19.0",
    "typescript": "^5.7.0"
  }
}
```

Create `bot/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM"],
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src/**/*"]
}
```

Create `bot/.gitignore`:

```
node_modules/
dist/
out/
profile/
```

Then: `cd bot && npm install && npx playwright install chromium`

- [ ] **Step 4: Write the minimal implementation**

Create `bot/src/meet-url.ts`:

```ts
// A Meet call code is three letters, four letters, three letters. Matching the shape rather than
// just the host keeps /home and /new — which are Meet pages but not calls — out.
const CODE = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/;

export function meetingCodeFrom(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (CODE.test(trimmed)) return trimmed;

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.hostname !== 'meet.google.com') return null;

  const code = url.pathname.replace(/^\/+|\/+$/g, '');
  return CODE.test(code) ? code : null;
}
```

- [ ] **Step 5: Run the test and watch it pass**

Run: `cd bot && npm test`
Expected: PASS — 5 tests.

- [ ] **Step 6: Write the browser launcher**

Create `bot/src/browser.ts`:

```ts
import { chromium, type BrowserContext, type Page } from 'playwright';

// Meet checks for a camera and a microphone before it will let anyone in, so Chrome is given fake
// ones and told to grant them without asking. The bot neither speaks nor is seen; it only listens.
const CHROME_ARGS = [
  '--use-fake-ui-for-media-stream',
  '--use-fake-device-for-media-stream',
  '--autoplay-policy=no-user-gesture-required',
  '--disable-blink-features=AutomationControlled',
];

export interface Bot {
  context: BrowserContext;
  page: Page;
  close: () => Promise<void>;
}

// A persistent profile is what keeps the bot signed in to Google. Signing in happens once, by hand,
// against this same directory; after that the session is reused.
export async function launchBot(opts: { profileDir: string; headless?: boolean }): Promise<Bot> {
  const context = await chromium.launchPersistentContext(opts.profileDir, {
    headless: opts.headless ?? false,
    args: CHROME_ARGS,
    permissions: ['microphone', 'camera'],
    viewport: { width: 1280, height: 800 },
  });

  const page = context.pages()[0] ?? (await context.newPage());
  return { context, page, close: () => context.close() };
}
```

- [ ] **Step 7: Write join and leave**

Create `bot/src/join.ts`:

```ts
import type { Page } from 'playwright';
import { meetingCodeFrom } from './meet-url';

// Meet's button labels are translated, but the icon ligatures inside them are not, so the call
// controls are found by icon name. This is the same approach the browser extension settled on.
const IN_CALL_ICON = 'call_end';

export async function joinCall(page: Page, meetUrl: string, displayName?: string): Promise<void> {
  const code = meetingCodeFrom(meetUrl);
  if (!code) throw new Error(`Not a Google Meet link: ${meetUrl}`);

  await page.goto(`https://meet.google.com/${code}`, { waitUntil: 'domcontentloaded' });

  // Some accounts get a name box before joining; it is absent when already signed in
  if (displayName) {
    const nameBox = page.locator('input[type="text"]').first();
    if (await nameBox.isVisible().catch(() => false)) await nameBox.fill(displayName);
  }

  // Turn the camera and microphone off before joining rather than after, so the bot never appears
  // to broadcast. Both are toggles, so they are only clicked when they are currently on.
  for (const off of ['videocam', 'mic']) {
    const button = page.locator(`button:has(i.google-symbols:text-is("${off}"))`).first();
    if (await button.isVisible().catch(() => false)) await button.click().catch(() => {});
  }

  const joinButton = page
    .locator('button')
    .filter({ hasText: /join now|ask to join|შეუერთდი/i })
    .first();
  await joinButton.click({ timeout: 30000 });

  await page.waitForFunction(
    (icon) => Array.from(document.querySelectorAll('i')).some((i) => i.textContent?.trim() === icon),
    IN_CALL_ICON,
    { timeout: 120000 },
  );
}

export function isInCall(page: Page): Promise<boolean> {
  return page.evaluate(
    (icon) => Array.from(document.querySelectorAll('i')).some((i) => i.textContent?.trim() === icon),
    IN_CALL_ICON,
  );
}

export async function leaveCall(page: Page): Promise<void> {
  const hangUp = page.locator(`button:has(i.google-symbols:text-is("${IN_CALL_ICON}"))`).first();
  await hangUp.click({ timeout: 10000 }).catch(() => {});
}
```

- [ ] **Step 8: Write the command-line entry point**

Create `bot/src/index.ts`:

```ts
import path from 'node:path';
import { launchBot } from './browser';
import { joinCall, isInCall, leaveCall } from './join';

const meetUrl = process.argv[2];
if (!meetUrl) {
  console.error('Usage: npm run join -- <meet-url>');
  process.exit(1);
}

const profileDir = process.env.BOT_PROFILE_DIR ?? path.join(process.cwd(), 'profile');

const bot = await launchBot({ profileDir });
try {
  console.log(`Joining ${meetUrl}...`);
  await joinCall(bot.page, meetUrl, 'Unitty Recorder');
  console.log('In the call.');

  // Stay until the call ends or someone stops the bot
  while (await isInCall(bot.page)) {
    await new Promise((r) => setTimeout(r, 2000));
  }
  console.log('The call ended.');
} finally {
  await leaveCall(bot.page).catch(() => {});
  await bot.close();
}
```

- [ ] **Step 9: Write the README so the next person can sign the bot in**

Create `bot/README.md`:

```markdown
# Unitty bot

Joins a Google Meet call and records one audio file per participant.

## One-time setup

    cd bot
    npm install
    npx playwright install chromium

The bot signs in to Google once, by hand, into the profile it will reuse:

    BOT_PROFILE_DIR=./profile npx playwright open --browser chromium https://accounts.google.com

Sign in as the account the bot should appear as, then close the window.

## Joining a call

    npm run join -- https://meet.google.com/abc-defg-hij

The bot joins with its camera and microphone off and leaves when the call ends.
```

- [ ] **Step 10: Verify against a real call**

Start a Meet call from a normal browser, then run:

`cd bot && npm run join -- <your meet link>`

Expected: a Chrome window opens, joins the call (admit it if asked), and the call shows an extra participant with no camera and no microphone. End the call; the bot prints "The call ended." and exits.

Record the result in the commit message. If the bot cannot join, fix that before continuing — every later task needs it.

- [ ] **Step 11: Commit**

```bash
git add bot/
git commit -m "Add a bot that joins a Meet call and leaves when it ends"
```

---

### Task 2: See what the transport knows about who is speaking

**Files:**
- Create: `bot/src/csrc-timeline.ts`
- Create: `bot/src/csrc-timeline.test.ts`
- Create: `bot/src/inject/rtc-hook.ts`
- Modify: `bot/src/browser.ts` (add the init script)
- Modify: `bot/src/index.ts` (write an observation report)

**Interfaces:**
- Consumes: `launchBot`, `joinCall`, `isInCall`, `leaveCall` from Task 1.
- Produces:
  - `interface Sample { csrc: number; audioLevel: number; atMs: number }`
  - `interface Interval { csrc: number; startMs: number; endMs: number }`
  - `speakingIntervals(samples: Sample[], opts?: { minLevel?: number; silenceGapMs?: number }): Interval[]`
  - `RTC_HOOK_SOURCE: string` — the injected script, as source text
  - `window.__unittySamples: Sample[]` inside the page

- [ ] **Step 1: Write the failing test**

Create `bot/src/csrc-timeline.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { speakingIntervals, type Sample } from './csrc-timeline';

const sample = (csrc: number, audioLevel: number, atMs: number): Sample => ({ csrc, audioLevel, atMs });

test('runs of loud samples from one source become one interval', () => {
  const intervals = speakingIntervals([
    sample(11, 0.20, 0),
    sample(11, 0.18, 200),
    sample(11, 0.22, 400),
  ]);
  assert.deepEqual(intervals, [{ csrc: 11, startMs: 0, endMs: 400 }]);
});

test('a long silence splits one source into two intervals', () => {
  const intervals = speakingIntervals([
    sample(11, 0.20, 0),
    sample(11, 0.20, 200),
    sample(11, 0.20, 5000),
  ]);
  assert.deepEqual(intervals, [
    { csrc: 11, startMs: 0, endMs: 200 },
    { csrc: 11, startMs: 5000, endMs: 5000 },
  ]);
});

test('samples below the speaking level are not speech', () => {
  const intervals = speakingIntervals([
    sample(11, 0.001, 0),
    sample(11, 0.002, 200),
  ]);
  assert.deepEqual(intervals, []);
});

test('two people talking are kept apart', () => {
  const intervals = speakingIntervals([
    sample(11, 0.20, 0),
    sample(22, 0.20, 100),
    sample(11, 0.20, 200),
    sample(22, 0.20, 300),
  ]);
  assert.deepEqual(intervals, [
    { csrc: 11, startMs: 0, endMs: 200 },
    { csrc: 22, startMs: 100, endMs: 300 },
  ]);
});

test('an empty recording has no speech in it', () => {
  assert.deepEqual(speakingIntervals([]), []);
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `cd bot && npm test`
Expected: FAIL — `Cannot find module './csrc-timeline'`.

- [ ] **Step 3: Write the minimal implementation**

Create `bot/src/csrc-timeline.ts`:

```ts
export interface Sample {
  csrc: number;
  audioLevel: number;
  atMs: number;
}

export interface Interval {
  csrc: number;
  startMs: number;
  endMs: number;
}

// Below this, the level is room noise rather than someone talking
const MIN_LEVEL = 0.01;
// Two bursts from one person closer together than this are one turn, not two
const SILENCE_GAP_MS = 1500;

export function speakingIntervals(
  samples: Sample[],
  opts: { minLevel?: number; silenceGapMs?: number } = {},
): Interval[] {
  const minLevel = opts.minLevel ?? MIN_LEVEL;
  const gap = opts.silenceGapMs ?? SILENCE_GAP_MS;

  const bySource = new Map<number, Sample[]>();
  for (const s of samples) {
    if (s.audioLevel < minLevel) continue;
    const list = bySource.get(s.csrc);
    if (list) list.push(s); else bySource.set(s.csrc, [s]);
  }

  const intervals: Interval[] = [];
  for (const [csrc, list] of bySource) {
    list.sort((a, b) => a.atMs - b.atMs);
    let current: Interval | null = null;
    for (const s of list) {
      if (current && s.atMs - current.endMs <= gap) {
        current.endMs = s.atMs;
      } else {
        current = { csrc, startMs: s.atMs, endMs: s.atMs };
        intervals.push(current);
      }
    }
  }

  return intervals.sort((a, b) => a.startMs - b.startMs || a.csrc - b.csrc);
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `cd bot && npm test`
Expected: PASS — 10 tests (5 from Task 1, 5 new).

- [ ] **Step 5: Write the injected hook**

Create `bot/src/inject/rtc-hook.ts`. It is exported as a string because it runs inside the page, not in Node:

```ts
// Runs inside the Meet tab, before Meet's own code. Every RTCPeerConnection Meet creates is
// wrapped so its inbound audio receivers can be watched. Meet sends the loudest speakers as a
// handful of RTP streams rather than one per person, and the contributing-source (CSRC) ids on
// those streams are what say who is actually talking — which is why this reads the transport
// instead of the screen.
export const RTC_HOOK_SOURCE = `
(() => {
  const Original = window.RTCPeerConnection;
  if (!Original || window.__unittyHooked) return;
  window.__unittyHooked = true;

  window.__unittySamples = [];
  window.__unittyStartedAt = Date.now();
  const receivers = new Set();

  function watch(pc) {
    pc.addEventListener('track', (event) => {
      if (event.track && event.track.kind === 'audio' && event.receiver) receivers.add(event.receiver);
    });
  }

  window.RTCPeerConnection = function (...args) {
    const pc = new Original(...args);
    watch(pc);
    return pc;
  };
  window.RTCPeerConnection.prototype = Original.prototype;

  setInterval(() => {
    const atMs = Date.now() - window.__unittyStartedAt;
    for (const receiver of receivers) {
      const sources = receiver.getContributingSources ? receiver.getContributingSources() : [];
      for (const s of sources) {
        if (typeof s.audioLevel !== 'number') continue;
        window.__unittySamples.push({ csrc: s.source, audioLevel: s.audioLevel, atMs });
      }
      // Some builds report the stream's own synchronization source instead of contributing ones
      const own = receiver.getSynchronizationSources ? receiver.getSynchronizationSources() : [];
      for (const s of own) {
        if (typeof s.audioLevel !== 'number') continue;
        window.__unittySamples.push({ csrc: s.source, audioLevel: s.audioLevel, atMs });
      }
    }
  }, 200);
})();
`;
```

- [ ] **Step 6: Inject it before Meet loads**

Modify `bot/src/browser.ts` — add the import and one call inside `launchBot`, before the function returns:

```ts
import { RTC_HOOK_SOURCE } from './inject/rtc-hook';
```

```ts
  // Added before any navigation so it wins the race against Meet's own scripts
  await context.addInitScript({ content: RTC_HOOK_SOURCE });

  const page = context.pages()[0] ?? (await context.newPage());
  return { context, page, close: () => context.close() };
```

- [ ] **Step 7: Write the observations to a report**

Modify `bot/src/index.ts` — replace the `finally` block with one that saves what was seen:

```ts
} finally {
  const samples = await bot.page
    .evaluate(() => (window as unknown as { __unittySamples?: unknown[] }).__unittySamples ?? [])
    .catch(() => []);
  const outDir = process.env.BOT_OUT_DIR ?? path.join(process.cwd(), 'out');
  await fs.mkdir(outDir, { recursive: true });
  const reportPath = path.join(outDir, `samples-${Date.now()}.json`);
  await fs.writeFile(reportPath, JSON.stringify(samples, null, 2));
  console.log(`${(samples as unknown[]).length} samples written to ${reportPath}`);

  await leaveCall(bot.page).catch(() => {});
  await bot.close();
}
```

Add at the top of the file: `import fs from 'node:fs/promises';`

- [ ] **Step 8: Verify against a real call**

Join a call with the bot and talk for about thirty seconds, with pauses.

`cd bot && npm run join -- <your meet link>`

Then check the report:

```bash
node -e "const s=require('./out/samples-<stamp>.json'); const by={}; for(const x of s) by[x.csrc]=(by[x.csrc]||0)+1; console.log(by)"
```

Expected: at least one CSRC with hundreds of samples, and its `audioLevel` clearly higher while someone is talking than while nobody is. Write the observed CSRCs and counts into the commit message.

If no samples appear at all, the hook did not run before Meet's code — stop and fix that before continuing.

- [ ] **Step 9: Commit**

```bash
git add bot/
git commit -m "Watch Meet's audio transport to see which source is speaking"
```

---

### Task 3: Put a name to a source — the go/no-go gate

**This task decides whether the rest of the plan happens.** The spec: "If per-participant audio cannot be captured reliably, the architecture changes and we should find that out in week one, not week five."

**Files:**
- Create: `bot/src/name-map.ts`
- Create: `bot/src/name-map.test.ts`
- Modify: `bot/src/inject/rtc-hook.ts` (gather name evidence)
- Modify: `bot/src/index.ts` (report the resolved mapping)

**Interfaces:**
- Consumes: `Sample`, `speakingIntervals` from Task 2.
- Produces:
  - `interface NameEvidence { csrc: number; name: string; atMs: number }`
  - `resolveNames(evidence: NameEvidence[], opts?: { minSightings?: number; agreement?: number }): Map<number, string>`
  - `labelFor(csrc: number, names: Map<number, string>, order: number[]): string`

- [ ] **Step 1: Write the failing test**

Create `bot/src/name-map.test.ts`. These tests are where the spec's hard requirement is enforced, so they are the ones to get right:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveNames, labelFor, type NameEvidence } from './name-map';

const saw = (csrc: number, name: string, atMs: number): NameEvidence => ({ csrc, name, atMs });

test('a source seen with the same name every time gets that name', () => {
  const names = resolveNames([
    saw(11, 'Tamar', 0),
    saw(11, 'Tamar', 1000),
    saw(11, 'Tamar', 2000),
  ]);
  assert.equal(names.get(11), 'Tamar');
});

test('a source with disagreeing names gets no name at all', () => {
  const names = resolveNames([
    saw(11, 'Tamar', 0),
    saw(11, 'Giorgi', 1000),
    saw(11, 'Tamar', 2000),
    saw(11, 'Giorgi', 3000),
  ]);
  assert.equal(names.has(11), false);
});

test('one stray sighting does not outvote a consistent name', () => {
  const names = resolveNames([
    saw(11, 'Tamar', 0),
    saw(11, 'Tamar', 1000),
    saw(11, 'Tamar', 2000),
    saw(11, 'Tamar', 3000),
    saw(11, 'Giorgi', 4000),
  ]);
  assert.equal(names.get(11), 'Tamar');
});

test('too little evidence is not enough to name anyone', () => {
  const names = resolveNames([saw(11, 'Tamar', 0), saw(11, 'Tamar', 1000)]);
  assert.equal(names.has(11), false);
});

test('two sources keep their own names', () => {
  const names = resolveNames([
    saw(11, 'Tamar', 0), saw(11, 'Tamar', 1000), saw(11, 'Tamar', 2000),
    saw(22, 'Giorgi', 0), saw(22, 'Giorgi', 1000), saw(22, 'Giorgi', 2000),
  ]);
  assert.equal(names.get(11), 'Tamar');
  assert.equal(names.get(22), 'Giorgi');
});

test('an unnamed source is numbered, in a stable order', () => {
  const names = new Map<number, string>([[22, 'Giorgi']]);
  const order = [11, 22, 33];
  assert.equal(labelFor(11, names, order), 'Speaker 1');
  assert.equal(labelFor(22, names, order), 'Giorgi');
  assert.equal(labelFor(33, names, order), 'Speaker 3');
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `cd bot && npm test`
Expected: FAIL — `Cannot find module './name-map'`.

- [ ] **Step 3: Write the minimal implementation**

Create `bot/src/name-map.ts`:

```ts
export interface NameEvidence {
  csrc: number;
  name: string;
  atMs: number;
}

// A name is only used when the evidence for it is both plentiful and consistent. Refusing to name
// someone costs a little clarity; naming the wrong person costs the reader's trust in everything
// else on the page, so the thresholds here are deliberately strict.
const MIN_SIGHTINGS = 3;
const AGREEMENT = 0.8;

export function resolveNames(
  evidence: NameEvidence[],
  opts: { minSightings?: number; agreement?: number } = {},
): Map<number, string> {
  const minSightings = opts.minSightings ?? MIN_SIGHTINGS;
  const agreement = opts.agreement ?? AGREEMENT;

  const counts = new Map<number, Map<string, number>>();
  for (const { csrc, name } of evidence) {
    const trimmed = name.trim();
    if (!trimmed) continue;
    let forSource = counts.get(csrc);
    if (!forSource) counts.set(csrc, (forSource = new Map()));
    forSource.set(trimmed, (forSource.get(trimmed) ?? 0) + 1);
  }

  const resolved = new Map<number, string>();
  for (const [csrc, forSource] of counts) {
    let total = 0;
    let best = '';
    let bestCount = 0;
    for (const [name, count] of forSource) {
      total += count;
      if (count > bestCount) { best = name; bestCount = count; }
    }
    if (total >= minSightings && bestCount / total >= agreement) resolved.set(csrc, best);
  }

  return resolved;
}

export function labelFor(csrc: number, names: Map<number, string>, order: number[]): string {
  const name = names.get(csrc);
  if (name) return name;
  const index = order.indexOf(csrc);
  return `Speaker ${index >= 0 ? index + 1 : order.length + 1}`;
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `cd bot && npm test`
Expected: PASS — 16 tests.

- [ ] **Step 5: Gather name evidence in the page**

The selectors below are a **starting point, not known-good**. Meet's markup is not documented and
changes; the first thing to do is open a real call in the bot's Chrome, inspect a participant tile
while that person talks, and correct these selectors to match what is actually there. Step 7 is
what proves them, and it is expected that this step needs a round of adjustment first.

Modify `bot/src/inject/rtc-hook.ts` — inside the `setInterval`, after the sample loop, add:

```js
    // Who Meet is showing as talking right now. Meet marks the speaking participant's tile, and
    // the tile carries the participant's name. This is evidence, not truth: it is cross-checked
    // against the CSRC that is loud at the same moment, and a name is only accepted when the two
    // agree over and over.
    const loudest = window.__unittySamples
      .filter((s) => s.atMs === atMs && s.audioLevel >= 0.05)
      .sort((a, b) => b.audioLevel - a.audioLevel)[0];
    if (loudest) {
      for (const tile of document.querySelectorAll('[data-participant-id]')) {
        const speaking = tile.querySelector('[class*="speaking"], [data-is-speaking="true"]');
        const name = tile.querySelector('[data-self-name], [class*="name"]')?.textContent?.trim();
        if (speaking && name) window.__unittyNames.push({ csrc: loudest.csrc, name, atMs });
      }
    }
```

And add `window.__unittyNames = [];` next to `window.__unittySamples = [];`.

- [ ] **Step 6: Report the mapping**

Modify `bot/src/index.ts` — in the `finally` block, alongside the samples:

```ts
  const evidence = await bot.page
    .evaluate(() => (window as unknown as { __unittyNames?: unknown[] }).__unittyNames ?? [])
    .catch(() => []);
  const names = resolveNames(evidence as NameEvidence[]);
  const order = [...new Set((samples as Sample[]).map((s) => s.csrc))].sort((a, b) => a - b);
  for (const csrc of order) console.log(`csrc ${csrc} -> ${labelFor(csrc, names, order)}`);
```

Add the imports: `import { resolveNames, labelFor, type NameEvidence } from './name-map';` and `import type { Sample } from './csrc-timeline';`

- [ ] **Step 7: The gate — verify with two real people on two accounts**

This cannot be checked alone: both participants must be different Google accounts on different machines, because one account joined twice does not prove that two people get different CSRCs.

1. Person A and person B join the call; the bot joins too.
2. A talks for 30 seconds, then B talks for 30 seconds, then both briefly together.
3. Read the printed mapping.

**Pass:** two distinct CSRCs appear, each resolved to the right person's name, and the loud CSRC matches who was actually talking.

**Fail:** one CSRC for both people, names that do not resolve, or names attached to the wrong source.

If it fails, **stop here.** Write up what was observed in `docs/superpowers/specs/2026-09-23-unitty-bot-design.md` under "What could go wrong", and report back. The spec's fallback is a bot platform such as Recall.ai that already solves this for a per-hour fee. Do not start Task 4 on a broken foundation.

- [ ] **Step 8: Commit**

```bash
git add bot/ docs/
git commit -m "Resolve a speaking source to a participant's name, or refuse to"
```

---

### Task 4: Record one audio file per participant

**Only start this task if Task 3 passed.**

**Files:**
- Create: `bot/src/output.ts`
- Create: `bot/src/output.test.ts`
- Modify: `bot/src/inject/rtc-hook.ts` (record each inbound track)
- Modify: `bot/src/index.ts` (write the audio files and the manifest)

**Interfaces:**
- Consumes: `resolveNames`, `labelFor` from Task 3; `speakingIntervals`, `Sample` from Task 2.
- Produces:
  - `interface TrackFile { label: string; csrc: number; fileName: string }`
  - `trackFileName(label: string, csrc: number): string`
  - `interface BotManifest { meetingCode: string; startedAt: string; endedAt: string; tracks: TrackFile[] }`
  - `buildManifest(args: { meetingCode: string; startedAt: Date; endedAt: Date; tracks: TrackFile[] }): BotManifest`

- [ ] **Step 1: Write the failing test**

Create `bot/src/output.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trackFileName, buildManifest } from './output';

test('a name becomes a usable file name', () => {
  assert.equal(trackFileName('Tamar', 11), 'Tamar (11).webm');
});

test('characters a file system refuses are removed', () => {
  assert.equal(trackFileName('A/B:C*?"<>|D', 11), 'A-B-C-----D (11).webm');
});

test('two people with the same display name still get separate files', () => {
  assert.notEqual(trackFileName('Gigi', 11), trackFileName('Gigi', 22));
});

test('the manifest records the call and every track', () => {
  const manifest = buildManifest({
    meetingCode: 'abc-defg-hij',
    startedAt: new Date('2026-09-23T10:00:00.000Z'),
    endedAt: new Date('2026-09-23T10:30:00.000Z'),
    tracks: [{ label: 'Tamar', csrc: 11, fileName: 'Tamar (11).webm' }],
  });
  assert.deepEqual(manifest, {
    meetingCode: 'abc-defg-hij',
    startedAt: '2026-09-23T10:00:00.000Z',
    endedAt: '2026-09-23T10:30:00.000Z',
    tracks: [{ label: 'Tamar', csrc: 11, fileName: 'Tamar (11).webm' }],
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `cd bot && npm test`
Expected: FAIL — `Cannot find module './output'`.

- [ ] **Step 3: Write the minimal implementation**

Create `bot/src/output.ts`:

```ts
export interface TrackFile {
  label: string;
  csrc: number;
  fileName: string;
}

export interface BotManifest {
  meetingCode: string;
  startedAt: string;
  endedAt: string;
  tracks: TrackFile[];
}

// The source id is part of the name on purpose: two people in a call can share a display name, and
// silently merging their audio into one file would be worse than an ugly file name.
export function trackFileName(label: string, csrc: number): string {
  const safe = label.replace(/[\\/:*?"<>|]/g, '-').trim() || 'Unknown';
  return `${safe} (${csrc}).webm`;
}

export function buildManifest(args: {
  meetingCode: string;
  startedAt: Date;
  endedAt: Date;
  tracks: TrackFile[];
}): BotManifest {
  return {
    meetingCode: args.meetingCode,
    startedAt: args.startedAt.toISOString(),
    endedAt: args.endedAt.toISOString(),
    tracks: args.tracks,
  };
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `cd bot && npm test`
Expected: PASS — 20 tests.

- [ ] **Step 5: Record each inbound track in the page**

Modify `bot/src/inject/rtc-hook.ts` — inside the `track` listener, start a recorder for the track and keep its chunks:

```js
      if (event.track && event.track.kind === 'audio' && event.receiver) {
        receivers.add(event.receiver);

        // One recorder per inbound stream. Which person each stream belongs to is worked out
        // afterwards from the CSRCs that were loud while it was playing.
        const id = 'track' + (window.__unittyRecordings.length + 1);
        const recorder = new MediaRecorder(new MediaStream([event.track]), { mimeType: 'audio/webm;codecs=opus' });
        const entry = { id, chunks: [], startedAt: Date.now() - window.__unittyStartedAt, receiver: event.receiver };
        recorder.ondataavailable = (e) => { if (e.data.size > 0) entry.chunks.push(e.data); };
        recorder.start(1000);
        entry.recorder = recorder;
        window.__unittyRecordings.push(entry);
      }
```

Add `window.__unittyRecordings = [];` next to the other globals, and a helper the Node side calls to finish and read them:

```js
  window.__unittyFinish = async () => {
    const out = [];
    for (const entry of window.__unittyRecordings) {
      if (entry.recorder.state !== 'inactive') {
        await new Promise((resolve) => { entry.recorder.onstop = resolve; entry.recorder.stop(); });
      }
      const blob = new Blob(entry.chunks, { type: 'audio/webm' });
      const buffer = await blob.arrayBuffer();
      out.push({ id: entry.id, startedAt: entry.startedAt, base64: btoa(String.fromCharCode(...new Uint8Array(buffer))) });
    }
    return out;
  };
```

- [ ] **Step 6: Write the files and the manifest in Node**

Modify `bot/src/index.ts` — in the `finally` block, before leaving the call:

```ts
  const recordings = await bot.page.evaluate(
    () => (window as unknown as { __unittyFinish: () => Promise<{ id: string; startedAt: number; base64: string }[]> }).__unittyFinish(),
  ).catch(() => []);

  // `order` and `names` were already worked out in Task 3 — reuse them rather than declaring again
  const tracks = recordings.map((rec, i) => {
    const csrc = order[i] ?? 0;
    const label = labelFor(csrc, names, order);
    const fileName = trackFileName(label, csrc);
    return { label, csrc, fileName, base64: rec.base64 };
  });

  for (const track of tracks) {
    await fs.writeFile(path.join(outDir, track.fileName), Buffer.from(track.base64, 'base64'));
  }
  await fs.writeFile(
    path.join(outDir, 'manifest.json'),
    JSON.stringify(buildManifest({
      meetingCode: meetingCodeFrom(meetUrl) ?? 'unknown',
      startedAt, endedAt: new Date(),
      tracks: tracks.map(({ label, csrc, fileName }) => ({ label, csrc, fileName })),
    }), null, 2),
  );
  console.log(`${tracks.length} tracks written to ${outDir}`);
```

Add `const startedAt = new Date();` just before `joinCall`, and the imports for `buildManifest`, `trackFileName` and `meetingCodeFrom`.

- [ ] **Step 7: Verify against a real call**

Repeat the Task 3 setup: two people on two accounts, each talking in turn.

Expected in `bot/out/`: one `.webm` per participant, named after that participant, each containing **only that person's voice**, plus a `manifest.json` listing them. Play each file and confirm the right voice is in it.

This is the check that matters. If a file contains the wrong person, the labelling is wrong and must be fixed before this task is done.

- [ ] **Step 8: Commit**

```bash
git add bot/
git commit -m "Record one audio file per participant, named after that participant"
```

---

### Task 5: Stop cleanly when the call ends

**Files:**
- Create: `bot/src/call-end.ts`
- Create: `bot/src/call-end.test.ts`
- Modify: `bot/src/index.ts`

**Interfaces:**
- Consumes: `isInCall` from Task 1.
- Produces: `shouldStop(state: { inCall: boolean; missingSinceMs: number | null; nowMs: number; graceMs?: number }): boolean`

- [ ] **Step 1: Write the failing test**

Create `bot/src/call-end.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldStop } from './call-end';

test('stays while the call is on', () => {
  assert.equal(shouldStop({ inCall: true, missingSinceMs: null, nowMs: 10000 }), false);
});

test('does not give up the moment the call controls flicker', () => {
  assert.equal(shouldStop({ inCall: false, missingSinceMs: 9000, nowMs: 10000 }), false);
});

test('stops once the call has been gone long enough', () => {
  assert.equal(shouldStop({ inCall: false, missingSinceMs: 1000, nowMs: 10000 }), true);
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `cd bot && npm test`
Expected: FAIL — `Cannot find module './call-end'`.

- [ ] **Step 3: Write the minimal implementation**

Create `bot/src/call-end.ts`:

```ts
// Meet redraws its controls often enough that a single missing frame means nothing. Waiting a few
// seconds before believing the call has ended avoids cutting a recording short mid-sentence.
const GRACE_MS = 6000;

export function shouldStop(state: {
  inCall: boolean;
  missingSinceMs: number | null;
  nowMs: number;
  graceMs?: number;
}): boolean {
  if (state.inCall || state.missingSinceMs === null) return false;
  return state.nowMs - state.missingSinceMs >= (state.graceMs ?? GRACE_MS);
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `cd bot && npm test`
Expected: PASS — 23 tests.

- [ ] **Step 5: Use it in the wait loop**

Modify `bot/src/index.ts` — replace the `while (await isInCall(bot.page))` loop:

```ts
  let missingSinceMs: number | null = null;
  for (;;) {
    const inCall = await isInCall(bot.page).catch(() => false);
    const nowMs = Date.now();
    if (inCall) missingSinceMs = null;
    else missingSinceMs ??= nowMs;
    if (shouldStop({ inCall, missingSinceMs, nowMs })) break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  console.log('The call ended.');
```

Add the import: `import { shouldStop } from './call-end';`

- [ ] **Step 6: Verify against a real call**

Join a call, let the bot in, then **end the call from the other side** rather than stopping the bot.

Expected: within about six seconds the bot prints "The call ended.", writes its files and the manifest, and exits with status 0. The audio files are complete — the last thing said before hanging up is in them.

- [ ] **Step 7: Commit**

```bash
git add bot/
git commit -m "Leave and write the recording when the call ends by itself"
```

---

### Task 6: Announce the bot in the chat

The spec has the bot "announce itself in the chat". The browser extension has failed at this
repeatedly because Meet moves the chat button into an overflow menu at narrower window widths, and
the extension runs on whatever window the user happens to have. The bot's window is a fixed
1280×800 set in `browser.ts`, and its Chrome version is ours to pin — but the logic is still
written to handle both placements, because the alternative is being wrong on the day Meet changes
its breakpoints.

**Files:**
- Create: `bot/src/chat-plan.ts`
- Create: `bot/src/chat-plan.test.ts`
- Create: `bot/src/announce.ts`
- Modify: `bot/src/index.ts`

**Interfaces:**
- Consumes: `joinCall` from Task 1.
- Produces:
  - `interface ToolbarButton { icon: string; visible: boolean }`
  - `type ChatStep = 'click-chat' | 'open-overflow' | 'give-up'`
  - `planChatOpen(buttons: ToolbarButton[]): ChatStep`
  - `announce(page: Page, message: string): Promise<boolean>`

- [ ] **Step 1: Write the failing test**

Create `bot/src/chat-plan.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planChatOpen, type ToolbarButton } from './chat-plan';

const button = (icon: string, visible: boolean): ToolbarButton => ({ icon, visible });

test('clicks the chat button when it is right there', () => {
  assert.equal(planChatOpen([button('chat', true), button('more_vert', true)]), 'click-chat');
});

test('opens the overflow menu when chat has been tucked into it', () => {
  assert.equal(planChatOpen([button('chat', false), button('more_vert', true)]), 'open-overflow');
});

test('gives up when there is no way through at all', () => {
  assert.equal(planChatOpen([button('mic', true)]), 'give-up');
});

test('gives up when chat is hidden and there is no overflow menu either', () => {
  assert.equal(planChatOpen([button('chat', false)]), 'give-up');
});

test('an empty toolbar is not a reason to click blindly', () => {
  assert.equal(planChatOpen([]), 'give-up');
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `cd bot && npm test`
Expected: FAIL — `Cannot find module './chat-plan'`.

- [ ] **Step 3: Write the minimal implementation**

Create `bot/src/chat-plan.ts`:

```ts
export interface ToolbarButton {
  icon: string;
  visible: boolean;
}

export type ChatStep = 'click-chat' | 'open-overflow' | 'give-up';

// Clicking a button that is in the document but inside a closed menu does nothing, and looks
// exactly like success from the caller's side. Visibility is therefore part of the decision, not
// an afterthought — this is the bug that made the extension's chat notice fail silently.
export function planChatOpen(buttons: ToolbarButton[]): ChatStep {
  if (buttons.some((b) => b.icon === 'chat' && b.visible)) return 'click-chat';

  const chatIsHidden = buttons.some((b) => b.icon === 'chat' && !b.visible);
  const overflow = buttons.some((b) => b.icon === 'more_vert' && b.visible);
  if (chatIsHidden && overflow) return 'open-overflow';

  return 'give-up';
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `cd bot && npm test`
Expected: PASS — 28 tests.

- [ ] **Step 5: Write the announcement**

Create `bot/src/announce.ts`:

```ts
import type { Page } from 'playwright';
import { planChatOpen, type ToolbarButton } from './chat-plan';

const readToolbar = () =>
  Array.from(document.querySelectorAll('button'))
    .map((b) => ({
      icon: b.querySelector('i.google-symbols, .google-symbols')?.textContent?.trim() ?? '',
      visible: (b as HTMLElement).offsetParent !== null,
    }))
    .filter((b) => b.icon);

async function clickIcon(page: Page, icon: string): Promise<void> {
  await page.locator(`button:has(.google-symbols:text-is("${icon}"))`).first().click({ timeout: 5000 });
}

// Returns whether the message was actually posted. The caller treats false as worth reporting:
// a notice nobody saw is not the same as a notice that went out.
export async function announce(page: Page, message: string): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const step = planChatOpen((await page.evaluate(readToolbar)) as ToolbarButton[]);
    if (step === 'give-up') return false;

    if (step === 'open-overflow') {
      await clickIcon(page, 'more_vert').catch(() => {});
      await page.waitForTimeout(500);
      continue;
    }

    await clickIcon(page, 'chat').catch(() => {});
    const box = page.locator('textarea, [contenteditable="true"]').last();
    if (!(await box.isVisible({ timeout: 5000 }).catch(() => false))) return false;

    await box.fill(message).catch(async () => { await box.type(message); });
    await page.keyboard.press('Enter');
    await page.waitForTimeout(500);
    return (await box.inputValue().catch(() => '')) === '';
  }
  return false;
}
```

- [ ] **Step 6: Use it right after joining**

Modify `bot/src/index.ts` — after `joinCall` succeeds:

```ts
  const NOTICE = 'Hi everyone — Unitty Recorder is transcribing this meeting so everyone can give the conversation their full attention.';
  const announced = await announce(bot.page, NOTICE);
  console.log(announced ? 'Chat notice posted.' : 'Chat notice could NOT be posted.');
```

Add the import: `import { announce } from './announce';`

- [ ] **Step 7: Verify against a real call, at more than one window size**

The point of this task is that it does not depend on the window, so one size proves nothing. In
`browser.ts`, temporarily set `viewport` to each of these and run a real call for each:

`{ width: 1280, height: 720 }`, `{ width: 1440, height: 900 }`, `{ width: 1920, height: 1080 }`, `{ width: 900, height: 700 }`

Expected: the notice appears in the Meet chat every time, and the log says "Chat notice posted."
The 900-wide case is the one that exercises the overflow-menu path — if it passes, the bug that
has been breaking the extension is genuinely handled.

Set `viewport` back to `{ width: 1280, height: 800 }` before committing.

- [ ] **Step 8: Commit**

```bash
git add bot/
git commit -m "Post the recording notice in the chat, whichever menu Meet hides it in"
```

---

## What this plan deliberately leaves out

These come next, each as its own plan, and each depends on this one working:

- **Server ingestion** — an endpoint that accepts per-participant tracks and a manifest, transcribes each track on its own, and merges the segments by time. The transcription pipeline in `server/src/services/transcription.ts` already does the hard part for a single track.
- **Dispatcher and queue** — one container per call, started on demand, stopped when the call ends.
- **"Join now" from the site**, then the **calendar watcher**.
- **Organisations and multi-tenancy.**
- **Scale and cost tests** at 10 and then 50 concurrent calls.

The Chrome extension keeps working throughout and is not touched by this plan.
