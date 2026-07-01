/**
 * ScannerRegistry  (Phase 7)
 * --------------------------
 * Catalog of available scanners. Each entry is a self-describing object
 * the Scanner Manager (Phase 2) and HTTP routes can iterate over.
 *
 *   register({
 *     id:          "swing-tracker",
 *     label:       "Swing Tracker",
 *     priority:    1,             // 0 = highest. Worker queue uses this.
 *     universe:    "swing",       // "fo" | "intraday" | "swing" | "index" | "commodity"
 *     intervalMs:  60_000,        // run cadence
 *     run:         async () => { ... },   // returns an array of signals OR void if it dispatches internally
 *   });
 *
 * The existing scannerEngine code does NOT need to migrate to the registry
 * to deploy. The Scanner Manager (Phase 2) registers wrappers around the
 * existing in-engine handlers; over time scanners can move out of the
 * monolith into standalone files that register themselves directly.
 */

const _scanners = new Map();

function register(def) {
  if (!def || !def.id) throw new Error("ScannerRegistry.register: id is required");
  if (typeof def.run !== "function") throw new Error("ScannerRegistry.register: run() is required");
  _scanners.set(def.id, {
    id:         def.id,
    label:      def.label || def.id,
    priority:   typeof def.priority === "number" ? def.priority : 5,
    universe:   def.universe || "fo",
    intervalMs: def.intervalMs || 60_000,
    run:        def.run,
    meta:       def.meta || {},
    enabled:    def.enabled !== false,
  });
}

function get(id) { return _scanners.get(id) || null; }
function list()  { return Array.from(_scanners.values()); }
function listEnabled() { return list().filter(s => s.enabled); }
function setEnabled(id, enabled) {
  const s = _scanners.get(id);
  if (s) s.enabled = !!enabled;
}
function size() { return _scanners.size; }
function clear() { _scanners.clear(); }

module.exports = { register, get, list, listEnabled, setEnabled, size, clear };
