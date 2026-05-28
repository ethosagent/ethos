export class Semaphore {
    count;
    queue = [];
    constructor(count) {
        this.count = count;
    }
    acquire() {
        if (this.count > 0) {
            this.count--;
            return Promise.resolve();
        }
        return new Promise((resolve) => {
            this.queue.push(resolve);
        });
    }
    release() {
        const next = this.queue.shift();
        if (next) {
            next();
        }
        else {
            this.count++;
        }
    }
}
