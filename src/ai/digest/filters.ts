// Which paths may contribute what (PLAN.md §11.2):
//   excluded  vendored, generated, fixture and lockfile paths: counted, never shown
//   test      test files: counted as structure, never shown
//   secret    secret-named files: never read and never named
// plus the scan for key-shaped content that drops a whole file.
import picomatch from 'picomatch';
import type { Config } from '../../config';
import { LOCAL } from './tunables';

export interface PathRules {
  excluded(path: string): boolean;
  test(path: string): boolean;
  secret(path: string): boolean;
}

export function pathRules(config: Config): PathRules {
  // Paths are always '/'-separated, whatever the platform.
  const opts = { dot: true, windows: false };
  const configured = picomatch(config.parser.exclude, opts);
  const generated = picomatch([...LOCAL.generated], { ...opts, nocase: true });
  const test = picomatch(config.overlays.tests.patterns, opts);
  const secretGlobs = (config.ai as { excludePaths?: string[] }).excludePaths ?? LOCAL.excludePaths;
  const secret = picomatch([...secretGlobs], { ...opts, nocase: true });
  return {
    excluded: (path) => configured(path) || generated(path),
    test,
    secret,
  };
}

const KEY_SHAPES: readonly RegExp[] = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/,
  // Provider token prefixes, each with enough of a tail that a placeholder such as "sk-..." passes.
  /\b(?:sk-ant-[\w-]{16}|sk-proj-[\w-]{16}|sk-[A-Za-z0-9]{24}|[sr]k_live_[A-Za-z0-9]{16}|gh[pousr]_[A-Za-z0-9]{30}|github_pat_\w{20}|glpat-[\w-]{16}|xox[abposr]-[A-Za-z0-9-]{10}|npm_[A-Za-z0-9]{30}|hf_[A-Za-z0-9]{30}|A[KS]IA[0-9A-Z]{16}|AIza[\w-]{30}|ya29\.[\w-]{20}|SG\.[\w-]{16,}\.[\w-]{16}|dop_v1_[a-f0-9]{32}|shp(?:at|ss|ca|pa)_[a-f0-9]{24})/,
  // JSON Web Token.
  /\beyJ[\w-]{8,}\.eyJ[\w-]{8,}\./,
  // A credential-named key assigned a long literal.
  /(?:api[_-]?key|secret|token|passw(?:or)?d|private[_-]?key|access[_-]?key)["']?\s*[:=]\s*["'][\w+/=.-]{16,}["']/i,
];

const RUN = /[A-Za-z0-9+=_-]+/g;

function entropyBits(s: string): number {
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/** A long run that mixes cases and digits and is close to random: a key, not a name or a hash. */
function highEntropy(run: string): boolean {
  const { entropyMinLength, entropyMinDigits, entropyBits: minBits } = LOCAL.secrets;
  if (run.length < entropyMinLength) return false;
  let digits = 0, upper = 0, lower = 0;
  for (let i = 0; i < run.length; i++) {
    const c = run.charCodeAt(i);
    if (c >= 48 && c <= 57) digits++;
    else if (c >= 65 && c <= 90) upper++;
    else if (c >= 97 && c <= 122) lower++;
  }
  return digits >= entropyMinDigits && upper > 0 && lower > 0 && entropyBits(run) >= minBits;
}

/** True when the text holds key-shaped content: private-key headers, token prefixes, random-looking runs. */
export function looksSecret(text: string): boolean {
  const scanned = text.length > LOCAL.secrets.scanChars ? text.slice(0, LOCAL.secrets.scanChars) : text;
  for (const shape of KEY_SHAPES) if (shape.test(scanned)) return true;
  const min = LOCAL.secrets.entropyMinLength;
  for (const m of scanned.matchAll(RUN)) if (m[0].length >= min && highEntropy(m[0])) return true;
  return false;
}
