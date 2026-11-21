// Lint is deliberately small: TypeScript's recommended rules plus the folder-boundary rule
// from PLAN.md §4 — a module may import another module only through its public entry files.
import tseslint from 'typescript-eslint';
import globals from 'globals';
import path from 'node:path';

const SRC = path.resolve(import.meta.dirname, 'src');
// Folders that are shared vocabulary, importable file-by-file from anywhere.
const OPEN = new Set(['contracts', 'shared', 'testing', 'config']);
// Public entry files of a module: index.ts, plus Node-only and worker entry points and shared types.
const PUBLIC_FILES = new Set(['index', 'node', 'types', 'worker']);

const boundaries = {
  rules: {
    'module-boundary': {
      meta: {
        type: 'problem',
        schema: [],
        messages: { deep: 'Import "{{target}}" through src/{{module}}/index.ts (PLAN.md §4 folder boundaries).' },
      },
      create(context) {
        const file = context.filename;
        const relFile = path.relative(SRC, file);
        if (relFile.startsWith('..')) return {};
        const fromSegs = relFile.split(path.sep);
        const check = (node, source) => {
          if (typeof source !== 'string' || !source.startsWith('.')) return;
          const abs = path.resolve(path.dirname(file), source.replace(/\?.*$/, ''));
          const rel = path.relative(SRC, abs);
          if (rel.startsWith('..')) return;
          const segs = rel.split(path.sep);
          const mod = segs[0];
          if (OPEN.has(mod)) return;
          // src/lang/<id>/ is a module of its own: siblings and outsiders go through its index.
          const isLangPlugin = mod === 'lang' && segs.length > 1 && !segs[1].includes('.') && segs[1] !== 'index';
          const depth = isLangPlugin ? 2 : 1;
          const sameModule = segs.slice(0, depth).join('/') === fromSegs.slice(0, depth).join('/');
          if (sameModule) return;
          if (!isLangPlugin && mod === fromSegs[0] && mod !== 'lang') return;
          const rest = segs.slice(depth);
          if (rest.length === 0) return;
          const leaf = rest[0].replace(/\.(ts|tsx|js)$/, '');
          if (rest.length === 1 && PUBLIC_FILES.has(leaf)) return;
          context.report({ node, messageId: 'deep', data: { target: source, module: segs.slice(0, depth).join('/') } });
        };
        return {
          ImportDeclaration: (n) => check(n, n.source.value),
          ExportNamedDeclaration: (n) => n.source && check(n, n.source.value),
          ExportAllDeclaration: (n) => check(n, n.source.value),
          ImportExpression: (n) => n.source.type === 'Literal' && check(n, n.source.value),
        };
      },
    },
  },
};

export default tseslint.config(
  {
    ignores: [
      'dist/**', 'node_modules/**', 'spikes/**', '.worktrees/**', '.claude/**', '.fixtures/**', 'public/**',
      'fixtures/**', 'out/**', 'playwright-report/**', 'test-results/**',
    ],
  },
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser, ...globals.worker, ...globals.node } },
    plugins: { gitmap: boundaries },
    rules: {
      'gitmap/module-boundary': 'error',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      '@typescript-eslint/no-empty-object-type': 'off',
      '@typescript-eslint/no-unused-expressions': 'off',
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'prefer-const': 'warn',
    },
  },
);
