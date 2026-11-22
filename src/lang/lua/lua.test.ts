import { describe, expect, it } from 'vitest';
import type { FileFacts } from '../../contracts/lang';
import { createRepoIndex } from '../../shared/repoIndex';
import { pluginForPath } from '../index';
import plugins, { extractLuaSymbols, luaResolver, maskLua, scanLua } from './index';

const facts = (path: string, text = ''): FileFacts => ({
  path, oid: '', bytes: text.length, lang: path.endsWith('.luau') ? 'luau' : 'lua', loc: 1, ...scanLua(text),
  ...(path.endsWith('.luaurc') ? { lang: null, excerpt: text } : {}),
});
const specs = (text: string) => scanLua(text).imports.map((i) => `${i.kind}:${i.spec}${i.names ? `=${i.names.join(',')}` : ''}`);

describe('lua plug-ins', () => {
  it('claim .lua and .luau and share one resolver', () => {
    expect(plugins.map((p) => p.id)).toEqual(['lua', 'luau']);
    expect(pluginForPath('src/a.lua')?.id).toBe('lua');
    expect(pluginForPath('src/a.luau')?.id).toBe('luau');
    const index = createRepoIndex([]);
    expect(plugins[0].createResolver!(index)).toBe(plugins[1].createResolver!(index));
    expect(plugins[1].extractSymbols!('export type Id = number', 'a.luau').defs[0]).toMatchObject({ name: 'Id', kind: 'type' });
  });
});

describe('lua mask', () => {
  it('keeps length and line breaks, blanks comments and string contents', () => {
    const text = [
      '#!/usr/bin/env lua',
      'local a = "require \'x\'" -- require "y"',
      '--[==[ long',
      'comment ]] still ]==] local b = [[ long',
      'string ]] .. \'it\\\'s\' .. `hi {name}`',
      'local c = "open',
      'local d = 1',
    ].join('\n');
    const masked = maskLua(text);
    expect(masked.length).toBe(text.length);
    expect(masked.split('\n').map((l) => l.replace(/ +/g, ' ').trim())).toEqual([
      '',
      'local a = " "',
      '',
      'local b = "',
      '" .. " " .. " "',
      'local c = " "',
      'local d = 1',
    ]);
  });
});

describe('lua scanner', () => {
  it('reads requires with a literal or an instance path, and the local they are bound to', () => {
    expect(specs([
      `local json = require("json")`,
      `local util = require 'app.util'`,
      `local T: Types = require("./types")`,
      `require [[side.effect]]`,
      `dofile("scripts/boot.lua")`,
      `local chunk = loadfile "conf.lua"`,
      `local Util = require(script.Parent.Util)`,
      `local Roact = require(ReplicatedStorage.Packages.Roact)`,
      `local Child = require(script:WaitForChild("Child", 5))`,
      `local Spec = require(script.Parent["Foo.spec"])`,
      `Signal = require(game:GetService("ReplicatedStorage").Signal)`,
      `local dyn = require(name)`,
      `local cat = require("a." .. name)`,
      `local ok, mod = pcall(require, "lazy")`,
      `local m = loader.require("not.ours")`,
      `-- require("in.comment")`,
      `local s = "require('in.string')"`,
    ].join('\n'))).toEqual([
      'require:json=json',
      'require:app.util=util',
      'require:./types=T',
      'require:side.effect',
      'file:scripts/boot.lua',
      'file:conf.lua=chunk',
      'instance:script.Parent.Util=Util',
      'instance:ReplicatedStorage.Packages.Roact=Roact',
      'instance:script.Child=Child',
      'instance:script.Parent.Foo.spec=Spec',
    ]);
  });

  it('never throws', () => {
    for (const text of ['', '"', "'", '`', '[[', '--[[', '--[==[', 'require', 'require(', 'require("', 'require(script.', 'require(script:WaitForChild(', '#!']) {
      expect(() => scanLua(text)).not.toThrow();
      expect(() => extractLuaSymbols(text, true)).not.toThrow();
    }
  });
});

