/**
 * ScannerManager  (Phase 2)
 * -------------------------
 * Coordinates *registered* scanners via a single WorkerQueue.
 *
 * Lifecycle:
 *   start() -> sets up one setInterval per scanner that enqueues a run().
 *              Each enqueued run is bounded by `concurrency` so we never
 *              have all scanners hammering CPU + Mongo simultaneously.
 *   stop()  -> clears intervals.
 *
 * Skipping behaviour:
 *   If a scanner's previous run is still in the queue or running when its
 *   next tick fires, we *skip* this tick (`_inflight` flag) — preventing
 *   compounding backpressure.
 *
 * Note: This module is INDEPENDENT of the legacy `startCalculationLoop()`
 *       in scannerEngine.js. Both can run side-by-side during migration.
 *       Once all scanners are registered with scannerRegistry, the legacy
 *       loop can be deleted.
 */
const WorkerQueue   = require("./workerQueue");
const registry      = require("./scannerRegistry");

const queue = new WorkerQueue({
  concurrency: Number(process.env.SCANNER_CONCURRENCY) || 4,
});
const _inflight = new Map(); // scannerId -> boolean
const _intervals = new Map(); // scannerId -> handle
const _lastRunAt = new Map(); // scannerId -> ts

async function _runOne(scanner) {
  if (_inflight.get(scanner.id)) return; // skip — previous run still pending
  _inflight.set(scanner.id, true);
  const startedAt = Date.now();
  try {
    await queue.add(
      async () => {
        await scanner.run();
        _lastRunAt.set(scanner.id, Date.now());
      },
      { priority: scanner.priority, name: scanner.id }
    );
  } catch (err) {
    console.error(`[ScannerManager] ${scanner.id} failed:`, err.message);
  } finally {
    _inflight.set(scanner.id, false);
    const dur = Date.now() - startedAt;
    if (dur > 5000) {
      console.warn(`[ScannerManager] ${scanner.id} took ${dur}ms (slow)`);
    }
  }
}

function start() {
  for (const s of registry.listEnabled()) {
    if (_intervals.has(s.id)) continue;
    // Initial run is slightly staggered so they don't all fire on the same tick.
    setTimeout(() => _runOne(s), Math.random() * 1000);
    const handle = setInterval(() => _runOne(s), s.intervalMs);
    _intervals.set(s.id, handle);
    console.log(`[ScannerManager] Registered: ${s.id} (priority=${s.priority}, interval=${s.intervalMs}ms)`);
  }
  console.log(`[ScannerManager] Started with concurrency=${queue.concurrency}`);
}

function stop() {
  for (const [id, handle] of _intervals.entries()) {
    clearInterval(handle);
    _intervals.delete(id);
  }
}

function getStatus() {
  return {
    queue: queue.getStats(),
    scanners: registry.list().map(s => ({
      id: s.id,
      label: s.label,
      enabled: s.enabled,
      priority: s.priority,
      intervalMs: s.intervalMs,
      lastRunAt: _lastRunAt.get(s.id) || null,
      inflight:  !!_inflight.get(s.id),
    })),
  };
}

module.exports = { start, stop, getStatus, _queue: queue };
