// M1 smoke test: the /dev harness shows the expected number of spheres.
import { expect, test } from '@playwright/test';

test('dev harness renders a synthetic model', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('/dev.html?n=500&seed=2');
  await page.waitForFunction(() => (window as any).__gitmap?.state?.ready === true, null, { timeout: 30000 });
  const info = await page.evaluate(() => {
    const g = (window as any).__gitmap;
    return { units: g.session.replica.table('unit').count, spheres: g.render.stats().spheres };
  });
  expect(info.units).toBe(500);
  expect(info.spheres).toBe(500);
  expect(errors).toEqual([]);
});
