#ifndef ENGINE_H
#define ENGINE_H

typedef struct Engine Engine;

Engine *engine_create(int workers);
int engine_run(Engine *engine);
void engine_destroy(Engine *engine);

#endif
