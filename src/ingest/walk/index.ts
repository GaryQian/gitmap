// The folder walk and its gitignore matcher (package 3Q). Used by the manifest for plain folders and
// for untracked files; exported so the update flow can reuse both.
export { compileIgnore, chainIgnores, IgnoreMatcher, type CompileOptions, type IgnoreRules } from './ignore';
export { walkTree, gitIgnoresCase, WalkLimitError, type WalkOptions, type WalkedFile } from './walk';
