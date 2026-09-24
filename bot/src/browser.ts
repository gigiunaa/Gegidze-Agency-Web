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
    // Real Chrome rather than the bundled Chromium: Meet is built for Chrome, and Chromium ships
    // without the proprietary codecs Meet can ask for. In the container this is the Chrome we pin.
    channel: process.env.BOT_CHROME_CHANNEL ?? 'chrome',
    headless: opts.headless ?? false,
    args: CHROME_ARGS,
    permissions: ['microphone', 'camera'],
    viewport: { width: 1280, height: 800 },
  });

  const page = context.pages()[0] ?? (await context.newPage());
  return { context, page, close: () => context.close() };
}
