/**
 * HealthMonitor  (Phase 8)
 * ------------------------
 * Lightweight in-process metrics sampler.
 *
 *   - RAM:    process.memoryUsage()       (rss, heapUsed, external)
 *   - CPU:    process.cpuUsage() delta     (microseconds -> %)
 *   - Event loop lag (perf_hooks)
 *   - Active socket clients, scanner queue depth, indicator cache size
 *
 * Snapshots are kept in a ring buffer of `HISTORY_LEN` samples (default 120 =
 * 1 hour at 30 s cadence) for trend inspection via /api/admin/health.
 */
const os                = require("os");
const { performance, monitorEventLoopDelay } = require("perf_hooks");

const SAMPLE_MS   = 30_000;
const HISTORY_LEN = 120;

const _history = [];
let _interval  = null;
let _lastCpu   = process.cpuUsage();
let _lastTs    = Date.now();
let _loopDelay = null;

function _safeRequire(modPath) {
  try { return require(modPath); } catch (_) { return null; }
}

function _sample() {
  const now = Date.now();
  const cpu = process.cpuUsage(_lastCpu);
  const mem = process.memoryUsage();
  const elapsedUs = (now - _lastTs) * 1000;
  const cpuPct = elapsedUs > 0
    ? Math.min(100, ((cpu.user + cpu.system) / elapsedUs) * 100)
    : 0;
  _lastCpu = process.cpuUsage();
  _lastTs  = now;

  let eventLoopLagMs = null;
  if (_loopDelay) {
    eventLoopLagMs = Number((_loopDelay.mean / 1e6).toFixed(2));
    _loopDelay.reset();
  }

  // Cross-module pulls (avoid hard-deps via require-at-runtime).
  const scannerManager = _safeRequire("./scannerManager");
  const indicatorCache = _safeRequire("./indicatorCache");
  const candleCache    = _safeRequire("./candleCacheManager");
  const liveUniverse   = _safeRequire("./liveUniverseManager");
  const socketServer   = _safeRequire("./socketServer");
  const alertManager   = _safeRequire("./alertManager");

  const sample = {
    ts: now,
    cpuPct: Number(cpuPct.toFixed(1)),
    loadavg: os.loadavg(),
    memory: {
      rssMB:      Math.round(mem.rss      / 1024 / 1024),
      heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
      externalMB: Math.round(mem.external / 1024 / 1024),
    },
    eventLoopLagMs,
    scannerQueue:  scannerManager ? scannerManager.getStatus().queue : null,
    indicatorCache: indicatorCache ? indicatorCache.stats() : null,
    candleCache:   candleCache    ? candleCache.stats()    : null,
    liveUniverse:  liveUniverse   ? liveUniverse.getSummary() : null,
    sockets:       socketServer   ? socketServer.getStats() : null,
    alerts:        alertManager   ? alertManager.getStats() : null,
  };
  _history.push(sample);
  if (_history.length > HISTORY_LEN) _history.shift();
  return sample;
}

function start() {
  if (_interval) return;
  _loopDelay = monitorEventLoopDelay({ resolution: 20 });
  _loopDelay.enable();
  _interval = setInterval(_sample, SAMPLE_MS);
  if (_interval.unref) _interval.unref();
  _sample(); // first sample immediately
  console.log(`[HealthMonitor] Started — sampling every ${SAMPLE_MS / 1000}s`);
}

function stop() {
  if (_interval) { clearInterval(_interval); _interval = null; }
  if (_loopDelay) { _loopDelay.disable(); _loopDelay = null; }
}

function snapshot() {
  return _history.length ? _history[_history.length - 1] : _sample();
}

function history() {
  return _history.slice();
}

module.exports = { start, stop, snapshot, history, _internal: { performance } };
