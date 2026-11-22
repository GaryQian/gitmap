// Digest values that have no config.json entry yet. They sit here, in one place, until the lead
// adds them to the `ai` block (listed under "Requested changes" in the 5B report).

/** Part of the digest hash: bump it when the digest's format changes so stored results are not reused. */
export const DIGEST_VERSION = 1;

export const LOCAL = {
  /**
   * PLAN.md §11.2 `ai.excludePaths`: files that are never read for AI and never named in any output.
   * Used only while config.json has no `ai.excludePaths`.
   */
  excludePaths: [
    '**/.env*', '**/*.pem', '**/*.key', '**/id_rsa*', '**/id_dsa*', '**/id_ecdsa*', '**/id_ed25519*',
    '**/*.p12', '**/*.pfx', '**/*.jks', '**/*.keystore', '**/.npmrc', '**/.netrc', '**/.pypirc',
    '**/*.tfvars', '**/*.tfstate', '**/credentials*', '**/secrets.*', '**/secret.*', '**/.htpasswd',
  ],
  /**
   * Generated, fixture, vendored and lockfile paths, on top of config.parser.exclude. Folders that
   * often hold hand-written code (build/, out/, gen/, target/) are deliberately not listed.
   */
  generated: [
    '**/generated/**', '**/__generated__/**', '**/*.gen.*', '**/*.g.dart', '**/*.freezed.dart',
    '**/*.pb.*', '**/*_pb.*', '**/*_pb2_grpc.py', '**/*.designer.cs', '**/*.bundle.js',
    '**/fixtures/**', '**/fixture/**', '**/__fixtures__/**', '**/testdata/**', '**/__snapshots__/**', '**/*.snap',
    '**/third-party/**', '**/thirdparty/**', '**/bower_components/**', '**/Pods/**', '**/site-packages/**',
    '**/.venv/**', '**/venv/**', '**/.next/**', '**/.nuxt/**',
    '**/go.sum', '**/npm-shrinkwrap.json', '**/bun.lockb', '**/gradle.lockfile', '**/packages.lock.json',
    '**/*-lock.json', '**/*-lock.yaml',
  ],
  structure: {
    /** Other cities listed per direction on a city's edge line. */
    cityEdges: 5,
    /** Other districts listed per direction on a district's edge line. */
    districtEdges: 3,
    entryPointsPerCity: 3,
    /** Files named as standing for a city (a district gets one). */
    cityRepresentatives: 2,
    /** A graph-only entry point needs at least this fan-out (and the repo's 90th percentile). */
    entryMinFanOut: 3,
    manifests: 12,
    manifestScripts: 12,
    /** Languages named per group, and the smallest share worth naming. */
    langs: 3,
    langMinShare: 0.05,
    /** Dominant path prefixes named per group, and the share a directory needs to count as one. */
    prefixes: 3,
    prefixMinShare: 0.2,
    nameChars: 60,
  },
  skeletons: {
    /** No city (or district within its city) gets less than this fraction of an equal share. */
    floor: 0.5,
    /** Tokens one file's skeleton may take: between these, scaled to the budget per district. */
    fileTokens: [120, 320],
    signatureChars: 180,
    docChars: 140,
    /** Top-by-importance files queued per district before the shuffled remainder. */
    topByImportance: 3,
    /** A "distinctive" file needs this many definitions when any candidate has them. */
    distinctiveMinDefs: 3,
    /** Definitions per file that feed the rarity measure. */
    distinctiveDefs: 64,
    /** Candidates tried after the first one that does not fit. */
    maxMisses: 6,
  },
  docs: {
    /** Smallest useful doc entry, in tokens; fewer docs are shown rather than shorter ones. */
    minTokens: 150,
    outlineHeadings: 14,
    headingChars: 60,
    lineChars: 300,
    /** A folder needs this many files for its docs to count. */
    minFiles: 3,
    /** Share of the files under a doc's folder a city or district needs to be named as its subject. */
    subjectShare: 0.5,
  },
  /** Per-city context for the summaries call, as shares of config.ai.digestTokens. */
  city: { scale: 2, floor: 0.05, cap: 0.25, cityEdges: 10, entryPoints: 6 },
  /** Context for one detail button. */
  detail: {
    /** Budget as a share of config.ai.digestTokens. */
    share: 0.2,
    /** Share of that budget for the file itself; the rest goes to its neighbours. */
    fileShare: 0.5,
    neighbours: 8,
    neighbourTokens: 220,
    symbols: 6,
  },
  secrets: {
    /** Characters of each excerpt that are scanned. */
    scanChars: 65536,
    entropyMinLength: 32,
    entropyMinDigits: 3,
    entropyBits: 4.3,
  },
} as const;
