import { getLang, extract } from './lib.ts';
import { Query } from 'web-tree-sitter';
import { QUERIES } from './queries.ts';
const samples: Record<string,string> = {
  typescript: 'interface I {} type T = 1; enum E {A} abstract class A { abstract m(): void; } class C { m(){ foo(); this.bar(); new X(); } } const f = () => g(); function h(){}',
  tsx: 'function App(){ return <div onClick={() => go()} /> } class C {}',
  javascript: 'class C { m(){ foo(); a.b(); } } const f = function(){}; function* g(){} new X();',
  python: 'class A:\n  def m(self): foo(); self.bar()\ndef top(): pass\n',
  cpp: 'namespace n { class A { void m(); }; void A::m(){ foo(); x.bar(); std::baz(); make<int>(); o.tpl<int>(); } using T = int; struct S {}; } int main(){}',
  c: 'struct S { int a; }; typedef int T; int f(int); int g(){ return f(1) + s.cb(); }',
  dart: 'class A { int foo(int x) { bar(x); this.baz(1); return a.b.qux(2); } A(); get g => 1; } void top() { new C(); } typedef F = void Function(); enum E { a } mixin M {} extension X on A {}',
  java: 'class A { A(){} void m(){ foo(); x.bar(); new B(); } } interface I {} enum E {}',
  rust: 'struct S; enum E {} trait T {} fn f(){ g(); x.m(); a::b(); println!("x"); } mod m {} type U = i32;',
};
for (const [name, code] of Object.entries(samples)) {
  try {
    const b = await getLang(name);
    const t = b.parser.parse(code)!;
    const caps = b.query!.captures(t.rootNode);
    const names = caps.filter(c=>c.name!=='name').map((c,i)=>c.name.split('.')[0][0]+':'+caps.find(x=>x.name==='name' && x.node.startIndex>=c.node.startIndex && x.node.endIndex<=c.node.endIndex)?.node.text);
    console.log(name, 'err=', t.rootNode.hasError, names.join(' '));
    t.delete();
  } catch (e:any) { console.log(name, 'QUERY ERR', e.message); }
}
