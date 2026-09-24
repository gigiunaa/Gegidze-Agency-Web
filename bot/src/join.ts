import type { Page } from 'playwright';
import { meetingCodeFrom } from './meet-url';

// Meet's button labels are translated, but the icon ligatures inside them are not, so the call
// controls are found by icon name. This is the same approach the browser extension settled on.
const IN_CALL_ICON = 'call_end';

// The join screen takes its time: the name box and the join button appear well after the document
// is ready, so everything here waits on the element rather than on the page load.
const SCREEN_READY_MS = 60000;
const ADMITTED_MS = 120000;

// Meet greets a new guest with a notice or two. They sit over the join screen, so they go first.
async function dismissNotices(page: Page): Promise<void> {
  for (const label of [/got it/i, /^dismiss$/i, /^close$/i]) {
    const button = page.locator('button:visible').filter({ hasText: label }).first();
    if (await button.isVisible({ timeout: 1000 }).catch(() => false)) {
      await button.click({ timeout: 3000 }).catch(() => {});
    }
  }
}

export async function joinCall(page: Page, meetUrl: string, displayName?: string): Promise<void> {
  const code = meetingCodeFrom(meetUrl);
  if (!code) throw new Error(`Not a Google Meet link: ${meetUrl}`);

  await page.goto(`https://meet.google.com/${code}`, { waitUntil: 'domcontentloaded' });

  // The join button is the thing worth waiting for; everything else on this screen is optional
  const joinButton = page
    .locator('button:visible')
    .filter({ hasText: /join now|ask to join|შეუერთდი/i })
    .first();
  await joinButton.waitFor({ state: 'visible', timeout: SCREEN_READY_MS });

  await dismissNotices(page);

  // A guest has to give a name, and Meet keeps the join button disabled until one is there. A
  // signed-in bot never sees this box, so its absence is not a problem.
  const nameBox = page.locator('input[type="text"]:visible').first();
  if (displayName && (await nameBox.isVisible({ timeout: 2000 }).catch(() => false))) {
    await nameBox.fill(displayName);
  }

  // Join muted and unseen. Both are toggles, so they are only touched while still switched on.
  for (const on of ['videocam', 'mic']) {
    const button = page.locator(`button:visible:has(.google-symbols:text-is("${on}"))`).first();
    if (await button.isVisible({ timeout: 2000 }).catch(() => false)) {
      await button.click({ timeout: 3000 }).catch(() => {});
    }
  }

  // Playwright waits for the button to become enabled, which is what filling the name achieves
  await joinButton.click({ timeout: 30000 });

  // Being let in can take a while: a guest waits in the lobby until somebody admits them
  await page.waitForFunction(
    (icon) => Array.from(document.querySelectorAll('i')).some((i) => i.textContent?.trim() === icon),
    IN_CALL_ICON,
    { timeout: ADMITTED_MS },
  );
}

export function isInCall(page: Page): Promise<boolean> {
  return page.evaluate(
    (icon) => Array.from(document.querySelectorAll('i')).some((i) => i.textContent?.trim() === icon),
    IN_CALL_ICON,
  );
}

export async function leaveCall(page: Page): Promise<void> {
  const hangUp = page.locator(`button:has(.google-symbols:text-is("${IN_CALL_ICON}"))`).first();
  await hangUp.click({ timeout: 10000 }).catch(() => {});
}
