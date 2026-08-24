/**
 * queue.js
 *
 * Cola FIFO con concurrencia acotada, sin dependencias externas.
 *
 * Se usa para limitar cuántos procesos ffmpeg corren a la vez: si varias
 * cámaras suben clips atrasados a la vez, el backlog espera en cola en
 * lugar de disparar N ffmpeg simultáneos (que colgaban el Orange Pi).
 */

/**
 * Crea una cola FIFO que ejecuta funciones async con un máximo de
 * `concurrency` tareas simultáneas.
 * @param {number} concurrency - Máximo de tareas en paralelo (>= 1)
 * @returns {{add: (fn: Function) => Promise<any>, size: () => number, running: () => number, drain: () => Promise<void>}}
 */
function createQueue(concurrency) {
    const max = Math.max(1, parseInt(concurrency, 10) || 1);
    const tasks = [];
    let active = 0;

    function next() {
        if (active >= max || tasks.length === 0) return;
        const task = tasks.shift();
        active++;
        let settled = false;
        const finish = (isError, value) => {
            if (settled) return;
            settled = true;
            active--;
            if (isError) task.reject(value);
            else task.resolve(value);
            next();
        };
        try {
            const result = task.fn();
            if (result && typeof result.then === 'function') {
                result.then(v => finish(false, v), e => finish(true, e));
            } else {
                finish(false, result);
            }
        } catch (err) {
            finish(true, err);
        }
    }

    return {
        /**
         * Encola una función (sync o async) y devuelve su Promise.
         * @param {Function} fn
         */
        add(fn) {
            return new Promise((resolve, reject) => {
                tasks.push({ fn, resolve, reject });
                next();
            });
        },
        size: () => tasks.length,
        running: () => active,
        /** Resuelve cuando no queden tareas pendientes ni activas. */
        drain() {
            return new Promise(resolve => {
                const check = () => {
                    if (tasks.length === 0 && active === 0) return resolve();
                    setTimeout(check, 200);
                };
                check();
            });
        }
    };
}

module.exports = { createQueue };
