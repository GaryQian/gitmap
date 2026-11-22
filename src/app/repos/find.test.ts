// Fuzzy search over the landing page's repo pills.
import { describe, expect, it } from 'vitest';
import type { RepoPillItem } from './demos';
import { findRepos } from './find';

const saved = (name: string, remoteUrl: string | null = null): RepoPillItem =>
  ({ kind: 'saved', key: `saved:${name}`, repo: { id: name, name, remoteUrl, lastOpened: 0 } });
const demo = (name: string, location?: string): RepoPillItem =>
  ({ kind: 'demo', key: `demo:${name}`, repo: { name, file: `/demo/${name}.starmap.zip`, location } });

const items = [
  saved('gitmap', 'github.com/GaryQian/gitmap'),
  demo('react', 'github.com/facebook/react'),
  demo('tensorflow', 'github.com/tensorflow/tensorflow'),
  saved('notes'),
  saved('react-native', 'github.com/facebook/react-native'),
];
const names = (query: string, limit?: number): string[] => findRepos(items, query, limit).map((i) => i.repo.name);

describe('findRepos', () => {
  it('matches nothing until something is typed', () => {
    expect(names('')).toEqual([]);
    expect(names('   ')).toEqual([]);
  });

  it('finds names by a fragment, by letters in order and through one slip', () => {
    expect(names('react')).toEqual(['react', 'react-native']);
    expect(names('tsf')).toEqual(['tensorflow']);
    expect(names('raect')).toContain('react');
    expect(names('zzz')).toEqual([]);
  });

  it('finds a repo by where it is from, after the repos found by name', () => {
    expect(names('facebook')).toEqual(['react', 'react-native']);
    const found = names('git');
    expect(found[0]).toBe('gitmap');
    expect(found).toContain('tensorflow'); // github.com/...
  });

  it('keeps to the limit', () => {
    expect(names('e', 2)).toHaveLength(2);
  });
});
