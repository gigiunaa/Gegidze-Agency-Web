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
  const samples = (await bot.page
    .evaluate(() => (window as unknown as { __unittySamples?: Sample[] }).__unittySamples ?? [])
    .catch(() => [])) as Sample[];

  await fs.mkdir(outDir, { recursive: true });
  const reportPath = path.join(outDir, `samples-${Date.now()}.json`);
  await fs.writeFile(reportPath, JSON.stringify(samples, null, 2));

  const bySource = new Map<number, number>();
  for (const s of samples) bySource.set(s.csrc, (bySource.get(s.csrc) ?? 0) + 1);
  console.log(`${samples.length} samples from ${bySource.size} source(s), written to ${reportPath}`);
  for (const [csrc, count] of bySource) {
    const talking = speakingIntervals(samples.filter((s) => s.csrc === csrc));
    console.log(`  csrc ${csrc}: ${count} samples, ${talking.length} turn(s) of speech`);
  }

  await leaveCall(bot.page).catch(() => {});
  await bot.close();
}
