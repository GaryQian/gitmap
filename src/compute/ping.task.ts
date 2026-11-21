// A task that answers with its input: a health check for the pool and a way to warm its workers up.
import { defineTask } from '../contracts/compute';

export default defineTask<unknown, unknown>({
  type: 'compute.ping',
  run(input, ctx) {
    // A buffer goes back the way it came: transferred, not copied.
    if (input instanceof ArrayBuffer) ctx.transfer(input);
    return input;
  },
});