describe('lua resolver', () => {
  const index = createRepoIndex([
    facts('main.lua'),
    facts('conf.lua'),
    facts('app/util.lua'),
    facts('app/models/user.lua'),
    facts('app/models/init.lua'),
    facts('lua/myplugin/init.lua'),
    facts('lua/myplugin/config.lua'),
    facts('vendor/dk/json.lua'),
    facts('tools/gen/main.lua'),
    facts('tools/gen/json.lua'),
    facts('game/.luaurc', '{ "aliases": { "Shared": "src/shared", }, } // tolerant'),
    facts('game/src/shared/Util.luau'),
    facts('game/src/shared/Net/init.luau'),
    facts('game/src/shared/Net/Remote.luau'),
    facts('game/src/server/Main.server.luau'),
    facts('game/src/server/Data.lua'),
    facts('game/src/client/Util.luau'),
    facts('game/src/client/Hud.luau'),
    facts('game/Packages/Roact/init.lua'),
  ]);
  const resolver = luaResolver(index);
  const resolve = (from: string, kind: string, spec: string) => resolver.resolve(index.get(from)!, { spec, kind });
  const paths = (from: string, kind: string, spec: string) => resolve(from, kind, spec).map((r) => r.path);

  it('resolves dotted requires from the root, then load roots, never a lone name off the path', () => {
    expect(resolve('main.lua', 'require', 'app.util')).toEqual([{ path: 'app/util.lua', confidence: 1 }]);
    expect(resolve('main.lua', 'require', 'app/models/user.lua')).toEqual([{ path: 'app/models/user.lua', confidence: 1 }]);
    expect(resolve('main.lua', 'require', 'app.models')).toEqual([{ path: 'app/models/init.lua', confidence: 1 }]);
    expect(paths('lua/myplugin/init.lua', 'require', 'myplugin.config')).toEqual(['lua/myplugin/config.lua']);
    expect(paths('main.lua', 'require', 'myplugin')).toEqual(['lua/myplugin/init.lua']);
    // json.lua exists twice, but only the one under a root the requiring file sits in is on its path.
    expect(paths('tools/gen/main.lua', 'require', 'json')).toEqual(['tools/gen/json.lua']);
    expect(paths('main.lua', 'require', 'json')).toEqual([]);
    expect(paths('main.lua', 'require', 'socket.http')).toEqual([]);
    // A longer path that matches by suffix alone is a guess.
    const guessed = resolve('main.lua', 'require', 'dk.json');
    expect(guessed.map((r) => r.path)).toEqual(['vendor/dk/json.lua']);
    expect(guessed[0].confidence).toBeLessThan(1);
    expect(paths('main.lua', 'file', 'conf.lua')).toEqual(['conf.lua']);
    expect(paths('app/models/user.lua', 'file', 'init.lua')).toEqual(['app/models/init.lua']);
  });

  it('resolves Luau string requires: relative, @self and .luaurc aliases', () => {
    expect(resolve('game/src/client/Hud.luau', 'require', './Util')).toEqual([{ path: 'game/src/client/Util.luau', confidence: 1 }]);
    expect(paths('game/src/client/Hud.luau', 'require', '../shared/Net')).toEqual(['game/src/shared/Net/init.luau']);
    expect(paths('game/src/client/Hud.luau', 'require', '../server/Data')).toEqual(['game/src/server/Data.lua']);
    expect(paths('game/src/shared/Net/init.luau', 'require', '@self/Remote')).toEqual(['game/src/shared/Net/Remote.luau']);
    expect(paths('game/src/shared/Net/init.luau', 'require', './Util')).toEqual(['game/src/shared/Util.luau']);
    expect(resolve('game/src/client/Hud.luau', 'require', '@Shared/Net/Remote')).toEqual([{ path: 'game/src/shared/Net/Remote.luau', confidence: 1 }]);
    expect(paths('game/src/client/Hud.luau', 'require', '@Shared/Missing')).toEqual([]);
    expect(paths('game/src/client/Hud.luau', 'require', './Hud')).toEqual([]); // itself
  });

  it('walks Roblox instance paths from `script`, and guesses the rest by their tail', () => {
    expect(resolve('game/src/client/Hud.luau', 'instance', 'script.Parent.Util')).toEqual([{ path: 'game/src/client/Util.luau', confidence: 1 }]);
    expect(paths('game/src/server/Main.server.luau', 'instance', 'script.Parent.Data')).toEqual(['game/src/server/Data.lua']);
    expect(paths('game/src/shared/Net/init.luau', 'instance', 'script.Remote')).toEqual(['game/src/shared/Net/Remote.luau']);
    expect(paths('game/src/shared/Net/Remote.luau', 'instance', 'script.Parent.Parent.Util')).toEqual(['game/src/shared/Util.luau']);
    expect(paths('main.lua', 'instance', 'script.Parent.Parent.X')).toEqual([]);
    const byTail = resolve('game/src/client/Hud.luau', 'instance', 'game.ReplicatedStorage.shared.Net.Remote');
    expect(byTail.map((r) => r.path)).toEqual(['game/src/shared/Net/Remote.luau']);
    expect(byTail[0].confidence).toBeLessThan(1);
    const byName = resolve('game/src/client/Hud.luau', 'instance', 'ReplicatedStorage.Packages.Roact');
    expect(byName.map((r) => r.path)).toEqual(['game/Packages/Roact/init.lua']);
    // Two modules are called Util: the one nearest the requiring file, at the lowest confidence.
    const near = resolve('game/src/shared/Net/Remote.luau', 'instance', 'Modules.Util');
    expect(near.map((r) => r.path)).toEqual(['game/src/shared/Util.luau']);
    expect(near[0].confidence).toBeLessThan(byName[0].confidence);
    expect(paths('main.lua', 'instance', 'Players.LocalPlayer')).toEqual([]);
  });
});

