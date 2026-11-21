#include <stdio.h>
#include "engine.h"
#include "util/log.h"

/* #include "not_real.h" */

int main(void) {
    log_info("starting");
    Engine *e = engine_create(4);
    printf("%d\n", engine_run(e));
    engine_destroy(e);
    return 0;
}
