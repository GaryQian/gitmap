import { Parser, Language } from 'web-tree-sitter';
await Parser.init();
const [lang, code] = process.argv.slice(2);
const l = await Language.load(`../node_modules/@repomix/tree-sitter-wasms/out/tree-sitter-${lang}.wasm`);
const p = new Parser(); p.setLanguage(l);
const t = p.parse(code)!;
function pr(n:any, d=0){ console.log('  '.repeat(d)+(n.isNamed? n.type : JSON.stringify(n.type)) + (n.childCount===0? ' '+JSON.stringify(n.text):'')); for (let i=0;i<n.childCount;i++){ const c=n.child(i); const fn=n.fieldNameForChild(i); if(fn) process.stdout.write('  '.repeat(d+1)+fn+': \n'); pr(c,d+1);} }
pr(t.rootNode);
