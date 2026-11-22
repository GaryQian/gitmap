import { describe, expect, it } from 'vitest';
import { CHAT_TOOLS, type ToolOutcome } from '../contract';
import { validateArgs } from './args';
import { HANDLERS, createToolExecutor } from './executor';
import { resolveContributor } from './overlay';
import { PEOPLE, testEnv, testReplica, type TestEnv } from './testing';

const read = (outcome: ToolOutcome): any => JSON.parse(outcome.content);

function harness(env: TestEnv = testEnv()) {
  const executor = createToolExecutor(() => env);
  let n = 0;
  const call = (name: string, input: Record<string, unknown> = {}) => executor.execute({ id: `t${++n}`, name, input });
  return { env, call };
}

const firstPath = (env: TestEnv): string => env.replica.table('unit').ids[env.replica.table('unit').slots()[0]!]!;

describe('the executor', () => {
  it('has a handler for every tool of the contract, and nothing else', () => {
    expect(Object.keys(HANDLERS).sort()).toEqual(CHAT_TOOLS.map((t) => t.name).sort());
  });

  it('refuses bad arguments in words, and never throws', async () => {
    const { call } = harness();
    for (const [name, input] of [
      ['nope', {}],
      ['list_area', {}],
      ['list_area', { area: 5 }],
      ['get_file', { path: 'x', extra: true }],
      ['get_dependencies', { path: 'x', direction: 'sideways' }],
      ['set_overlay', { overlay: 'heat' }],
      ['read_file', { path: 'x', start_line: 1.5 }],
      ['select', { paths: [1, 2] }],
    ] as const) {
      const outcome = await call(name, input as Record<string, unknown>);
      expect(outcome.ok, `${name} ${JSON.stringify(input)}`).toBe(false);
      expect(read(outcome).error).toBeTruthy();
      expect(outcome.action).toBeUndefined();
    }
    const none = createToolExecutor(() => null);
    expect((await none.execute({ id: 'x', name: 'get_notes', input: {} })).ok).toBe(false);
  });

  it('repairs harmless slips in arguments', () => {
    const schema = CHAT_TOOLS.find((t) => t.name === 'read_file')!.inputSchema;
    expect(validateArgs(schema, { path: 'a.ts', start_line: '12', end_line: null })).toEqual({ ok: true, args: { path: 'a.ts', start_line: 12 } });
    const select = CHAT_TOOLS.find((t) => t.name === 'select')!.inputSchema;
    expect(validateArgs(select, { paths: 'a.ts' })).toEqual({ ok: true, args: { paths: ['a.ts'] } });
  });
});

