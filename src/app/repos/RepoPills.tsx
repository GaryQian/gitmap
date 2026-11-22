// Landing page repo pills (PLAN.md §17.7): saved repos by most recently opened, then the demos.
// Each shows the repo's name and where it is from; clicking one opens it.
import { useEffect, useRef, useState } from 'react';
import { config, type DemoRepo } from '../../config';
import { openSource } from '../session';
import { lineFor } from '../status/actions';
import { offerFolder } from '../status/folder';
import { setMessage } from '../store';
import { PillButton, Strong } from '../ui';
import { NO_SAVED_REPOS, savedRepos, whereLabel, type SavedOpen, type SavedRepo, type SavedRepos } from './registry';

/** Saved repos shown. The page is one button and a few pills, not a list to scroll. */
const MAX_SAVED = 8;

/** `/demo/<name>/` is relative to where the app is served, which is not always the origin's root. */
export function demoBaseUrl(repo: DemoRepo): string {
  const base = import.meta.env.BASE_URL ?? '/';
  const path = repo.path.endsWith('/') ? repo.path : `${repo.path}/`;
  return path.startsWith('/') && !path.startsWith('//') ? base.replace(/\/$/, '') + path : path;
}

function RepoPill({ name, where, title, onOpen }: { name: string; where: string; title?: string; onOpen(): void }) {
  return (
    <PillButton className="gm-repo-pill" title={title} onClick={onOpen}>
      <Strong>{name}</Strong>
      <span className="gm-repo-where">{where}</span>
    </PillButton>
  );
}

export function RepoPills() {
  const [saved, setSaved] = useState<SavedRepo[]>([]);
  const registry = useRef<SavedRepos>(NO_SAVED_REPOS);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const found = await savedRepos();
        const list = await found.listSaved();
        if (!live) return;
        registry.current = found;
        setSaved(list.slice(0, MAX_SAVED));
      } catch (err) {
        // the page still works without the list: a folder can be chosen, a demo opened
        console.warn('starmap: could not list saved repos', err);
      }
    })();
    return () => { live = false; };
  }, []);

  const remove = async (repo: SavedRepo): Promise<void> => {
    try {
      await registry.current.removeSaved(repo.id);
    } catch (err) {
      console.warn('starmap: the saved map could not be removed', err);
    }
    setSaved((list) => list.filter((r) => r.id !== repo.id));
    setMessage(null);
  };

  const openSaved = async (repo: SavedRepo): Promise<void> => {
    setMessage(null);
    let opened: SavedOpen | null = null;
    try {
      opened = await registry.current.openSaved(repo.id); // called in the click: it may ask for folder permission
    } catch (err) {
      console.warn('starmap: the saved map could not be opened', err);
    }
    if (opened) {
      // a map that opens without its folder says what the folder needs once it is on screen
      if (opened.folder) offerFolder(opened.source, opened.folder);
      await openSource(opened.source);
      return;
    }
    // Neither a usable snapshot nor a readable folder: say so, and offer to drop the entry. Choosing
    // the folder with the button above maps it again and renews the entry.
    const line = lineFor('saved-map-gone', { name: repo.name }, { 'remove-saved': () => remove(repo) });
    setMessage(line.text, line.action);
  };

  return (
    <>
      {saved.map((repo) => (
        <RepoPill key={`saved:${repo.id}`} name={repo.name} where={whereLabel(repo.remoteUrl)} onOpen={() => void openSaved(repo)} />
      ))}
      {config.demo.repos.map((repo) => (
        <RepoPill
          key={`demo:${repo.name}`}
          name={repo.name}
          where="Demo"
          title={repo.location}
          onOpen={() => void openSource({ kind: 'demo', name: repo.name, baseUrl: demoBaseUrl(repo) })}
        />
      ))}
    </>
  );
}
