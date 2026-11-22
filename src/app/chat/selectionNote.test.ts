import { describe, expect, it } from 'vitest';
import type { NodeRef } from '../../model/types';
import { hasSelectionNote, selectionFacts, selectionNote, selectionPhrase, withSelection } from './selectionNote';
import { testReplica } from './tools/testing';

describe('the selection note sent with a question', () => {
  const replica = testReplica();
  const units = replica.table('unit');
  const paths = units.slots().map((s) => units.ids[s]!);
  const district = `d:${replica.table('district').ids[replica.table('district').slots()[0]!]!}` as NodeRef;

  it('names a selected city, a district and files, and skips what is gone', () => {
    const selection: NodeRef[] = ['c:c0', district, `u:${paths[0]!}`, 'u:no/such/file.ts', 'c:gone'];
    const facts = selectionFacts(replica, selection);
    expect(facts.areas.map((a) => [a.kind, a.ref])).toEqual([['city', 'c:c0'], ['district', district]]);
    expect(facts.areas[0]!.name).toBe('Core');
    expect(facts.areas[0]!.files).toBeGreaterThan(facts.areas[1]!.files);
    expect(facts.files).toEqual([paths[0]]);

    const note = selectionNote(replica, selection);
    expect(note.startsWith('<map_selection>\n')).toBe(true);
    expect(note.endsWith('\n</map_selection>')).toBe(true);
    expect(note).toContain('- city "Core" (ref c:c0), ');
    expect(note).toContain(`(ref ${district}), `);
    expect(note).toContain(`- file \`${paths[0]}\``);
    expect(note).not.toContain('no/such/file.ts');

    const sent = withSelection('What does this do?', note);
    expect(sent.endsWith('\n\nWhat does this do?')).toBe(true);
    expect(hasSelectionNote(sent)).toBe(true);
  });

  it('says nothing when nothing is selected, unless a selection was named before', () => {
    expect(selectionNote(replica, [])).toBe('');
    expect(withSelection('Hello', '')).toBe('Hello');
    expect(selectionNote(replica, [], { sayEmpty: true })).toContain('Nothing is selected');
  });

  it('counts a long list of files instead of naming every one', () => {
    const many = paths.slice(0, 20).map((p) => `u:${p}` as NodeRef);
    const note = selectionNote(replica, many);
    expect(note.match(/^- file /gm)).toHaveLength(12);
    expect(note).toContain('- and 8 more files');
  });

  it('puts the selection in a few words for the line over the composer', () => {
    expect(selectionPhrase(selectionFacts(replica, []))).toBeNull();
    expect(selectionPhrase(selectionFacts(replica, ['c:c0']))).toBe('Core');
    expect(selectionPhrase(selectionFacts(replica, ['c:c0', `u:${paths[0]!}`, `u:${paths[1]!}`]))).toBe('Core and 2 files');
    expect(selectionPhrase(selectionFacts(replica, [`u:${paths[0]!}`]))).toBe(paths[0]!.slice(paths[0]!.lastIndexOf('/') + 1));
  });
});
