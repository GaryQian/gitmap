// M3 smoke test: a demo opens from the landing page and one of its files reads from the content pack.
import { expect, test } from '@playwright/test';

test('a demo opens and a file reads from its content pack', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('/');
  // the demo pill is listed under the "Choose a folder" button
  await page.getByText('emerge', { exact: false }).first().click();
  await page.waitForFunction(() => (window as any).__starmapApp?.store.getState().phase === 'map', null, { timeout: 45000 });
  const info = await page.evaluate(async () => {
    const { session } = (window as any).__starmapApp.store.getState();
    const meta = session.replica.meta;
    const units = session.replica.table('unit');
    const bytes: Uint8Array = await session.content.read('f:README.md');
    return {
      source: meta.source,
      license: meta.demo?.license,
      units: units.count,
      layers: [...session.replica.layers.keys()].sort(),
      readme: new TextDecoder().decode(bytes).slice(0, 200),
      aiAvailable: session.ai?.available ?? false,
    };
  });
  expect(info.source).toBe('demo');
  expect(info.license).toBe('MIT');
  expect(info.units).toBeGreaterThan(100);
  expect(info.layers).toEqual(['knowledgeRisk', 'ownership', 'recency', 'tests']);
  expect(info.readme.toLowerCase()).toContain('emerge');
  // a demo makes no model calls (PLAN.md §11.4)
  expect(info.aiAvailable).toBe(false);
  expect(errors).toEqual([]);
});
