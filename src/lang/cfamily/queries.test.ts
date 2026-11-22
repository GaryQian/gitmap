import { describe, expect, it } from 'vitest';
import { runQuery } from '../../testing/treesitter';
import { cSyntax, cppSyntax } from './queries';

describe('C and C++ queries', () => {
  it('C: functions behind pointer declarators, prototypes, static and types', async () => {
    const source = 'typedef struct Engine Engine;\nstruct Engine { int n; };\nEngine *make(int n);\nstatic char *label(void) { return 0; }\nchar **names(void) { return list(0); }\nvoid run(Engine *e) { e->step(e); int local(int); }\n';
    const caps = await runQuery(cSyntax.grammar('a.c')!, cSyntax.queries.c, source);
    const of = (capture: string) => caps.filter((c) => c.capture === capture).map((c) => c.text);
    expect(of('definition.function')).toHaveLength(5); // make, label, names, run, and the declaration inside a body,
    expect(of('ignore')).toEqual(['int local(int);']); // which the runner drops
    expect(of('definition.struct')).toHaveLength(1);
    expect(of('definition.type')).toHaveLength(1);
    expect(of('local')).toEqual(['static']);
    expect(of('qualifier')).toEqual(['e']);
    expect(of('name')).toEqual(expect.arrayContaining(['make', 'label', 'names', 'run', 'list', 'step', 'Engine']));
  });

  it('C++: classes, members with their class, namespaces and base classes', async () => {
    const source = 'namespace app {\nclass Widget : public Base {\n public:\n  Widget();\n  void draw();\n};\n}\nvoid app::Widget::draw() { util::log("x"); }\n';
    const caps = await runQuery(cppSyntax.grammar('a.h')!, cppSyntax.queries.cpp, source);
    const of = (capture: string) => caps.filter((c) => c.capture === capture).map((c) => c.text);
    expect(of('definition.module')).toHaveLength(1);
    expect(of('definition.class')).toHaveLength(1);
    expect(of('definition.method').length).toBeGreaterThanOrEqual(3); // constructor, declaration, out-of-class definition
    expect(of('container')).toEqual(['Widget']);
    expect(of('reference.inherit')).toHaveLength(1);
    expect(of('qualifier')).toEqual(['util']);
    expect(of('name')).toEqual(expect.arrayContaining(['app', 'Widget', 'draw', 'Base', 'log']));
  });
});
