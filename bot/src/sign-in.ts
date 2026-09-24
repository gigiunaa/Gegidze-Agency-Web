// Opens the bot's own browser profile on Google's sign-in page and waits. Whoever runs this signs
// the bot in by hand, once; every later run reuses the session stored in the profile directory.
import path from 'node:path';
import { launchBot } from './browser';

const profileDir = process.env.BOT_PROFILE_DIR ?? path.join(process.cwd(), 'profile');

const bot = await launchBot({ profileDir });
await bot.page.goto('https://accounts.google.com/');

console.log(`Sign in as the account the bot should appear as, then close the browser window.`);
console.log(`The session will be kept in ${profileDir}`);

// Nothing to do but wait for the window to be closed
await new Promise<void>((resolve) => bot.context.on('close', () => resolve()));
console.log('Saved.');
