// Temporary: every shipped demo opens, with its notes and files. Deleted after the check.
import { expect, test } from '@playwright/test';

const DEMOS = [
  { name: 'starmap', file: 'package.json' },
  { name: 'react', file: 'packages/react/index.js' },
  { name: 'tensorflow', file: 'tensorflow/python/framework/ops.py' },
];

for (const demo of DEMOS) {
  test(`${demo.name} demo`, async ({ page }) => {
    test.setTimeout(240000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.setViewportSize({ width: 1400, height: 880 });
    await page.goto('/');
    const t0 = Date.now();
    await page.getByRole('button', { name: new RegExp(`${demo.name}.*demo`, 'i') }).first().click();
    await page.waitForFunction(() => (window as any).__starmapApp?.store.getState().phase === 'map', null, { timeout: 120000 });
    const revealMs = Date.now() - t0;
    const info = await page.evaluate(async (file) => {
      const { session } = (window as any).__starmapApp.store.getState();
      const a = session.replica.annotations;
      const pois = a.filter((x: any) => x.type === 'poi');
      const before = session.content.progress();
      const t = performance.now();
      const bytes: Uint8Array = await session.content.read(`f:${file}`);
      return {
        id: session.replica.meta.id,
        demo: session.replica.meta.demo,
        units: session.replica.table('unit').count,
        summaries: a.filter((x: any) => x.type === 'summary').length,
        pois: pois.length,
        details: pois.reduce((n: number, p: any) => n + Object.values(p.details ?? {}).filter((d: any) => d.status === 'ready').length, 0),
        tourSteps: a.find((x: any) => x.type === 'tour')?.steps.length ?? 0,
        filesDoneAtReveal: before.done,
        fileBytes: bytes.length,
        fileWaitMs: Math.round(performance.now() - t),
        layers: [...session.replica.layers.keys()].sort(),
      };
    }, demo.file);
    console.log(demo.name, 'reveal ms', revealMs, JSON.stringify(info));
    expect(info.id).toBe(`demo:${demo.name}`);
    expect(info.pois).toBeGreaterThan(5);
    expect(info.details).toBe(info.pois * 4);
    expect(info.tourSteps).toBeGreaterThan(2);
    expect(info.fileBytes).toBeGreaterThan(100);
    await expect(page.getByRole('button', { name: 'Chat', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: /tour the repo/i }).first()).toBeVisible();
    await page.waitForTimeout(3000);
    await page.screenshot({ path: `out/patches/demo/final-${demo.name}.png` });
    expect(errors).toEqual([]);
  });
}
