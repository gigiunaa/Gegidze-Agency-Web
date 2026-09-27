import { chromium, type BrowserContext, type Page } from 'playwright';
import { RTC_HOOK_SOURCE } from './inject/rtc-hook';

// Meet checks for a camera and a microphone before it will let anyone in, so Chrome is given fake
// ones and told to grant them without asking. The bot neither speaks nor is seen; it only listens.
const CHROME_ARGS = [
  '--use-fake-ui-for-media-stream',
  '--use-fake-device-for-media-stream',
  '--autoplay-policy=no-user-gesture-required',
  '--disable-blink-features=AutomationControlled',
  // A bot is killed far more often than it is closed politely, and Chrome then greets the next
  // run with a "restore pages?" bubble sitting over the join screen.
  '--hide-crash-restore-bubble',
  // Back on by default: it was turned off in case muting stopped Chrome decoding the audio, and
  // that turned out to make no difference — the tracks read silent either way. Meanwhile the bot
  // was echoing the call into the room and people muted themselves to stop it.
  ...(process.env.BOT_MUTE_AUDIO === 'false' ? [] : ['--mute-audio']),
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
    // Real Chrome rather than the bundled Chromium: Meet is built for Chrome, and Chromium ships
    // without the proprietary codecs Meet can ask for. In the container this is the Chrome we pin.
    channel: process.env.BOT_CHROME_CHANNEL ?? 'chrome',
    headless: opts.headless ?? false,
    args: CHROME_ARGS,
    permissions: ['microphone', 'camera'],
    viewport: { width: 1280, height: 800 },
  });

  // Added before any navigation so it wins the race against Meet's own scripts
  await context.addInitScript({ content: RTC_HOOK_SOURCE });

  const page = context.pages()[0] ?? (await context.newPage());
  return { context, page, close: () => context.close() };
}
