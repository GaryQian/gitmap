#include <stdlib.h>
#include "engine.h"
#include "util/log.h"

struct Engine { int workers; };

Engine *engine_create(int workers) {
    Engine *e = malloc(sizeof(Engine));
    e->workers = workers;
    log_info("engine created");
    return e;
}

int engine_run(Engine *engine) {
    return engine->workers * 2;
}

void engine_destroy(Engine *engine) {
    free(engine);
}
