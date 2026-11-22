// Temporary: screenshots of the demo labels. Deleted after the check.
import { test } from '@playwright/test';

test('screenshots', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 880 });
  await page.goto('/');
  await page.waitForTimeout(1500);
  await page.screenshot({ path: 'out/patches/demo/landing.png' });
  await page.getByRole('button', { name: /starmap.*demo/i }).first().click();
  await page.waitForFunction(() => (window as any).__starmapApp?.store.getState().phase === 'map', null, { timeout: 45000 });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: 'out/patches/demo/map.png' });
  // the settings card with the Export row
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: 'out/patches/demo/settings.png' });
  await page.keyboard.press('Escape');
  // a file from the package in the sidebar
  await page.evaluate(() => (window as any).__starmapApp.store.setState({ openFile: 'u:src/content/package.ts' }));
  await page.waitForTimeout(1500);
  await page.screenshot({ path: 'out/patches/demo/file.png' });
});
