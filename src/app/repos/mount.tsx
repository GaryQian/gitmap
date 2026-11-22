// Repos (package 3N): the landing page's repo pills (PLAN.md §17.7) and, on the map, the repo info
// pill under the title pill with its card and "Export map" (§12, §12.1).
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
