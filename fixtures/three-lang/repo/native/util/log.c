#include <stdio.h>
#include "log.h"

void log_info(const char *message) {
    fprintf(stderr, "[info] %s\n", message);
}
