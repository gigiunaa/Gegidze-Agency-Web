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
