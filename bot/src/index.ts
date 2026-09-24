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

try {
  console.log(`Joining ${meetUrl}...`);
  await joinCall(bot.page, meetUrl, 'Unitty Recorder');
  console.log('In the call. Press Ctrl+C to stop.');

  while (!stopping && (await isInCall(bot.page).catch(() => false))) {
    await drain(bot.page);
    await new Promise((r) => setTimeout(r, 2000));
  }
  await drain(bot.page);
  console.log(stopping ? 'Stopped.' : 'The call ended.');
} finally {
  report();
  await leaveCall(bot.page).catch(() => {});
  await bot.close().catch(() => {});
}
