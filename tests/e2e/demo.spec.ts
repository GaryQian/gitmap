// Demo mode (plan/DEMO-MODE.md): a demo opens from its package, its files read from the same
// download, and it never stands in for (or blocks) a local repo of the same name.
import { expect, test, type Page } from '@playwright/test';

const DEMO = 'starmap';

const waitForMap = (page: Page) =>
  page.waitForFunction(() => (window as any).__starmapApp?.store.getState().phase === 'map', null, { timeout: 45000 });

test('a demo opens from its package and its files read from it', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('/');
  // the demo pill is listed with the saved repos, and says what it is
  const pill = page.getByRole('button', { name: new RegExp(`${DEMO}.*demo`, 'i') }).first();
  await expect(pill).toBeVisible();
  await pill.click();
  await waitForMap(page);
  const info = await page.evaluate(async () => {
    const { session } = (window as any).__starmapApp.store.getState();
    const meta = session.replica.meta;
    const bytes: Uint8Array = await session.content.read('f:package.json');
    let missing = '';
    try { await session.content.read('f:no/such/file.ts'); } catch (err) { missing = (err as Error).name; }
    return {
      id: meta.id,
      source: meta.source,
      license: meta.demo?.license,
      commit: meta.demo?.commit,
      units: session.replica.table('unit').count,
      layers: [...session.replica.layers.keys()].sort(),
      packageJson: new TextDecoder().decode(bytes).slice(0, 400),
      filesDone: session.content.progress().done,
      missing,
      aiAvailable: session.ai?.available ?? false,
      title: document.title,
    };
  });
  expect(info.id).toBe(`demo:${DEMO}`);
  expect(info.source).toBe('demo');
  expect(info.license).toBe('MIT');
  expect(info.commit).toMatch(/^[0-9a-f]{40}$/);
  expect(info.units).toBeGreaterThan(100);
  expect(info.layers).toEqual(expect.arrayContaining(['tests']));
  expect(info.packageJson).toContain('"vite"');
  expect(info.filesDone).toBe(true);
  // a file the package does not hold is reported as such, not as a failed download
  expect(info.missing).toBe('NotInPackageError');
  // a demo makes no model calls (PLAN.md §11.4)
  expect(info.aiAvailable).toBe(false);
  // labelled as a demo in the title pill, top left
  await expect(page.getByText('Demo', { exact: true }).first()).toBeVisible();
  expect(errors).toEqual([]);
});

test('a demo does not block a local repo of the same name', async ({ page }) => {
  await page.goto('/');
  // a local folder that happens to be called the same as the demo
  await page.evaluate(async (name) => {
    const file = (path: string, text: string) => ({ path, file: new File([text], path.split('/').pop()!) });
    await (window as any).__starmapApp.open({
      kind: 'directory',
      locator: {
        kind: 'files', name,
        files: [
          file('src/a.ts', "import { b } from './b';\nexport const a = b + 1;\n"),
          file('src/b.ts', 'export const b = 1;\n'),
          file('README.md', '# a local folder\n'),
        ],
      },
    });
  }, DEMO);
  await waitForMap(page);
  const local = await page.evaluate(async () => {
    const { session } = (window as any).__starmapApp.store.getState();
    const readme: Uint8Array = await session.content.read('f:README.md');
    return { id: session.replica.meta.id, source: session.replica.meta.source, name: session.replica.meta.name, units: session.replica.table('unit').count, readme: new TextDecoder().decode(readme) };
  });
  // parsed from the folder, under its own identity
  expect(local.name).toBe(DEMO);
  expect(local.source).toBe('folder');
  expect(local.id).not.toBe(`demo:${DEMO}`);
  expect(local.units).toBe(3);
  expect(local.readme).toContain('a local folder');

  // now the demo of the same name: it opens its own package, not the folder's map
  await page.evaluate(() => (window as any).__starmapApp.close());
  await page.getByRole('button', { name: new RegExp(`${DEMO}.*demo`, 'i') }).first().click();
  await waitForMap(page);
  const demo = await page.evaluate(() => {
    const { session } = (window as any).__starmapApp.store.getState();
    return { id: session.replica.meta.id, source: session.replica.meta.source, units: session.replica.table('unit').count };
  });
  expect(demo.id).toBe(`demo:${DEMO}`);
  expect(demo.source).toBe('demo');
  expect(demo.units).toBeGreaterThan(100);
});

test('an exported archive opens from the file button on the landing page', async ({ page }) => {
  await page.goto('/');
  const button = page.getByRole('button', { name: 'Choose an exported archive' });
  await expect(button).toBeVisible();
  // the same package the demo ships as: opened from a file, it is an import, not that demo
  await page.locator('input[type=file][accept]').setInputFiles('public/demo/starmap.starmap.zip');
  await waitForMap(page);
  const info = await page.evaluate(async () => {
    const { session } = (window as any).__starmapApp.store.getState();
    const bytes: Uint8Array = await session.content.read('f:package.json');
    return {
      id: session.replica.meta.id,
      source: session.replica.meta.source,
      units: session.replica.table('unit').count,
      pois: session.replica.annotations.filter((a: any) => a.type === 'poi').length,
      packageJson: new TextDecoder().decode(bytes).slice(0, 400),
    };
  });
  expect(info.source).toBe('import');
  expect(info.id).not.toBe(`demo:${DEMO}`);
  expect(info.units).toBeGreaterThan(100);
  expect(info.pois).toBeGreaterThan(0);
  expect(info.packageJson).toContain('"vite"');
});