describe('the tools that look things up', () => {
  it('get_repo_overview names every city with its districts and summary', async () => {
    const { call } = harness();
    const o = read(await call('get_repo_overview'));
    expect(o.files).toBe(60);
    expect(o.cities).toHaveLength(2);
    expect(o.cities.reduce((n: number, c: any) => n + c.files, 0)).toBe(60);
    expect(o.cities.find((c: any) => c.ref === 'c:c0').summary).toBe('Holds the entry points.');
    expect(o.cities[0].districts[0].ref).toMatch(/^d:/);
    expect(o.languages.map((l: any) => l.id).sort()).toEqual(['python', 'ts']);
    expect(o.contributors[0]).toEqual({ name: 'Ada Lovelace', commits: 40 });
  });

  it('list_area lists a district most important first, cuts at the limit, and suggests on a miss', async () => {
    const { call } = harness();
    const city = read(await call('list_area', { area: 'c:c0' }));
    expect(city.districts).toHaveLength(2);
    const whole = read(await call('list_area', { area: city.districts[0].ref, limit: 200 }));
    expect(whole.files.length).toBe(city.districts[0].files);
    const importance = whole.files.map((f: any) => f.importance);
    expect(importance).toEqual([...importance].sort((a, b) => b - a));
    const cut = read(await call('list_area', { area: city.districts[0].ref, limit: 2 }));
    expect(cut.files).toHaveLength(2);
    expect(cut.cut).toMatch(/not listed/);
    const miss = await call('list_area', { area: 'c:c9' });
    expect(miss.ok).toBe(false);
    expect(read(miss).nearest[0]).toMatch(/^c:c\d \(city-\d\)$/);
    // a name will do where the ref was not to hand
    expect(read(await call('list_area', { area: 'city-1' })).city.ref).toBe('c:c1');
  });

  it('get_file reports place, links, history and notes; an unknown path gets the nearest ones', async () => {
    const { env, call } = harness();
    const path = firstPath(env);
    const f = read(await call('get_file', { path: `./${path}:12` }));
    expect(f.path).toBe(path);
    expect(f.city.ref).toMatch(/^c:/);
    expect(f.district.name).toMatch(/^district-/);
    expect(f.dependsOn).toBe(f.dependencies.length);
    expect(f.history.lastChanged).toMatch(/^\d{4}-\d\d-\d\d$/);
    expect(f.history.authors[0]).toEqual({ name: 'Ada Lovelace', commits: 3, share: 0.75 });
    expect(f.history.topAuthorShare).toBe(0.75);
    expect(f.notes.map((n: any) => n.type)).toEqual(['point of interest', 'tour step 1']);

    const miss = await call('get_file', { path: `nowhere/${path.split('/').pop()}` });
    expect(miss.ok).toBe(false);
    expect(read(miss).nearest).toContain(path);
  });

  it('get_dependencies walks breadth first and keeps to its depth', async () => {
    const { env, call } = harness();
    const units = env.replica.table('unit');
    const hub = units.slots().sort((a, b) => units.cols.fanIn[b]! - units.cols.fanIn[a]!)[0]!;
    const path = units.ids[hub]!;
    const one = read(await call('get_dependencies', { path, direction: 'depended_on_by' }));
    expect(one.total).toBe(units.cols.fanIn[hub]);
    expect(one.files.every((f: any) => f.hops === 1)).toBe(true);
    const two = read(await call('get_dependencies', { path, direction: 'depended_on_by', depth: 2, limit: 200 }));
    expect(two.total).toBeGreaterThanOrEqual(one.total);
    const hops = two.files.map((f: any) => f.hops);
    expect(hops).toEqual([...hops].sort((a, b) => a - b));
    expect((await call('get_dependencies', { path, direction: 'depends_on', depth: 4 })).ok).toBe(false);
  });

  it('read_file numbers its lines, cuts long files, and says why it cannot read', async () => {
    const replica = testReplica();
    const units = replica.table('unit');
    const [a, b, c] = units.slots().map((s) => units.ids[s]!);
    const long = Array.from({ length: 1000 }, (_, i) => `line ${i + 1}`).join('\n');
    const { call } = harness(testEnv(replica, { [a!]: long, [b!]: new Uint8Array([1, 0, 2]), [c!]: 'const key = "-----BEGIN RSA PRIVATE KEY-----";' }));

    const head = await call('read_file', { path: a });
    expect(head.ok).toBe(true);
    expect(head.content.split('\n')[0]).toMatch(/lines 1 to 300 of 1000 \(cut: ask for start_line 301/);
    expect(head.content.split('\n')[1]).toBe('  1  line 1');
    const range = await call('read_file', { path: a, start_line: 998, end_line: 2000 });
    expect(range.content.split('\n')).toEqual([expect.stringMatching(/lines 998 to 1000 of 1000$/), ' 998  line 998', ' 999  line 999', '1000  line 1000']);

    expect(read(await call('read_file', { path: b })).error).toMatch(/not a text file/);
    expect(read(await call('read_file', { path: c })).error).toMatch(/key or password/);
    expect(read(await call('read_file', { path: a, start_line: 5000 })).error).toMatch(/past the end/);
    expect((await call('read_file', { path: units.ids[units.slots()[5]!]! })).ok).toBe(false); // no contents for it

    const noFolder = harness(testEnv(replica, null));
    expect(read(await noFolder.call('read_file', { path: a })).error).toMatch(/not available/);
  });

  it('search_files, get_notes and get_view_state answer from the session, the notes and the view', async () => {
    const { env, call } = harness();
    const found = read(await call('search_files', { query: 'file1', limit: 3 }));
    expect(found.results).toHaveLength(3);
    expect(found.cut).toBeTruthy();
    expect(found.results[0].area).toMatch(/^d:/);

    const notes = read(await call('get_notes'));
    expect(notes.summaries[0]).toEqual({ area: 'c:c0', name: 'city-0', text: 'Holds the entry points.' });
    expect(notes.pointsOfInterest[0].path).toBe(firstPath(env));
    expect(notes.tour[0].step).toBe(1);

    await call('set_overlay', { overlay: 'ownership', contributor: 'grace' });
    await call('select', { paths: [firstPath(env)] });
    const view = read(await call('get_view_state'));
    expect(view.overlay).toMatchObject({ id: 'ownership', contributor: 'Grace Hopper' });
    expect(view.selection).toMatchObject({ count: 1, files: [firstPath(env)] });
    expect(view.languageFilter).toBe('all languages');
  });
});

describe('the tools that act on the map', () => {
  it('select by area and language selects those files, frames them and names the area', async () => {
    const { env, call } = harness();
    const units = env.replica.table('unit');
    const outcome = await call('select', { area: 'c:c0', language: 'ts' });
    expect(outcome.ok).toBe(true);
    const selected = read(outcome).selected;
    expect(selected).toBeGreaterThan(0);
    expect(env.state.selection).toHaveLength(selected);
    for (const ref of env.state.selection) {
      const slot = units.slotOf(ref.slice(2));
      expect(units.cols.lang[slot]).toBe('ts');
      expect(ref.slice(2).startsWith('city-0/')).toBe(true);
    }
    expect(outcome.action).toBe(`Selected ${selected} TypeScript files in city-0`);
    expect(env.log.at(-1)).toMatch(/^flyTo [cd]:/);

    const district = read(await call('list_area', { area: 'c:c1' })).districts[0];
    const added = await call('select', { area: district.ref, mode: 'add' });
    expect(added.action).toBe(`Added ${district.files} files in ${district.name} in city-1 to the selection`);
    expect(env.state.selection).toHaveLength(selected + district.files);
    expect(env.log.at(-1)).toBe(`flyTo ${district.ref}`);
  });

  it('select by path flies to the one file, skips what is not there, and fails when nothing is', async () => {
    const { env, call } = harness();
    const path = firstPath(env);
    const one = await call('select', { paths: [path, 'missing/thing.ts'] });
    expect(one.action).toBe(`Selected ${path}`);
    expect(read(one).skipped[0]).toMatchObject({ path: 'missing/thing.ts', why: 'not on the map' });
    expect(env.log).toEqual(['select 1', `flyTo u:${path}`]);

    const none = await call('select', { paths: ['missing/thing.ts'] });
    expect(none.ok).toBe(false);
    expect(env.state.selection).toHaveLength(1);
    expect((await call('select', { area: 'c:c0', language: 'cobol' })).ok).toBe(false);
    expect((await call('select', {})).ok).toBe(false);

    expect((await call('clear_selection')).action).toBe('Cleared the selection');
    expect((await call('clear_selection')).action).toBeUndefined();
  });

  it('set_overlay sets the overlay and its parameter, and reports who or what it shows', async () => {
    const { env, call } = harness();
    const on = await call('set_overlay', { overlay: 'ownership', contributor: 'jose alvarez' });
    expect(on.action).toBe('Turned on the Ownership overlay for José Álvarez');
    expect(env.state).toMatchObject({ activeOverlay: 'ownership', contributorId: 2 });
    const miss = await call('set_overlay', { overlay: 'ownership', contributor: 'Zebediah' });
    expect(miss.ok).toBe(false);
    expect(read(miss).closest.length).toBeGreaterThan(0);
    expect(env.state.contributorId).toBe(2);

    const reach = await call('set_overlay', { overlay: 'reach', direction: 'depended_on_by' });
    expect(env.state).toMatchObject({ activeOverlay: 'reach', direction: 'dependedOnBy' });
    expect(read(reach).note).toMatch(/Nothing is selected/);
    expect((await call('set_overlay', { overlay: 'none' })).action).toBe('Turned off the Dependency reach overlay');
    expect(env.state.activeOverlay).toBeNull();

    // a map without history does not offer the history overlays
    const env2 = testEnv(testReplica());
    env2.state.noHistory = true;
    for (const id of ['recency', 'ownership', 'knowledgeRisk']) (env2.replica.layers as Map<string, unknown>).delete(id);
    const refused = await harness(env2).call('set_overlay', { overlay: 'recency' });
    expect(refused.ok).toBe(false);
    expect(read(refused).available).toEqual(expect.arrayContaining(['reach', 'tests']));
  });

  it('set_filters checks languages against the map and turns lines into the size filter’s bytes', async () => {
    const { env, call } = harness();
    const bad = await call('set_filters', { languages: ['ts', 'rust'] });
    expect(bad.ok).toBe(false);
    expect(read(bad).languages.sort()).toEqual(['python', 'ts']);
    expect(env.log).toEqual([]);

    const set = await call('set_filters', { languages: ['TypeScript'], min_lines: 100 });
    expect(env.state.typeFilter).toEqual(['ts']);
    expect(env.state.minBytes).toBe(3200); // the synthetic map has 32 bytes to a line
    expect(set.action).toMatch(/^Dimmed everything except TypeScript; hid files under about 100 lines/);
    expect(read(set).hiddenFiles).toBeGreaterThan(0);

    const back = await call('set_filters', { languages: [], min_lines: 0 });
    expect(env.state).toMatchObject({ typeFilter: [], minBytes: 0 });
    expect(back.action).toBe('Showing every language again; showing files of every size again');
    expect((await call('set_filters', {})).ok).toBe(false);
  });

  it('focus_on, open_file and reset_view do what the controls do', async () => {
    const { env, call } = harness();
    const path = firstPath(env);
    expect((await call('focus_on', { target: 'c:c1' })).action).toBe('Flew to city-1');
    expect((await call('focus_on', { target: path })).action).toBe(`Flew to ${path}`);
    expect((await call('focus_on', { target: 'd:nope' })).ok).toBe(false);
    expect((await call('open_file', { path })).action).toBe(`Opened ${path}`);
    expect(env.state).toMatchObject({ openFile: `f:${path}`, panel: 'file' });
    expect((await call('open_file', { path: 'nope.ts' })).ok).toBe(false);
    expect((await call('reset_view')).action).toBe('Reset the view');
    expect(env.log).toEqual(['flyTo c:c1', `flyTo u:${path}`, `open f:${path}`, 'reset']);
    expect(env.state.selection).toEqual([]);
  });
});

describe('contributor names', () => {
  it('match loosely: case, accents, a first name, a typo', () => {
    const who = (name: string) => { const m = resolveContributor(PEOPLE, name); return m.kind === 'found' ? m.contributor.name : null; };
    expect(who('ada lovelace')).toBe('Ada Lovelace');
    expect(who('Jose')).toBe('José Álvarez');
    expect(who('hopper')).toBe('Grace Hopper');
    expect(who('Grase Hopper')).toBe('Grace Hopper');
    // "ada" is in two names: the one with more commits is chosen and the other is reported
    const ada = resolveContributor(PEOPLE, 'Ada');
    expect(ada.kind === 'found' && [ada.contributor.name, ...ada.others.map((c) => c.name)]).toEqual(['Ada Lovelace', 'Adam Smith']);
  });

  it('offer the closest names when nobody matches', () => {
    const none = resolveContributor(PEOPLE, 'Lovelock');
    expect(none.kind).toBe('none');
    expect(none.kind === 'none' && none.close[0]!.name).toBe('Ada Lovelace');
    const far = resolveContributor(PEOPLE, 'Qwxz');
    expect(far.kind === 'none' && far.close.map((c) => c.name)).toEqual(PEOPLE.map((c) => c.name));
  });
});
