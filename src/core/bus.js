/**
 * Minimal synchronous event bus. The integration seam between every subsystem.
 * Handlers that throw are logged and skipped — one bad listener never breaks a frame.
 */
export class EventBus {
  constructor() {
    /** @type {Map<string, Set<Function>>} */
    this.listeners = new Map()
    this.debug = false
  }

  on(event, fn) {
    let set = this.listeners.get(event)
    if (!set) this.listeners.set(event, (set = new Set()))
    set.add(fn)
    return () => this.off(event, fn)
  }

  once(event, fn) {
    const wrapped = (payload) => {
      this.off(event, wrapped)
      fn(payload)
    }
    return this.on(event, wrapped)
  }

  off(event, fn) {
    this.listeners.get(event)?.delete(fn)
  }

  emit(event, payload = {}) {
    if (this.debug) console.debug(`[bus] ${event}`, payload)
    const set = this.listeners.get(event)
    if (!set) return
    // copy so handlers may unsubscribe mid-emit
    for (const fn of [...set]) {
      try {
        fn(payload)
      } catch (err) {
        console.error(`[bus] listener failed for "${event}"`, err)
      }
    }
  }

  clear() {
    this.listeners.clear()
  }
}
