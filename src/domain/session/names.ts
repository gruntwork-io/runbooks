/**
 * Names for sessions that a person can read and say: an adjective and a noun,
 * as in `elegant-elephant`. The title bar shows the name, and the sessions
 * database keeps it unique.
 */

const ADJECTIVES = [
  "agile",
  "amber",
  "ardent",
  "bold",
  "brave",
  "breezy",
  "bright",
  "brisk",
  "calm",
  "candid",
  "cheerful",
  "clever",
  "cosmic",
  "cozy",
  "crisp",
  "curious",
  "dapper",
  "daring",
  "deft",
  "eager",
  "earnest",
  "elegant",
  "fearless",
  "fluffy",
  "friendly",
  "gentle",
  "gleaming",
  "golden",
  "graceful",
  "happy",
  "hardy",
  "honest",
  "humble",
  "jolly",
  "jovial",
  "keen",
  "kind",
  "lively",
  "lucid",
  "lucky",
  "mellow",
  "merry",
  "mighty",
  "modest",
  "nimble",
  "noble",
  "patient",
  "peppy",
  "placid",
  "plucky",
  "polite",
  "proud",
  "quick",
  "quiet",
  "radiant",
  "rapid",
  "relaxed",
  "sage",
  "serene",
  "shiny",
  "silver",
  "sleek",
  "snappy",
  "spry",
  "steady",
  "sturdy",
  "sunny",
  "swift",
  "tidy",
  "trusty",
  "upbeat",
  "valiant",
  "vivid",
  "warm",
  "witty",
  "zesty",
] as const

const NOUNS = [
  "acorn",
  "anchor",
  "arrow",
  "badger",
  "beacon",
  "birch",
  "breeze",
  "bridge",
  "brook",
  "canyon",
  "cedar",
  "cello",
  "cloud",
  "comet",
  "compass",
  "coral",
  "cove",
  "creek",
  "delta",
  "dune",
  "eagle",
  "elephant",
  "ember",
  "falcon",
  "fern",
  "fjord",
  "forest",
  "garden",
  "glacier",
  "harbor",
  "heron",
  "island",
  "juniper",
  "kettle",
  "kite",
  "lagoon",
  "lantern",
  "ledger",
  "lighthouse",
  "maple",
  "meadow",
  "mesa",
  "meteor",
  "mountain",
  "nebula",
  "oasis",
  "orchard",
  "otter",
  "pebble",
  "pine",
  "planet",
  "pond",
  "prairie",
  "quartz",
  "quill",
  "rain",
  "reef",
  "ridge",
  "river",
  "rocket",
  "sail",
  "sparrow",
  "spruce",
  "summit",
  "sunrise",
  "thicket",
  "thunder",
  "tundra",
  "valley",
  "violin",
  "walnut",
  "wave",
  "willow",
  "window",
  "yarn",
  "zebra",
] as const

/** The longest a session name can be: the length limit of a DNS label, which a name is shaped like. */
export const SESSION_NAME_MAX_LENGTH = 63

/** Lowercase letters and digits, in groups joined by single hyphens. */
const SESSION_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/**
 * Why `name` can't be a session's name, as a sentence to show the person who
 * typed it, or undefined when it can. Every name sessionNameCandidates offers
 * passes.
 *
 * A name is 1 to 63 characters: lowercase letters, digits and hyphens, with a
 * letter or digit at each end and no two hyphens in a row. That keeps a name
 * one word that reads the same wherever it is shown or typed, in the title
 * bar, a terminal or a URL.
 */
export function sessionNameProblem(name: string): string | undefined {
  if (name === "") return "Enter a name."
  if (name.length > SESSION_NAME_MAX_LENGTH) {
    return `A session name can be at most ${SESSION_NAME_MAX_LENGTH} characters.`
  }
  if (!SESSION_NAME.test(name)) {
    return "Use lowercase letters, digits and hyphens, with a letter or digit at each end and no two hyphens in a row."
  }
  return undefined
}

/** Random pairs to offer before giving up on a plain `adjective-noun`. */
const PLAIN_CANDIDATES = 10

/** The highest number tried as a suffix, as in `elegant-elephant-2`. */
const HIGHEST_SUFFIX = 20

/**
 * Names to try for a new session, best first. The caller takes the first one
 * no other session has.
 *
 * The list starts with random `adjective-noun` pairs. When all of those are
 * taken, which takes thousands of sessions, it goes on to one more pair with
 * a number after it (`elegant-elephant-2`), and ends with that pair followed
 * by `uniqueSuffix`. Pass something no other session has, such as the
 * session's id, and the last name can't be taken.
 *
 * `random` returns a number in [0, 1), like Math.random.
 */
export function sessionNameCandidates(random: () => number, uniqueSuffix: string): string[] {
  const pair = () => `${pick(ADJECTIVES, random)}-${pick(NOUNS, random)}`
  const plain = Array.from({ length: PLAIN_CANDIDATES }, pair)
  const base = pair()
  const numbered = Array.from({ length: HIGHEST_SUFFIX - 1 }, (_, i) => `${base}-${i + 2}`)
  return [...plain, ...numbered, `${base}-${uniqueSuffix}`]
}

function pick(words: readonly string[], random: () => number): string {
  // Math.min: a `random` that returns 1 must not index past the end.
  return words[Math.min(Math.floor(random() * words.length), words.length - 1)]!
}
