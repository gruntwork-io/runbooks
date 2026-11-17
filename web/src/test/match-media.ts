import { vi } from "vitest"

type LegacyListener = (this: MediaQueryList, event: MediaQueryListEvent) => unknown

/**
 * Installs a typed window.matchMedia, which jsdom lacks. Every query gets the
 * same list, whose `matches` the test sets with `change`, as the OS or a
 * resize would, telling the listeners subscribed through either API.
 */
export function installMatchMedia(initial: boolean) {
  let matches = initial
  let media = ""
  const listeners = new Set<EventListenerOrEventListenerObject>()
  const legacyListeners = new Set<LegacyListener>()
  const list: MediaQueryList = {
    get matches() {
      return matches
    },
    get media() {
      return media
    },
    onchange: null,
    addEventListener(_type: string, listener: EventListenerOrEventListenerObject | null) {
      if (listener) listeners.add(listener)
    },
    removeEventListener(_type: string, listener: EventListenerOrEventListenerObject | null) {
      if (listener) listeners.delete(listener)
    },
    addListener(listener: LegacyListener | null) {
      if (listener) legacyListeners.add(listener)
    },
    removeListener(listener: LegacyListener | null) {
      if (listener) legacyListeners.delete(listener)
    },
    dispatchEvent: () => true,
  }
  const matchMedia = vi.fn((query: string) => {
    media = query
    return list
  })
  window.matchMedia = matchMedia
  return {
    matchMedia,
    /** How many listeners are subscribed, through either API. */
    listenerCount: () => listeners.size + legacyListeners.size,
    /** Sets `matches` and tells every listener. */
    change(next: boolean) {
      matches = next
      const event: MediaQueryListEvent = Object.assign(new Event("change"), { matches, media })
      for (const listener of Array.from(listeners)) {
        if (typeof listener === "function") listener(event)
        else listener.handleEvent(event)
      }
      for (const listener of Array.from(legacyListeners)) listener.call(list, event)
    },
  }
}
