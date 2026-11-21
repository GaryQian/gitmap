// Build a fixture repo with a real .git and print where it is.
// Usage: npm run fixture -- [name]      (default: three-lang)
import { buildFixtureRepo, git } from '../src/testing/fixture';

export default function main(args: string[]): void {
  const name = args[0] ?? 'three-lang';
  const dir = buildFixtureRepo(name);
  const files = git(dir, ['ls-files']).trim().split('\n').length;
  const commits = git(dir, ['rev-list', '--count', 'HEAD']).trim();
  console.log(`${name}: ${dir}\n  ${files} tracked files, ${commits} commits`);
}
