import fs from 'node:fs/promises';
import path from 'node:path';
import { launchBot } from './browser';
import { joinCall, isInCall, leaveCall } from './join';
import { speakingIntervals, type Sample } from './csrc-timeline';

const meetUrl = process.argv[2];
if (!meetUrl) {
  console.error('Usage: npm run join -- <meet-url>');
  process.exit(1);
}

const profileDir = process.env.BOT_PROFILE_DIR ?? path.join(process.cwd(), 'profile');
const outDir = process.env.BOT_OUT_DIR ?? path.join(process.cwd(), 'out');
const reportPath = path.join(outDir, `samples-${Date.now()}.json`);

// Kept on the Node side and written as they arrive. Reading everything out of the page at the end
// is how a run that is interrupted — a crash, a closed window, Ctrl+C — loses the whole call.
const collected: Sample[] = [];
let hooked = false;
let receivers = -1;
let debug: unknown = null;

await fs.mkdir(outDir, { recursive: true });

async function drain(page: import('playwright').Page): Promise<void> {
  const seen = await page
    .evaluate(() => {
      const w = window as unknown as {
        __unittyHooked?: boolean;
        __unittySamples?: Sample[];
        __unittyReceiverCount?: () => number;
      };
      // Taken, not copied: whatever is handed over here is already safe in Node
      const samples = w.__unittySamples ?? [];
      if (w.__unittySamples) w.__unittySamples = [];
      return {
        hooked: w.__unittyHooked === true,
        receivers: w.__unittyReceiverCount ? w.__unittyReceiverCount() : -1,
        debug: (w as { __unittyDebug?: unknown }).__unittyDebug ?? null,
        samples,
      };
    })
    .catch(() => null);

  if (!seen) return;
  hooked = seen.hooked;
  receivers = seen.receivers;
  debug = seen.debug;
  collected.push(...seen.samples);

  // Written every time, not only when something was captured: when a call produces nothing, this
  // file is the only account of why, and waiting until the end to write it is how that gets lost.
  await fs
    .writeFile(
      reportPath,
      JSON.stringify({ hooked, receivers, debug, samples: collected }, null, 2),
    )
    .catch(() => {});
}

function report(): void {
  const bySource = new Map<number, number>();
  for (const s of collected) bySource.set(s.csrc, (bySource.get(s.csrc) ?? 0) + 1);

  console.log(`hook installed: ${hooked}, inbound audio receivers seen: ${receivers}`);
  console.log('transport probe:', JSON.stringify(debug));
  console.log(`${collected.length} samples from ${bySource.size} source(s) -> ${reportPath}`);
  for (const [csrc, count] of bySource) {
    const turns = speakingIntervals(collected.filter((s) => s.csrc === csrc));
    console.log(`  csrc ${csrc}: ${count} samples, ${turns.length} turn(s) of speech`);
  }
}

const bot = await launchBot({ profileDir });

// Ctrl+C should end the call the same way hanging up does, not throw the run away
let stopping = false;
process.on('SIGINT', () => { stopping = true; });

// A stop that comes from outside the process kills it between the recording and the writing, and
// the call is gone. Given a time limit the bot ends itself, through the same path a real call's
// ending takes, and the files are always written.
// Windows will not pass a polite signal to this process, so "stop now" is a file. The loop
// watches for it, which means a recording can always be ended without killing anything.
const stopFile = path.join(outDir, 'stop');
await fs.rm(stopFile, { force: true }).catch(() => {});

const maxSeconds = Number(process.env.BOT_MAX_SECONDS) || 0;
if (maxSeconds > 0) {
  console.log(`Leaving by itself after ${maxSeconds}s.`);
  setTimeout(() => { stopping = true; }, maxSeconds * 1000).unref();
}

try {
  console.log(`Joining ${meetUrl}...`);
  await joinCall(bot.page, meetUrl, 'Unitty Recorder');
  console.log('In the call. Press Ctrl+C to stop.');

  const started = await bot.page
    .evaluate(() => (window as unknown as {
      __unittyStartTabAudio?: () => Promise<{ state: string; error: string; surface?: string }>;
    }).__unittyStartTabAudio?.())
    .catch((err: Error) => ({ state: 'failed', error: err.message, surface: '' }));
  console.log(started?.state === 'recording' ? `Recording the call (captured surface: ${started.surface ?? '?'}).` : `NOT recording: ${started?.error ?? 'no recorder'}`);

  // Meet redraws its controls constantly, and the hang-up button goes missing for a moment while
  // it does. Believing the first frame that lacks it ended runs after twenty seconds and threw
  // the recording away, so the call is only over once it has stayed gone.
  const GONE_FOR_MS = 15000;
  let goneSince: number | null = null;

  for (;;) {
    if (stopping) break;
    const inCall = await isInCall(bot.page).catch(() => false);
    if (inCall) {
      goneSince = null;
    } else {
      goneSince ??= Date.now();
      if (Date.now() - goneSince >= GONE_FOR_MS) break;
    }

    if (await fs.stat(stopFile).then(() => true).catch(() => false)) { stopping = true; break; }
    await drain(bot.page);
    await new Promise((r) => setTimeout(r, 2000));
  }
  await drain(bot.page);
  console.log(stopping ? 'Stopped.' : 'The call ended.');
} finally {
  report();
  // The call itself, as everyone in it heard it
  const call = await bot.page
    .evaluate(() => (window as unknown as {
      __unittyStopTabAudio?: () => Promise<{ state: string; error: string; bytes: number; base64: string; chunkCount?: number; trackState?: string; recorderState?: string }>;
    }).__unittyStopTabAudio?.())
    .catch(() => undefined);

  if (call && call.bytes > 0) {
    const callFile = path.join(outDir, `call-${Date.now()}.webm`);
    await fs.writeFile(callFile, Buffer.from(call.base64, 'base64'));
    console.log(`call audio: ${call.bytes} bytes -> ${callFile}`);
  } else {
    console.log(`call audio: nothing recorded — chunks ${call?.chunkCount ?? '?'}, track ${call?.trackState ?? '?'}, recorder ${call?.recorderState ?? '?'}${call?.error ? `, ${call.error}` : ''}`);
  }

  // Pull the per-track recordings out of the page and write them where they can be played
  const recordings = await bot.page
    .evaluate(() => (window as unknown as {
      __unittyFinish?: () => Promise<{ id: string; bytes: number; base64: string }[]>;
    }).__unittyFinish?.() ?? [])
    .catch(() => [] as { id: string; bytes: number; base64: string }[]);

  for (const rec of recordings) {
    const file = path.join(outDir, `${rec.id}.webm`);
    await fs.writeFile(file, Buffer.from(rec.base64, 'base64')).catch(() => {});
    console.log(`  ${rec.id}: ${rec.bytes} bytes -> ${file}`);
  }

  await leaveCall(bot.page).catch(() => {});
  await bot.close().catch(() => {});
}