describe('lua symbols', () => {
  const show = (text: string, luau = false) => {
    const { defs, refs } = extractLuaSymbols(text, luau);
    return {
      defs: defs.map((d) => `${d.kind} ${d.container ? `${d.container}.` : ''}${d.name}${d.exported === false ? ' (local)' : ''} @${d.line}`),
      refs: refs.map((r) => `${r.kind} ${r.qualifier ? `${r.qualifier}.` : ''}${r.name}${r.count > 1 ? ` x${r.count}` : ''}`),
      byName: new Map(defs.map((d) => [d.name, d])),
    };
  };

  it('reads a module: functions in every form, locals, and what the chunk hands out', () => {
    const { defs, refs, byName } = show([
      `local json = require("json")`,
      `--- Helpers for strings.`,
      `-- Second line.`,
      `local M = {}`,
      ``,
      `-- Trims both ends.`,
      `function M.trim(s)`,
      `  return (s:gsub("^%s+", ""))`,
      `end`,
      ``,
      `local function helper(a, b)`,
      `  local function inner() end`,
      `  if a then return json.encode(b) end`,
      `  return inner()`,
      `end`,
      ``,
      `local shared = function(x) return helper(x, x) end`,
      `M.pad = function(s, n)`,
      `  for i = 1, n do s = s .. " " end`,
      `  return s`,
      `end`,
      `M.shared = shared`,
      `function globalFn() print "hi" end`,
      `M.__tostring = function() return "M" end`,
      `return M`,
    ].join('\n'));
    expect(defs).toEqual([
      'module M @4',
      'function M.trim @7',
      'function helper (local) @11',
      'function inner (local) @12',
      'function shared @17',
      'function M.pad @18',
      'function globalFn @23',
    ]);
    expect(byName.get('M')).toMatchObject({ signature: 'local M', doc: 'Helpers for strings. Second line.' });
    expect(byName.get('trim')).toMatchObject({ signature: 'function M.trim(s)', doc: 'Trims both ends.' });
    expect(byName.get('shared')!.signature).toBe('local shared = function(x)');
    expect(refs).toEqual(expect.arrayContaining(['call require', 'call s.gsub', 'call json.encode', 'call inner', 'call helper', 'call print']));
    expect(refs).not.toContain('call trim');
  });

  it('reads classes, methods and inheritance', () => {
    const { defs, refs } = show([
      `local Base = require("base")`,
      `--[[`,
      `  A dog.`,
      `]]`,
      `local Dog = setmetatable({}, { __index = Base })`,
      `Dog.__index = Dog`,
      ``,
      `function Dog.new(name)`,
      `  local self = setmetatable(Base.new(name), Dog)`,
      `  self.onBark = function() end`,
      `  return self`,
      `end`,
      ``,
      `function Dog:bark(times)`,
      `  self:emit("bark", times)`,
      `  return Dog.count(self)`,
      `end`,
      ``,
      `local Puppy = Dog:extend()`,
      `function Puppy:bark() Dog.bark(self, 1) end`,
      ``,
      `local Plain = {}`,
      `return { Dog = Dog, Puppy = Puppy, make = function(n) return Dog.new(n) end }`,
    ].join('\n'));
    expect(defs).toEqual([
      'class Dog @5',
      'function Dog.new @8',
      'method Dog.bark @14',
      'class Puppy @19',
      'method Puppy.bark @20',
      'function make @23',
    ]);
    expect(refs).toEqual(expect.arrayContaining(['inherit Base', 'inherit Dog', 'call Base.new', 'call emit', 'call Dog.count', 'call Dog.bark', 'call Dog.new']));
    expect(extractLuaSymbols('--[[\n  A dog.\n]]\nlocal Dog = {}\nDog.__index = Dog', false).defs[0].doc).toBe('A dog.');
  });

  it('reads Luau: type aliases, annotations and if-expressions that take no end', () => {
    const { defs, refs } = show([
      `--!strict`,
      `local Types = require(script.Parent.Types)`,
      `export type Options = { name: string, kind: Types.Kind, parent: Node? }`,
      `type Callback<T> = (value: T) -> Result`,
      ``,
      `local Widget = {}`,
      `Widget.__index = Widget`,
      ``,
      `function Widget.new(options: Options): Widget`,
      `  local size = if options.name then #options.name else 0`,
      `  local label = if size > 3 then "long" elseif size > 0 then "short" else "none"`,
      `  local self = setmetatable({}, Widget)`,
      `  self.label = (label :: any) :: Label`,
      `  return self`,
      `end`,
      ``,
      `local function render<T>(widget: Widget, sink: Sink | Buffer)`,
      `  sink:write(\`{widget.label} is {size}\`)`,
      `end`,
      ``,
      `function Widget:destroy() end`,
      ``,
      `return Widget`,
    ].join('\n'), true);
    expect(defs).toEqual([
      'type Options @3',
      'type Callback (local) @4',
      'class Widget @6',
      'function Widget.new @9',
      'function render (local) @17',
      'method Widget.destroy @21',
    ]);
    expect(refs).toEqual(expect.arrayContaining(['type Types.Kind', 'type Node', 'type Result', 'type Options', 'type Widget x2', 'type Label', 'type Sink', 'type Buffer', 'call sink.write']));
    expect(extractLuaSymbols('function Widget.new(options: Options): Widget\nend', true).defs[0].signature).toBe('function Widget.new(options: Options): Widget');
  });

  it('keeps top-level definitions top-level after a block it misreads', () => {
    const { defs } = show([
      `local function a()`,
      `  if x then`,   // never closed
      `end`,
      `M = {}`,
      `M.b = function() end`,
      `function M.c() end`,
    ].join('\n'));
    expect(defs).toEqual(['function a (local) @1', 'module M @4', 'function M.b @5', 'function M.c @6']);
  });
});
