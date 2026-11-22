// Lua and Luau plug-ins. They share the scanner, the symbol extractor and one resolver instance, so
// a `.luau` file requiring a `.lua` module resolves directly (Roblox projects mix the two). Neither
// has a grammar for the tree-sitter runtime in use, so the slow pass is `extractSymbols`
// (./symbols.ts).
import { config } from '../../config';
import type { LanguagePlugin } from '../../contracts/lang';
import { languageColor } from '../../shared';
import { LUAURC, luaResolver } from './resolve';
import { scanLua } from './scan';
import { extractLuaSymbols } from './symbols';

export { maskLua } from './mask';
export { luaResolver } from './resolve';
export { scanLua } from './scan';
export { extractLuaSymbols } from './symbols';

const lua: LanguagePlugin = {
  id: 'lua',
  name: 'Lua',
  extensions: ['lua', 'rockspec'],
  color: languageColor('lua', config.visual, '#5b6ee1'),
  scan: (text) => scanLua(text),
  extractSymbols: (text) => extractLuaSymbols(text, false),
  createResolver: luaResolver,
};

const luau: LanguagePlugin = {
  id: 'luau',
  name: 'Luau',
  extensions: ['luau'],
  color: languageColor('luau', config.visual, '#00a2ff'),
  manifests: [LUAURC],
  scan: (text) => scanLua(text),
  extractSymbols: (text) => extractLuaSymbols(text, true),
  createResolver: luaResolver,
};

export default [lua, luau];
