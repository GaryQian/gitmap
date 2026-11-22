// Landing page repo pills (PLAN.md §17.7): saved repos by most recently opened, then the demos.
// Each shows the repo's name and where it is from; clicking one opens it.
import { useEffect, useRef, useState } from 'react';
import { config, type DemoRepo } from '../../config';
import type { RepoSource } from '../../contracts/pipeline';
import { errorMessage, openSource } from '../session';
import { setMessage } from '../store';
import { PillButton, Strong } from '../ui';
import { NO_SAVED_REPOS, savedRepos, whereLabel, type SavedRepo, type SavedRepos } from './registry';

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
        console.warn('gitmap: could not list saved repos', err);
      }
    })();
    return () => { live = false; };
  }, []);

  const openSaved = async (repo: SavedRepo): Promise<void> => {
    setMessage(null);
    let source: RepoSource | null;
    try {
      source = await registry.current.openSaved(repo.id); // called in the click: it may ask for folder permission
    } catch (err) {
      setMessage(errorMessage(err));
      return;
    }
    if (source) await openSource(source);
    else setMessage(`The saved map of ${repo.name} could not be opened. Choose its folder again.`);
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
