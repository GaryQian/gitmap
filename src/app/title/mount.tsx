// Top left: the title pill — the app title in Light, the repo name in Medium (PLAN.md §17.6), and
// a "Demo" tag after the name of a map opened from the demo list (plan/DEMO-MODE.md §5).
import { config } from '../../config';
import type { AppMount } from '../../contracts/app';
import { DemoTag } from '../repos/DemoTag';
import { closeSession } from '../session';
import { useReplica } from '../store';
import { Pill, Strong } from '../ui';
import { countLabel } from '../units';
import './title.css';

/** The id of the map's heading. The map canvas can take its name from it (`aria-labelledby`). */
const MAP_HEADING_ID = 'gm-map-heading';

function TitlePill() {
  const replica = useReplica();
  const repo = replica?.meta?.name ?? null;
  // a map opened from the demo list says so, here and on its pill on the landing page
  const demo = replica?.meta?.source === 'demo';
  // what the canvas shows, in words: the page's one heading on the map, for screen readers
  const files = replica?.table('unit').count ?? 0;
  const cities = replica?.table('city').count ?? 0;
  const heading = `Map of ${repo ?? 'the repository'}${demo ? ' (demo)' : ''}${files > 0 ? `: ${countLabel(files, 'file', 'files')} in ${countLabel(cities, 'city', 'cities')}` : ''}`;
  return (
    <Pill blur className="gm-title-pill">
      <h1 id={MAP_HEADING_ID} className="gm-visually-hidden">{heading}</h1>
      <button
        type="button"
        className="gm-title-home"
        aria-label={`${config.app.title}: back to the start page`}
        title="Back to the start page"
        onClick={() => closeSession()}
      >
        {config.app.title}
      </button>
      {repo && <Strong>{repo}</Strong>}
      {repo && demo && <DemoTag />}
    </Pill>
  );
}

const mount: AppMount = { region: 'topLeft', order: 0, Component: TitlePill };
export default mount;
