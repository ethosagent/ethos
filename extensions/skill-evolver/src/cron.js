// In-process cron registration for the skill evolver.
// The extension owns the *scheduling* logic (when to fire) but not the
// *execution* logic (what to run). The app layer passes an `onFire` callback
// so that the extension never references CLI command strings or the app module
// graph.
import { Cron } from 'croner';
/**
 * Register an in-process cron job that calls `onFire` on the given schedule.
 * Returns a cleanup function that stops the job.
 *
 * `protect: true` prevents overlapping runs — if a prior callback is still
 * running when the next tick fires, the new tick is skipped silently.
 */
export function registerEvolverCron(schedule, onFire) {
    const job = new Cron(schedule, { protect: true }, () => void onFire());
    return () => {
        job.stop();
    };
}
