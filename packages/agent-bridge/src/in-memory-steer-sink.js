// FW-9 — process-local SteerSink implementation.
//
// One sink per AgentLoop turn surface (CLI REPL, gateway dispatcher). The
// sink is a plain FIFO with a soft cap; `push()` returns false when the cap
// is hit so the surface can drop or warn. Drain is atomic.
export class InMemorySteerSink {
    queue = [];
    cap;
    constructor(options = {}) {
        this.cap = options.cap ?? 32;
    }
    push(text) {
        if (this.queue.length >= this.cap)
            return false;
        this.queue.push(text);
        return true;
    }
    drain() {
        if (this.queue.length === 0)
            return [];
        const out = this.queue;
        this.queue = [];
        return out;
    }
    depth() {
        return this.queue.length;
    }
}
