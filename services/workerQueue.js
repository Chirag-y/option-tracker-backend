/**
 * WorkerQueue  (Phase 2)
 * ----------------------
 * Minimal priority + concurrency in-process queue (no external deps).
 *
 *   const q = new WorkerQueue({ concurrency: 4 });
 *   q.add(async () => { ... }, { priority: 1, name: "swing-tracker" });
 *
 * Lower `priority` number runs first. Within the same priority FIFO order.
 *
 * We intentionally stay in-process (single Node event loop) instead of
 * worker_threads because the scanners are dominated by indicator math
 * and Mongo I/O — both of which V8 handles well asynchronously. The
 * goal here is to *throttle* concurrency and de-stress the CPU, not to
 * achieve true parallelism.
 */
class WorkerQueue {
  constructor({ concurrency = 4 } = {}) {
    this.concurrency = concurrency;
    this.running     = 0;
    this.queue       = [];      // [{ task, priority, name, enqueuedAt, resolve, reject }]
    this.seq         = 0;       // tiebreaker for stable ordering
    this.stats       = { processed: 0, failed: 0, currentDepth: 0, avgLatencyMs: 0, _lat: 0 };
  }

  add(task, { priority = 5, name = "anonymous" } = {}) {
    return new Promise((resolve, reject) => {
      this.queue.push({
        task, priority, name,
        enqueuedAt: Date.now(),
        seq: this.seq++,
        resolve, reject,
      });
      this.queue.sort((a, b) => a.priority - b.priority || a.seq - b.seq);
      this.stats.currentDepth = this.queue.length;
      this._pump();
    });
  }

  _pump() {
    while (this.running < this.concurrency && this.queue.length > 0) {
      const job = this.queue.shift();
      this.stats.currentDepth = this.queue.length;
      this.running += 1;

      Promise.resolve()
        .then(() => job.task())
        .then((result) => {
          const lat = Date.now() - job.enqueuedAt;
          this.stats._lat += lat;
          this.stats.processed += 1;
          this.stats.avgLatencyMs = Math.round(this.stats._lat / this.stats.processed);
          job.resolve(result);
        })
        .catch((err) => {
          this.stats.failed += 1;
          job.reject(err);
        })
        .finally(() => {
          this.running -= 1;
          this._pump();
        });
    }
  }

  getStats() {
    return { ...this.stats, running: this.running, concurrency: this.concurrency };
  }
}

module.exports = WorkerQueue;
