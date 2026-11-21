// Top left: the title pill — the app title in Light, the repo name in Medium (PLAN.md §17.6).
import { config } from '../../config';
import type { AppMount } from '../../contracts/app';
import { closeSession } from '../session';
import { useRepoName } from '../store';
import { Pill, Strong } from '../ui';
import './title.css';

function TitlePill() {
  const repo = useRepoName();
  return (
    <Pill blur className="gm-title-pill">
      <button type="button" className="gm-title-home" title="Back to the start page" onClick={() => closeSession()}>
        {config.app.title}
      </button>
      {repo && <Strong>{repo}</Strong>}
    </Pill>
  );
}

const mount: AppMount = { region: 'topLeft', order: 0, Component: TitlePill };
export default mount;
