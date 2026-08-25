// services/metrics.mjs
//
// v0.3.2 (F6) - Lightweight in-memory Prometheus-compatible metrics registry.
// Counter / Gauge primitives with optional labels. Serializes to the
// Prometheus text exposition format (v0.0.4).
//
// Threading / concurrency: this plugin runs single-threaded in the DSH
// Node.js process, so we do not need atomics or locks. The registry's
// internal Maps are mutated only from the DSH event loop.
//
// Usage:
//   const m = createMetricsRegistry()
//   m.registerCounter('hermes_link_dispatch_total', 'Total dispatch_task calls', ['mode', 'status'])
//   m.inc('hermes_link_dispatch_total', { mode: 'one-shot', status: 'completed' })
//   m.set('hermes_link_continuable_children', 7, { status: 'idle' })
//   const text = m.serialize()   // text/plain; version=0.0.4

/**
 * @typedef {Object} MetricDefinition
 * @property {'counter'|'gauge'} type
 * @property {string} name
 * @property {string} help
 * @property {string[]} labelNames
 * @property {Map<string, number>} samples   labelKey -> value (labelKey is JSON or sorted-join)
 */

/**
 * Create a metrics registry.
 * @returns {{
 *   registerCounter: (name: string, help: string, labelNames?: string[]) => void,
 *   registerGauge:   (name: string, help: string, labelNames?: string[]) => void,
 *   inc:             (name: string, labels?: Record<string,string>, value?: number) => void,
 *   set:             (name: string, value: number, labels?: Record<string,string>) => void,
 *   get:             (name: string, labels?: Record<string,string>) => number,
 *   serialize:       () => string,
 *   metrics:         () => Array<{name,type,help,labelNames,sampleCount}>,
 * }}
 */
export function createMetricsRegistry() {
  /** @type {Map<string, MetricDefinition>} */
  const defs = new Map()

  function register(type, name, help, labelNames) {
    if (defs.has(name)) throw new Error('[dsh-hermes-link metrics] duplicate registration: ' + name)
    if (!/^[a-zA-Z_:][a-zA-Z0-9_:]*$/.test(name)) {
      throw new Error('[dsh-hermes-link metrics] invalid metric name: ' + name)
    }
    defs.set(name, {
      type,
      name,
      help: help || '',
      labelNames: Array.isArray(labelNames) ? labelNames.slice() : [],
      samples: new Map(),
    })
  }

  function labelKey(labels, labelNames) {
    if (labelNames.length === 0) return ''
    const parts = []
    for (const k of labelNames) {
      const v = labels ? labels[k] : undefined
      // Use \u0002 as the value-sentinel boundary; \u0001 marks undefined.
      // This way an empty-string value `""` is distinguishable from `undefined`.
      if (v === undefined) parts.push(k + '\u0002\u0001')
      else parts.push(k + '\u0002' + String(v))
    }
    return parts.join('\u0003')
  }

  function labelString(key, labelNames) {
    if (!key) return ''
    const pairs = key.split('\u0003')
    const kv = []
    for (let i = 0; i < labelNames.length; i++) {
      const idx = pairs[i].indexOf('\u0002')
      const name = pairs[i].slice(0, idx)
      const raw = pairs[i].slice(idx + 1)
      const value = (raw === '\u0001') ? '' : raw
      kv.push(name + '="' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n') + '"')
    }
    return '{' + kv.join(',') + '}'
  }

  function inc(name, labels, value) {
    if (value === undefined) value = 1
    const def = defs.get(name)
    if (!def) throw new Error('[dsh-hermes-link metrics] inc on unregistered metric: ' + name)
    if (def.type !== 'counter') {
      // Prometheus convention: counters only go up
      throw new Error('[dsh-hermes-link metrics] inc on non-counter metric: ' + name)
    }
    const key = labelKey(labels, def.labelNames)
    def.samples.set(key, (def.samples.get(key) || 0) + value)
  }

  function set(name, value, labels) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error('[dsh-hermes-link metrics] set requires finite number, got: ' + value)
    }
    const def = defs.get(name)
    if (!def) throw new Error('[dsh-hermes-link metrics] set on unregistered metric: ' + name)
    if (def.type !== 'gauge') {
      throw new Error('[dsh-hermes-link metrics] set on non-gauge metric: ' + name)
    }
    const key = labelKey(labels, def.labelNames)
    def.samples.set(key, value)
  }

  function get(name, labels) {
    const def = defs.get(name)
    if (!def) return 0
    const key = labelKey(labels, def.labelNames)
    return def.samples.get(key) || 0
  }

  function serialize() {
    const lines = []
    const names = Array.from(defs.keys()).sort()
    for (const name of names) {
      const def = defs.get(name)
      if (def.samples.size === 0 && def.type === 'gauge') {
        // still emit a zero-value sample so Prometheus picks it up
        def.samples.set('', 0)
      }
      lines.push('# HELP ' + def.name + ' ' + def.help)
      lines.push('# TYPE ' + def.name + ' ' + def.type)
      // Stable order: by label key
      const keys = Array.from(def.samples.keys()).sort()
      for (const k of keys) {
        const v = def.samples.get(k)
        const labels = labelString(k, def.labelNames)
        lines.push(def.name + labels + ' ' + v)
      }
    }
    return lines.join('\n') + (lines.length ? '\n' : '')
  }

  function metrics() {
    return Array.from(defs.values()).map((d) => ({
      name: d.name,
      type: d.type,
      help: d.help,
      labelNames: d.labelNames.slice(),
      sampleCount: d.samples.size,
    }))
  }

  return {
    registerCounter(name, help, labelNames) { register('counter', name, help, labelNames) },
    registerGauge(name, help, labelNames)   { register('gauge',   name, help, labelNames) },
    inc, set, get, serialize, metrics,
  }
}
