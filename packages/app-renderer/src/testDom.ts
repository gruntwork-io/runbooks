/**
 * A DOM for the window's tests that type and click, from jsdom. `installDom`
 * puts the globals of a jsdom window that `globalThis` lacks on it, and the
 * function it returns takes them off again: bun runs every test file on one
 * global object, so a test file installs it for itself alone. React DOM
 * decides at load whether it has a DOM, so a test file loads it, through
 * Testing Library, only after `installDom`.
 *
 * Every test file gets the same window: Testing Library loads once for the
 * run, and its `screen` keeps the body of the document it loaded with.
 */
import { JSDOM } from "jsdom"

let shared: (Window & typeof globalThis) | undefined

export function installDom(): () => void {
  shared ??= new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://localhost/",
  }).window
  const window = shared
  const added = Object.getOwnPropertyNames(window).filter((key) => !(key in globalThis))
  for (const key of added)
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value: Reflect.get(window, key),
    })
  // React's `act` warns unless the test environment says it uses it.
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true)
  return () => {
    for (const key of [...added, "IS_REACT_ACT_ENVIRONMENT"])
      Reflect.deleteProperty(globalThis, key)
  }
}
