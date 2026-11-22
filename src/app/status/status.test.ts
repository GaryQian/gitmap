import { describe, expect, it } from 'vitest';
import { describeAiError } from '../../ai';
import { lineFor, statusLine } from './actions';
import {
  classifyBackground, classifyDecodeError, classifyFatal, classifyNoHistory, classifyPickError, folderCase, isStaleBuild, WORKTREE_REASON,
} from './classify';
import { folderNeed, offerFolder } from './folder';
import { listOf, say, STATUS_CASES } from './messages';
import { responseSaysStale } from './stale';
import { missingRequirements, probeSupport, supportVerdict, type SupportEnv } from './support';

/** Wording that belongs in a console, not on the page. */
const RAW = /\b\w*(Error|Exception)\b|undefined|\bnull\b|NaN|\[object|\bat \w+ \(|https?:\/\//;

describe('the copy', () => {
  it('has a plain sentence for every case, and never a raw error', () => {
    expect(STATUS_CASES.length).toBeGreaterThan(30);
    for (const id of STATUS_CASES) {
      for (const params of [{}, { name: 'react', what: 'WebGL 2', limit: '200,000 files' }]) {
        const { text, action } = say(id, params);
        expect(text, id).toMatch(/^[A-Z]/);
        expect(text.trim(), id).toBe(text);
        expect(text.length, id).toBeGreaterThan(10);
        expect(text, id).not.toMatch(RAW);
        if (action) expect(action.label, id).toMatch(/^[A-Z][a-z]/); // sentence case, a plain verb
      }
    }
  });

  it('offers an action only when something runs it; reloading always can', () => {
    expect(lineFor('app-updated').action?.label).toBe('Reload');
    expect(lineFor('folder-needed').action).toBeNull();
    let chosen = 0;
    const line = lineFor('folder-needed', {}, { 'choose-folder': () => { chosen++; } });
    void line.action?.run();
    expect(chosen).toBe(1);
    expect(statusLine('history-stopped', { fades: true })).toEqual({ kind: 'status', id: 'history-stopped', text: say('history-stopped').text, fades: true });
  });

  it('joins a list the way a sentence does', () => {
    expect(listOf(['a'])).toBe('a');
    expect(listOf(['a', 'b'])).toBe('a and b');
    expect(listOf(['a', 'b', 'c'])).toBe('a, b and c');
  });
});

describe('classifying a failure', () => {
  it('tells a stale build from another worker failure', () => {
    for (const m of [
      'Failed to fetch dynamically imported module: http://localhost:5175/src/pipeline/post.ts',
      'error loading dynamically imported module',
      'Importing a module script failed.',
      'compute worker 3 failed: its script could not be loaded (if the dev server restarted or rebuilt, reload the page)',
      new TypeError('Failed to fetch dynamically imported module: /assets/post-abc123.js'),
    ]) {
      expect(isStaleBuild(m)).toBe(true);
      expect(classifyFatal(m, { kind: 'directory' }).id).toBe('app-updated');
    }
    expect(isStaleBuild('compute worker 2 failed: Uncaught RangeError: Invalid array length')).toBe(false);
    expect(classifyFatal('compute worker 2 failed: Uncaught RangeError: Invalid array length', { kind: 'directory' }).id).toBe('worker-failed');
    expect(classifyFatal('The background worker stopped unexpectedly.', { kind: 'directory' }).id).toBe('worker-failed');
    // a stale build is a stale build whatever was being opened
    expect(classifyFatal('error loading dynamically imported module', { kind: 'demo', name: 'small' }).id).toBe('app-updated');
  });

  it('asks the server whether the build was replaced', () => {
    expect(responseSaysStale(404, null)).toBe(true);
    expect(responseSaysStale(200, 'text/html; charset=utf-8')).toBe(true); // a host that serves the page for every path
    expect(responseSaysStale(200, 'text/javascript')).toBe(false);
    expect(responseSaysStale(503, null)).toBe(false);
  });

  it('names what happened to a folder', () => {
    const dir = { kind: 'directory' } as const;
    expect(classifyFatal('No files to map were found in that folder.', dir).id).toBe('folder-nothing-to-map');
    expect(classifyFatal('NotAllowedError: The request is not allowed by the user agent or the platform in the current context.', dir).id).toBe('folder-denied');
    expect(classifyFatal('NotFoundError: A requested file or directory could not be found at the time an operation was processed.', dir).id).toBe('folder-read-stopped');
    expect(classifyFatal('git: cannot read .git/index (it may have changed on disk; reopen the repo): NotReadableError', dir).id).toBe('folder-read-stopped');
    expect(classifyFatal('This folder holds more than 200,000 files after its ignore rules were applied, so the walk was stopped.', dir))
      .toEqual({ id: 'folder-too-large', params: { limit: '200,000 files' } });
    expect(classifyFatal("Cannot read properties of undefined (reading 'x')", dir).id).toBe('folder-unreadable');
    expect(classifyFatal('The map fell out of step with its data and needs to be reloaded.', dir).id).toBe('map-out-of-step');
    expect(classifyFatal(new Error('Error creating WebGL context.')).id).toBe('webgl-unavailable');
  });

  it('names the demo that did not load, whatever the reason', () => {
    for (const m of ['Could not load the demo (404).', 'TypeError: Failed to fetch', 'Not a starmap file: its contents are not JSON.']) {
      expect(classifyFatal(m, { kind: 'demo', name: 'small' })).toEqual({ id: 'demo-unavailable', params: { name: 'small' } });
    }
    expect(say('demo-unavailable', { name: 'small' }).text).toContain('small');
  });

  it("uses the decoder's own distinction for a dropped map", () => {
    expect(classifyDecodeError(new Error('Unsupported starmap schema 2: this build reads schema 1. The file may come from a newer version.'))).toBe('saved-map-other-version');
    expect(classifyDecodeError(new Error('Not a starmap file: it is not gzip data, or it is cut short.'))).toBe('saved-map-unreadable');
    expect(classifyDecodeError(new Error('Not a starmap file: the format marker is missing.'))).toBe('saved-map-unreadable');
    expect(classifyDecodeError(undefined)).toBe('saved-map-unreadable');
  });

  it('says nothing for a cancelled dialog and names a refusal', () => {
    const dom = (name: string) => Object.assign(new Error('x'), { name });
    expect(classifyPickError(dom('AbortError'))).toBeNull();
    expect(classifyPickError(dom('NotAllowedError'))).toBe('folder-denied');
    expect(classifyPickError(dom('SecurityError'))).toBe('folder-denied');
    expect(classifyPickError(new Error('anything else'))).toBe('folder-unreadable');
  });

  it('says why there is no history', () => {
    expect(classifyNoHistory('This folder is not a git repository.')).toBe('no-history-plain-folder');
    expect(classifyNoHistory('This folder has no .git directory, so there is no history to read.')).toBe('no-history-plain-folder');
    expect(classifyNoHistory(WORKTREE_REASON)).toBe('no-history-worktree');
    expect(classifyNoHistory('The git index could not be read (git index: sparse index (sdir extension)).')).toBe('no-history-index');
    expect(classifyNoHistory('The git index could not be read (git index: SHA-256 repositories are not supported).')).toBe('no-history-sha256');
    expect(classifyNoHistory('This repository has no commits yet.')).toBe('no-history-empty');
    expect(classifyNoHistory('Commit refs/heads/main cannot be read.')).toBe('no-history');
    for (const id of ['no-history-plain-folder', 'no-history-worktree', 'no-history-index', 'no-history'] as const) {
      expect(say(id).text).toMatch(/^History overlays are unavailable: /);
    }
  });

  it("keeps the pipeline's sentence and drops the exception behind it", () => {
    expect(classifyBackground('This map could not be saved for next time: QuotaExceededError: The quota has been exceeded.')).toBe('save-failed');
    expect(classifyBackground('The history walk stopped: TypeError: x is not a function')).toBe('history-stopped');
    expect(classifyBackground('History overlays could not be updated: op 3: unknown unit')).toBe('history-stopped');
    expect(classifyBackground('Call analysis stopped early: compute worker 1 failed: boom')).toBe('calls-stopped');
    expect(classifyBackground('The folder could not be checked for edited files: NotAllowedError')).toBe('changes-unchecked');
    expect(classifyBackground('RangeError: Maximum call stack size exceeded')).toBe('background-work-stopped');
    expect(classifyBackground('Failed to fetch dynamically imported module: /src/pipeline/post.ts')).toBe('app-updated');
  });
});

describe('folder permission', () => {
  it('maps each state to its line', () => {
    expect(folderCase('granted')).toBeNull();
    expect(folderCase('prompt')).toBe('folder-allow');
    expect(folderCase('denied')).toBe('folder-not-allowed');
    expect(folderCase('gone')).toBe('folder-gone');
    expect(folderCase('none')).toBe('folder-needed');
    expect(folderCase('none', true)).toBe('imported-no-folder');
    expect(say('folder-allow').action?.label).toBe('Allow folder access');
    for (const id of ['folder-not-allowed', 'folder-gone', 'folder-needed', 'imported-no-folder'] as const) {
      expect(say(id).action?.label).toBe('Choose the folder');
    }
  });

  it('knows what the open map lacks', () => {
    const model = {} as never;
    const saved = { kind: 'snapshot', model } as const;
    const session = (source: Parameters<typeof offerFolder>[0], content: unknown) => ({ source, content }) as never;
    expect(folderNeed(null, null)).toBeNull();
    expect(folderNeed(session(saved, {}), { source: 'git' })).toBeNull(); // files can be read
    expect(folderNeed(session({ kind: 'demo', name: 'd', baseUrl: '/' }, null), { source: 'demo' })).toBeNull();
    expect(folderNeed(session(saved, null), { source: 'git' })?.status).toBe('folder-needed');
    expect(folderNeed(session(saved, null), { source: 'import' })?.status).toBe('imported-no-folder');
    offerFolder(saved, { state: 'prompt', repoId: 'r' });
    expect(folderNeed(session(saved, null), { source: 'git' })?.status).toBe('folder-allow');
    offerFolder(saved, { state: 'denied', repoId: 'r' });
    expect(folderNeed(session(saved, null), { source: 'git' })?.status).toBe('folder-not-allowed');
  });
});

describe('browser support', () => {
  const full: SupportEnv = {
    showDirectoryPicker() {}, folderInput: true, Worker: class {}, CompressionStream: class {}, DecompressionStream: class {}, webgl2: () => true,
  };

  it('offers everything and says nothing in a full browser', () => {
    expect(supportVerdict(probeSupport(full))).toEqual({ usable: true, canChoose: true, line: null });
  });

  it('falls back to the folder input and says once that the folder is not remembered', () => {
    const verdict = supportVerdict(probeSupport({ ...full, showDirectoryPicker: undefined }));
    expect(verdict).toEqual({ usable: true, canChoose: true, line: { id: 'folder-not-remembered' } });
    const dropOnly = supportVerdict(probeSupport({ ...full, showDirectoryPicker: undefined, folderInput: false }));
    expect(dropOnly).toEqual({ usable: true, canChoose: false, line: { id: 'browser-no-folders' } });
  });

  it('names the missing hard requirement and offers no button', () => {
    const noGl = probeSupport({ ...full, webgl2: () => false });
    expect(supportVerdict(noGl)).toEqual({ usable: false, canChoose: false, line: { id: 'webgl-unavailable' } });
    const bare = probeSupport({ ...full, Worker: undefined, CompressionStream: undefined });
    expect(missingRequirements(bare)).toEqual(['web workers', 'gzip streams']);
    const verdict = supportVerdict(bare);
    expect(verdict.usable).toBe(false);
    expect(say(verdict.line!.id, verdict.line!.params).text).toContain('web workers and gzip streams');
  });
});

describe('the AI lines', () => {
  it('are plain sentences too', () => {
    for (const code of ['disabled', 'no_key', 'too_large', 'rate_limited', 'refused', 'invalid', 'provider', 'network', 'unavailable', 'failed'] as const) {
      const text = describeAiError(code, 12);
      expect(text, code).toMatch(/^[A-Z].*\.$/);
      expect(text, code).not.toMatch(RAW);
    }
  });
});
