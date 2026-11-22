// Repos (package 3N): the landing page's repo pills, saved repos and demos together (PLAN.md §17.7,
// plan/DEMO-MODE.md §5), and, on the map, the repo info pill under the title pill with its card
// (§12, §12.1). Export is in the settings card.
import type { AppMount } from '../../contracts/app';
import { RepoInfo } from './RepoInfo';
import { RepoPills } from './RepoPills';
import './repos.css';

const mounts: AppMount[] = [
  { region: 'landing', order: 10, Component: RepoPills },
  // 5: right under the title pill (0), before the selection pills
  { region: 'topLeft', order: 5, Component: RepoInfo },
];
export default mounts;
