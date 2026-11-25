/**
 * A session's credential blocks: each one's lifecycle and provider. The
 * engine moves a block between the states of `../credential/lifecycle.ts`;
 * its provider only answers calls.
 *
 * - A block's lifecycle starts, at Detecting, once the session is trusted
 *   and the blocks it waits for are done. Its provider is opened then, and
 *   only through the trusted session's `Runner`, so nothing runs before
 *   trust.
 * - Open decision 7: a login detected for a block that pins nothing waits
 *   in Found for the person; one detected for a block that pins its
 *   targets is used with no click if they match. Ready always means every
 *   pinned level's target is the pin: the engine checks, not only the
 *   provider.
 * - Every move goes through `move`, which refuses one `TRANSITIONS` does
 *   not list and keeps the credential store to its rule: it holds a
 *   block's values exactly while the block is Ready.
 * - A person or agent moves the block with an action (`act`). `TAKEN_IN`
 *   says which states take which action; anything else is NotAllowed, and
 *   a method, level or target the state does not offer is NotOffered.
 * - A Ready credential is Expired from `EXPIRY_WARNING_MILLIS` before its
 *   expiry, which withdraws its values. Before then the engine refreshes it
 *   through `env`, and a later expiry keeps it Ready. A run that reads it in
 *   the window fails, and one that sees a later expiry moves it.
 * - A provider opens with the CA bundle and proxy the settings hold then,
 *   and keeps them while it is open: a settings change reopens nothing.
 *   CheckAgain opens it again if they have changed, as it does from
 *   Unavailable.
 *
 * A provider call runs in a fiber of the session's scope, so closing the
 * session stops it, one at a time for each block. It moves the block only
 * if no action has come since it started; an action stops the block's
 * running call first.
 */
import path from "node:path"
import type { Duration } from "effect"
import {
  Cause,
  Clock,
  DateTime,
  Effect,
  Exit,
  Fiber,
  Latch,
  Option,
  Redacted,
  Scope,
  Stream,
} from "effect"
import {
  type BlockId,
  type CredentialBlock,
  CredentialError,
  type CredentialErrorKind,
  type CredentialRequest,
  type OutputDecls,
} from "@runbooks/blocks-core/contract"
import {
  confirmsDetected,
  type CredentialAction,
  EXPIRY_WARNING_MILLIS,
  type CredentialState,
  type CredentialStateTag,
  type MethodView,
  TRANSITIONS,
} from "../credential/lifecycle.ts"
import type {
  Constraints,
  CredentialEnv,
  CredentialProvider,
  Identity,
  Level,
  ProviderConfig,
  ProviderInfo,
  ResolvedSource,
  Target,
} from "../credential/provider.ts"
import type { CredentialStore } from "./credentialStore.ts"
import type { CredentialHandle } from "./env.ts"
import { type Held, hold, reveal } from "./held.ts"
import type { ActResult, EngineEvent } from "./protocol.ts"

/** How long the engine waits on one provider call that is not a sign-in. */
const PROVIDER_CALL_TIMEOUT: Duration.Input = "60 seconds"
/** How long a sign-in may wait on the person: a device code lives about 10 minutes. */
const SIGN_IN_TIMEOUT: Duration.Input = "15 minutes"
/**
 * The longest an expiry watch sleeps before it reads the clock again.
 * Timers stop while the machine sleeps, so a watch that slept until the
 * warning window in one go would show Ready past expiry after a wake-up.
 */
const EXPIRY_CHECK_MILLIS = 60_000

/** A credential block with no configuration errors, and the request its props make. */
export interface CredentialSlot {
  readonly index: number
  readonly id: BlockId
  readonly block: CredentialBlock<unknown>
  readonly request: CredentialRequest
  /** The outputs the block declares, from its props. */
  readonly outputs: OutputDecls<string>
}

/** The settings a provider opens with that are the machine's, not the block's. */
export type ProviderNetwork = Pick<ProviderConfig, "caBundleFile" | "proxy">

const sameNetwork = (a: ProviderNetwork, b: ProviderNetwork): boolean =>
  Option.getOrNull(a.caBundleFile) === Option.getOrNull(b.caBundleFile) &&
  Option.getOrNull(a.proxy) === Option.getOrNull(b.proxy)

/** Opens a block's provider by its registry name: the trusted session's runner does it. */
export type OpenProvider = (
  provider: string,
  config: ProviderConfig,
) => Effect.Effect<CredentialProvider, CredentialError, Scope.Scope>

/** What the credential blocks need from their session. */
export interface CredentialHost {
  /** The session's one mutation path: applies `change` and logs what it emits, in one step. */
  readonly update: <A>(change: (emit: (event: EngineEvent) => void) => A) => Effect.Effect<A>
  /** A done block's outputs, for an `outputs` detection source. */
  readonly outputsOf: (block: BlockId) => ReadonlyMap<string, Held<string>> | undefined
  /** Holds each block's provider and calls; closing it, when the session closes, ends them. */
  readonly scope: Scope.Scope
  /** The session's folder of provider state: each block's provider keeps its files in `<it>/<block>`. */
  readonly stateFolder: string
  readonly store: CredentialStore
  /** The CA bundle and proxy the settings hold now. */
  readonly network: Effect.Effect<ProviderNetwork>
}

/** A sign-in method's fields as a client sends them: every one redacted. */
type Fields = { readonly [name: string]: Redacted.Redacted<string> }

type Ready = Extract<CredentialState, { readonly _tag: "Ready" }>
type SigningIn = Extract<CredentialState, { readonly _tag: "SigningIn" }>
type ChoosingTarget = Extract<CredentialState, { readonly _tag: "ChoosingTarget" }>

/**
 * A move to a state. One to Ready carries the values the block's provider
 * gave for it, which the store takes; one to ChoosingTarget, what choosing
 * goes on to, which no view shows.
 */
type Move =
  | (Ready & { readonly env: CredentialEnv })
  | (ChoosingTarget & { readonly toward: Choosing })
  | Exclude<CredentialState, Ready | ChoosingTarget>

interface Opened {
  readonly provider: CredentialProvider
  readonly info: ProviderInfo
  readonly methods: ReadonlyArray<MethodView>
  /** Holds the provider; closing it closes the provider and signs nothing out. */
  readonly scope: Scope.Closeable
  /** What it was opened with. */
  readonly network: ProviderNetwork
}

/** What a ChoosingTarget is on its way to: a sign-in held until the levels before it are chosen, or Ready. */
type Choosing =
  | { readonly _tag: "SignIn"; readonly method: string; readonly fields: Fields }
  | { readonly _tag: "Accept"; readonly source: string }

interface Credential {
  readonly slot: CredentialSlot
  /** None until its lifecycle starts. */
  state: CredentialState | undefined
  opened: Option.Option<Opened>
  /** The provider call running for it, if any. */
  call: Fiber.Fiber<void> | undefined
  /** Bumped by each action. A call records its result only if no action came after it started. */
  turn: number
  /** What the ChoosingTarget the block is in goes on to. */
  choosing: Option.Option<Choosing>
  /** Opened by the block's next move, so a watch waiting on its expiry looks again. */
  moved: Latch.Latch
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

/** The sign-in methods as the view draws them: the block's defaults filled in, never a secret field's. */
const methodViews = (info: ProviderInfo, request: CredentialRequest): ReadonlyArray<MethodView> =>
  info.methods.map((method) => {
    const shown = new Set(method.fields.filter((field) => !field.secret).map((field) => field.name))
    const given = Object.hasOwn(request.methodDefaults, method.name)
      ? request.methodDefaults[method.name]
      : undefined
    return {
      ...method,
      defaults: Object.fromEntries(Object.entries(given ?? {}).filter(([name]) => shown.has(name))),
    }
  })

/** A sign-in's fields: the method's defaults as the view shows them, then what the client sent. */
const signInFields = (method: MethodView, given: Fields): Fields => ({
  ...Object.fromEntries(
    Object.entries(method.defaults).map(([name, value]) => [name, Redacted.make(value)]),
  ),
  ...given,
})

/** The methods a sign-in may use: every one its provider does not mark unavailable. */
const available = (methods: ReadonlyArray<MethodView>): ReadonlyArray<MethodView> =>
  methods.filter((method) => method.unavailable === undefined)

/** A sign-in that has shown nothing yet. */
const signingIn = (method: string): SigningIn => ({ _tag: "SigningIn", method, waiting: false })

/** Whether an error means the provider cannot serve the block at all, so trying again needs it reopened. */
function isUnavailable(kind: CredentialErrorKind): boolean {
  switch (kind) {
    case "notConfigured":
    case "unsupportedProtocolVersion":
    case "toolMissing":
    case "providerFailed":
      return true
    case "invalidParams":
    case "notSignedIn":
    case "expired":
    case "pinMismatch":
    case "requirementNotMet":
    case "accessDenied":
    case "cancelled":
    case "timedOut":
    case "network":
    case "tlsError":
    case "internal":
    case "unknown":
      return false
  }
}

/** The pinned levels whose target, in `identity`, is not the pin. */
const unmetPins = (pins: CredentialRequest["pins"], identity: Identity) =>
  Object.entries(pins).filter(([level, pin]) => identity.targets[level]?.id !== pin)

const pinMismatch = (unmet: ReadonlyArray<readonly [string, string]>, identity: Identity) =>
  new CredentialError({
    kind: "pinMismatch",
    message: unmet
      .map(
        ([level, pin]) =>
          `The block pins ${level} ${pin}; ${identity.principal} is at ${identity.targets[level]?.id ?? "no " + level}.`,
      )
      .join(" "),
  })

/** The target chosen at each level, by level name: null where an optional level has none. */
type Chosen = Readonly<Record<string, Target | null>>

/** A level's target id: null for none, undefined for a level not chosen. */
const idOf = (target: Target | null | undefined): string | null | undefined =>
  target === null ? null : target?.id

const idsOf = (chosen: Chosen): Record<string, string | null> =>
  Object.fromEntries(
    Object.entries(chosen).map(([level, target]) => [level, target === null ? null : target.id]),
  )

/** The levels chosen before sign-in, as the sign-in's pins. A level with no target pins nothing. */
const pinsOf = (chosen: Chosen): Record<string, string> =>
  Object.fromEntries(
    Object.entries(chosen).flatMap(([level, target]) =>
      target === null ? [] : [[level, target.id] as const],
    ),
  )

/**
 * The id chosen or pinned at the level before `level`, whose targets
 * `level`'s are listed under. A level after one with no target has no parent.
 */
function parentOf(
  levels: ReadonlyArray<Level>,
  level: Level,
  chosen: Chosen,
  pins: CredentialRequest["pins"],
): Option.Option<string> {
  const before = levels[levels.indexOf(level) - 1]
  if (before === undefined) return Option.none()
  const target = chosen[before.name]
  if (target === null) return Option.none()
  return Option.fromUndefinedOr(target?.id ?? pins[before.name])
}

/** The first level chosen at `when` that is neither chosen yet nor pinned. */
const nextLevel = (
  levels: ReadonlyArray<Level>,
  when: Level["chosen"],
  chosen: Chosen,
  pins: CredentialRequest["pins"],
): Level | undefined =>
  levels.find(
    (level) =>
      level.chosen === when &&
      !Object.hasOwn(chosen, level.name) &&
      !Object.hasOwn(pins, level.name),
  )

/**
 * The states that take each action. An action's fields are checked after,
 * against what the state offers. CheckAgain also needs detection sources,
 * except from Unavailable, where it opens the provider again. It opens it
 * again from any state that takes it when the CA bundle or proxy changed.
 */
const TAKEN_IN: {
  readonly [A in CredentialAction["_tag"]]: ReadonlyArray<CredentialStateTag>
} = {
  Confirm: ["Found"],
  Decline: ["Found"],
  SignIn: ["SignedOut", "RequirementNotMet", "Expired"],
  Cancel: ["SigningIn", "ChoosingTarget"],
  ChooseTarget: ["ChoosingTarget", "Ready"],
  CheckAgain: ["SignedOut", "RequirementNotMet", "Expired", "Unavailable"],
  SignOut: ["RequirementNotMet", "Ready", "Expired"],
}

const ACTIONS = Object.keys(TAKEN_IN) as ReadonlyArray<CredentialAction["_tag"]>

function takes(
  state: CredentialState,
  action: CredentialAction["_tag"],
  request: CredentialRequest,
) {
  if (!TAKEN_IN[action].includes(state._tag)) return false
  return action !== "CheckAgain" || state._tag === "Unavailable" || request.detect.length > 0
}

/** The error a call that stopped with `cause` ended with: a defect is the provider's failure. */
function errorOf(cause: Cause.Cause<CredentialError>): CredentialError {
  const error = Cause.findErrorOption(cause)
  if (Option.isSome(error)) return error.value
  const defect = Cause.squash(cause)
  return new CredentialError({
    kind: "providerFailed",
    message: `The credential provider stopped with an unexpected error: ${defect instanceof Error ? defect.message : String(defect)}`,
  })
}

const bounded = <A, R>(
  call: Effect.Effect<A, CredentialError, R>,
  within: Duration.Input = PROVIDER_CALL_TIMEOUT,
) =>
  call.pipe(
    Effect.timeoutOrElse({
      duration: within,
      orElse: () =>
        Effect.fail(
          new CredentialError({
            kind: "timedOut",
            message: "The credential provider did not answer.",
          }),
        ),
    }),
  )

/** When a credential expires: its values' expiry, or its identity's when they give none. */
const expiryOf = (identity: Identity, env: CredentialEnv): Option.Option<DateTime.Utc> =>
  Option.orElse(env.expiresAt, () => Option.fromUndefinedOr(identity.expiresAt))

/** Whether a credential that expires at `expiry` is within the warning window at `now`, or past it. */
const isExpiring = (expiry: Option.Option<DateTime.Utc>, now: number): boolean =>
  Option.isSome(expiry) && DateTime.toEpochMillis(expiry.value) - now <= EXPIRY_WARNING_MILLIS

/** The identity, showing when the credential expires. */
const withExpiry = (identity: Identity, expiry: Option.Option<DateTime.Utc>): Identity =>
  Option.match(expiry, {
    onNone: () => identity,
    onSome: (expiresAt) => ({ ...identity, expiresAt }),
  })

const sameExpiry = (a: Identity, b: Identity): boolean =>
  a.expiresAt === undefined || b.expiresAt === undefined
    ? a.expiresAt === b.expiresAt
    : DateTime.toEpochMillis(a.expiresAt) === DateTime.toEpochMillis(b.expiresAt)

const expiringError = (block: BlockId) =>
  new CredentialError({
    kind: "expired",
    message: `${block}'s credential expires within ${EXPIRY_WARNING_MILLIS / 60_000} minutes, so it was not used.`,
  })

// ---------------------------------------------------------------------------
// The blocks
// ---------------------------------------------------------------------------

export interface Credentials {
  /** The block's state, or none until its lifecycle starts. */
  readonly stateOf: (index: number) => CredentialState | undefined
  /**
   * Starts, at Detecting, the lifecycle of each block `startable` allows that
   * has none yet, in the caller's step. `begin` then opens their providers.
   */
  readonly enter: (
    startable: (index: number) => boolean,
    emit: (event: EngineEvent) => void,
  ) => ReadonlyArray<number>
  readonly begin: (started: ReadonlyArray<number>, open: OpenProvider) => Effect.Effect<void>
  /** Takes an action from a client. Holds the session lock: a sign-out waits for the provider. */
  readonly act: (
    index: number,
    action: CredentialAction,
    open: OpenProvider,
  ) => Effect.Effect<ActResult>
  /** Whether the block takes any action now. */
  readonly acts: (index: number) => boolean
  /** What a run that names the block in `envFrom` gets its variables through. */
  readonly handle: (index: number) => CredentialHandle
  /** The block's outputs, from the values its provider gave, while it is Ready. */
  readonly outputs: (index: number) => ReadonlyMap<string, Held<string>> | undefined
}

export function makeCredentials(
  slots: ReadonlyArray<CredentialSlot>,
  host: CredentialHost,
): Credentials {
  const credentials = new Map<number, Credential>(
    slots.map((slot) => [
      slot.index,
      {
        slot,
        state: undefined,
        opened: Option.none(),
        call: undefined,
        turn: 0,
        choosing: Option.none(),
        moved: Latch.makeUnsafe(false),
      },
    ]),
  )
  const at = (index: number): Credential => {
    const credential = credentials.get(index)
    // The session asks only of the blocks it made a slot for.
    if (credential === undefined) throw new Error(`Block ${index} is not a credential block.`)
    return credential
  }

  /** The one place a block's state changes. */
  const move = (credential: Credential, next: Move, emit: (event: EngineEvent) => void) => {
    const from = credential.state
    const allowed =
      from === undefined ? next._tag === "Detecting" : TRANSITIONS[from._tag].includes(next._tag)
    if (!allowed)
      throw new Error(
        `${credential.slot.id} cannot move from ${from?._tag ?? "no state"} to ${next._tag}.`,
      )
    let state: CredentialState
    credential.choosing = Option.none()
    host.store.delete(credential.slot.id)
    if (next._tag === "Ready") {
      const { env, ...ready } = next
      host.store.set(credential.slot.id, env)
      state = ready
    } else if (next._tag === "ChoosingTarget") {
      const { toward, ...choosing } = next
      credential.choosing = Option.some(toward)
      state = choosing
    } else state = next
    credential.state = state
    credential.moved.openUnsafe()
    emit({ _tag: "CredentialChanged", block: credential.slot.id, state })
  }

  /** Moves the block if no action came since `turn`. */
  const record = (credential: Credential, turn: number, next: Move) =>
    host.update((emit) => {
      if (credential.turn === turn) move(credential, next, emit)
    })

  /** The sign-in methods, the block's default if it is one available, and why the last attempt failed. */
  const signedOut = (credential: Credential, opened: Opened, lastError?: CredentialError): Move => {
    const preferred = Option.filter(credential.slot.request.defaultMethod, (name) =>
      available(opened.methods).some((method) => method.name === name),
    )
    return {
      _tag: "SignedOut",
      methods: opened.methods,
      ...Option.match(preferred, {
        onNone: () => ({}),
        onSome: (defaultMethod) => ({ defaultMethod }),
      }),
      ...(lastError === undefined ? {} : { lastError }),
    }
  }

  /** Where an error from a call made in the block's state leaves it. */
  const afterError = (credential: Credential, error: CredentialError): Move => {
    const { state, opened } = credential
    const allowed = TRANSITIONS[state?._tag ?? "Detecting"]
    if (Option.isNone(opened) || (isUnavailable(error.kind) && allowed.includes("Unavailable")))
      return { _tag: "Unavailable", error }
    if (error.kind === "requirementNotMet" && allowed.includes("RequirementNotMet")) {
      const identity = state?._tag === "ChoosingTarget" ? state.identity : undefined
      return {
        _tag: "RequirementNotMet",
        unmet: error.unmet ?? [],
        ...(identity === undefined ? {} : { identity }),
      }
    }
    return signedOut(credential, opened.value, error)
  }

  /**
   * Runs `call` for the block in a fiber of the session's scope, and moves
   * the block to the state it ends in, or the one its error leaves it in,
   * if no action came since it started. A stopped call moves nothing. A
   * call that ends Ready goes on to `watch` its expiry.
   */
  const start = (
    credential: Credential,
    call: (turn: number) => Effect.Effect<Move, CredentialError>,
  ) =>
    Effect.gen(function* () {
      const turn = credential.turn
      const ended = call(turn).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : Effect.sync(() => afterError(credential, errorOf(cause))),
        ),
        Effect.flatMap((next) => record(credential, turn, next)),
        Effect.andThen(watch(credential, turn)),
      )
      credential.call = yield* Effect.forkIn(ended, host.scope, { startImmediately: true })
    })

  /** Stops the block's running call, and waits for it to end. */
  const stop = (credential: Credential) =>
    Effect.suspend(() => {
      credential.turn += 1
      const call = credential.call
      credential.call = undefined
      return call === undefined ? Effect.void : Fiber.interrupt(call)
    })

  const openFor = (credential: Credential, open: OpenProvider) =>
    Option.match(credential.opened, {
      onSome: (opened) => Effect.succeed(opened),
      onNone: () =>
        Effect.gen(function* () {
          const scope = yield* Scope.fork(host.scope)
          const { block, request, id } = credential.slot
          const network = yield* host.network
          const config: ProviderConfig = {
            stateDir: path.join(host.stateFolder, id),
            ...network,
            settings: request.settings,
          }
          const provider = yield* Scope.provide(bounded(open(block.provider, config)), scope).pipe(
            Effect.onError(() => Scope.close(scope, Exit.void)),
          )
          const info = yield* bounded(provider.describe).pipe(
            Effect.onError(() => Scope.close(scope, Exit.void)),
          )
          const opened: Opened = {
            provider,
            info,
            methods: methodViews(info, request),
            scope,
            network,
          }
          credential.opened = Option.some(opened)
          return opened
        }),
    })

  /** The detection sources, an `outputs` one read now from the block it names. */
  const resolve = (request: CredentialRequest): ReadonlyArray<ResolvedSource> =>
    request.detect.map((source): ResolvedSource => {
      switch (source.kind) {
        case "env":
        case "named":
          return source
        case "outputs": {
          const outputs = host.outputsOf(source.from) ?? new Map<string, Held<string>>()
          return {
            kind: "values",
            from: source.from,
            values: Object.fromEntries(
              Array.from(outputs, ([key, held]) => [key, Redacted.make(reveal(held))]),
            ),
          }
        }
      }
    })

  const constraintsOf = (request: CredentialRequest): Constraints => ({
    pins: request.pins,
    requirements: request.requirements,
  })

  /**
   * Takes an identity the block may use, with the targets chosen so far:
   * selects each pinned level after sign-in they do not name, and stops to
   * choose one that is neither chosen nor pinned; checks the pins; then gets
   * the values a run will have, and is Ready. No target counts as a choice
   * only at an optional level: a provider's null anywhere else is not chosen.
   */
  const accept = (
    credential: Credential,
    opened: Opened,
    identity: Identity,
    source: string,
    chosen: Chosen = identity.targets,
  ): Effect.Effect<Move, CredentialError> =>
    Effect.gen(function* () {
      const { pins } = credential.slot.request
      const { levels } = opened.info
      const optional = new Set(
        levels.flatMap((level) => (level.optional === true ? [level.name] : [])),
      )
      const picked: Record<string, Target | null> = Object.fromEntries(
        Object.entries(chosen).filter(([name, target]) => target !== null || optional.has(name)),
      )
      for (const level of levels) {
        const pin = pins[level.name]
        if (
          level.chosen === "afterSignIn" &&
          !Object.hasOwn(picked, level.name) &&
          pin !== undefined
        )
          picked[level.name] = { id: pin, name: pin }
      }
      const level = nextLevel(levels, "afterSignIn", picked, pins)
      if (level !== undefined) {
        const options = yield* bounded(
          opened.provider.targets(level.name, parentOf(levels, level, picked, pins)),
        )
        return {
          _tag: "ChoosingTarget",
          level,
          options,
          chosen: picked,
          identity,
          toward: { _tag: "Accept", source },
        }
      }
      const changed = Object.entries(picked).some(
        ([name, target]) => idOf(identity.targets[name]) !== idOf(target),
      )
      const selected = changed ? yield* bounded(opened.provider.select(idsOf(picked))) : identity
      const unmet = unmetPins(pins, selected)
      if (unmet.length > 0) return signedOut(credential, opened, pinMismatch(unmet, selected))
      const env = yield* bounded(opened.provider.env)
      const expiry = expiryOf(selected, env)
      if (isExpiring(expiry, yield* Clock.currentTimeMillis))
        return signedOut(credential, opened, expiringError(credential.slot.id))
      return { _tag: "Ready", identity: withExpiry(selected, expiry), source, env }
    })

  /**
   * While the block is Ready with an expiry and no action has come since
   * `turn`: waits for the warning window, reading the clock at least every
   * `EXPIRY_CHECK_MILLIS`, then refreshes through `env`. A later expiry is
   * Ready again, and the watch goes on; otherwise, or if the provider cannot
   * refresh, the block is Expired. A move wakes it at once, so a run's
   * refresh that moves the expiry moves the wake-up with it.
   */
  const watch = (credential: Credential, turn: number): Effect.Effect<void> =>
    Effect.gen(function* () {
      while (credential.turn === turn) {
        // Made in the same step as the state is read, so no move falls between.
        const nextMove = Latch.makeUnsafe(false)
        credential.moved = nextMove
        const { state, opened } = credential
        if (state?._tag !== "Ready" || Option.isNone(opened)) return
        const expiry = Option.fromUndefinedOr(state.identity.expiresAt)
        if (Option.isNone(expiry)) return
        const wake = DateTime.toEpochMillis(expiry.value) - EXPIRY_WARNING_MILLIS
        const now = yield* Clock.currentTimeMillis
        if (now < wake) {
          yield* Effect.race(
            Effect.sleep(Math.min(wake - now, EXPIRY_CHECK_MILLIS)),
            nextMove.await,
          )
          continue
        }
        const refreshed = yield* Effect.option(bounded(opened.value.provider.env))
        const answered = yield* Clock.currentTimeMillis
        const next = Option.filter(
          refreshed,
          (env) => !isExpiring(expiryOf(state.identity, env), answered),
        )
        const moved: Move = Option.match(next, {
          onNone: () => ({ _tag: "Expired", identity: state.identity }),
          onSome: (env) => ({
            _tag: "Ready",
            identity: withExpiry(state.identity, expiryOf(state.identity, env)),
            source: state.source,
            env,
          }),
        })
        // A run may have moved the block meanwhile; then the watch looks again.
        yield* host.update((emit) => {
          if (credential.turn === turn && credential.state === state) move(credential, moved, emit)
        })
      }
    })

  const detect = (credential: Credential, open: OpenProvider) =>
    start(credential, () =>
      Effect.gen(function* () {
        const opened = yield* openFor(credential, open)
        const { request } = credential.slot
        if (request.detect.length === 0) return signedOut(credential, opened)
        const found = yield* bounded(
          opened.provider.detect(resolve(request), constraintsOf(request)),
        )
        if (Option.isNone(found)) return signedOut(credential, opened)
        const { identity, source } = found.value
        if (confirmsDetected(request)) return { _tag: "Found", identity, source }
        return yield* accept(credential, opened, identity, source)
      }),
    )

  /**
   * Signs in: first chooses each level chosen before sign-in that is not
   * pinned, holding the method and fields; then runs the provider's sign-in,
   * showing each prompt, and takes the identity it ends with.
   */
  const signIn = (
    credential: Credential,
    opened: Opened,
    method: string,
    fields: Fields,
    chosen: Chosen,
  ) =>
    start(credential, (turn) =>
      Effect.gen(function* () {
        const { pins, requirements } = credential.slot.request
        const { levels } = opened.info
        const level = nextLevel(levels, "beforeSignIn", chosen, pins)
        if (level !== undefined) {
          const options = yield* bounded(
            opened.provider.targets(level.name, parentOf(levels, level, chosen, pins)),
          )
          return {
            _tag: "ChoosingTarget",
            level,
            options,
            chosen,
            toward: { _tag: "SignIn", method, fields },
          } satisfies Move
        }
        let identity: Identity | undefined
        let shown = signingIn(method)
        /** Shows a prompt on top of what the earlier ones showed. */
        const show = (prompt: Partial<Omit<SigningIn, "_tag" | "method">>) => {
          shown = { ...shown, ...prompt }
          return record(credential, turn, shown)
        }
        yield* bounded(
          Stream.runForEach(
            opened.provider.signIn(method, fields, {
              pins: { ...pins, ...pinsOf(chosen) },
              requirements,
            }),
            (event) => {
              switch (event._tag) {
                case "SignedIn":
                  identity = event.identity
                  return Effect.void
                case "OpenUrl":
                  return show({
                    url: event.url,
                    ...Option.match(event.code, {
                      onNone: () => ({}),
                      onSome: (code) => ({ code }),
                    }),
                  })
                case "ShowCode":
                  return show({ code: event.code })
                case "Waiting":
                  return show({ waiting: true })
              }
            },
          ),
          SIGN_IN_TIMEOUT,
        )
        if (identity === undefined)
          return yield* new CredentialError({
            kind: "providerFailed",
            message: "The provider ended the sign-in without signing in.",
          })
        return yield* accept(credential, opened, identity, method)
      }),
    )

  /** Drops what the provider holds for the block, then moves it to SignedOut. */
  const signOut = (credential: Credential, opened: Opened, why: CredentialError | undefined) =>
    Effect.gen(function* () {
      yield* stop(credential)
      const failed = yield* bounded(opened.provider.signOut).pipe(
        Effect.match({ onSuccess: () => undefined, onFailure: (error) => error }),
      )
      yield* host.update((emit) =>
        move(credential, signedOut(credential, opened, failed ?? why), emit),
      )
    })

  const notOffered = (
    field: Extract<ActResult, { _tag: "NotOffered" }>["field"],
    value: string | null,
    offered: ReadonlyArray<string>,
  ): ActResult => ({ _tag: "NotOffered", field, value, offered })

  const accepted: ActResult = { _tag: "Accepted" }

  /**
   * Chooses the target offered at the level being chosen, or none at an
   * optional level, then goes on to the next level, a sign-in or Ready.
   */
  const chooseOffered = (
    credential: Credential,
    opened: Opened,
    state: ChoosingTarget,
    level: string,
    id: string | null,
  ) =>
    Effect.gen(function* () {
      if (level !== state.level.name) return notOffered("level", level, [state.level.name])
      const offered = state.options.map((candidate) => candidate.id)
      if (id === null && state.level.optional !== true) return notOffered("id", id, offered)
      const option = id === null ? null : state.options.find((candidate) => candidate.id === id)
      if (option === undefined) return notOffered("id", id, offered)
      const chosen = { ...state.chosen, [level]: option }
      const choosing = credential.choosing
      yield* stop(credential)
      if (Option.isNone(choosing))
        return yield* Effect.die(new Error("A block was choosing a target for nothing."))
      const next = choosing.value
      switch (next._tag) {
        case "SignIn":
          yield* host.update((emit) => move(credential, signingIn(next.method), emit))
          yield* signIn(credential, opened, next.method, next.fields, chosen)
          return accepted
        case "Accept": {
          const { identity } = state
          if (identity === undefined)
            return yield* Effect.die(
              new Error("A block chose a target after sign-in with no identity."),
            )
          yield* start(credential, () => accept(credential, opened, identity, next.source, chosen))
          return accepted
        }
      }
    })

  /** Chooses another target, or none, for a Ready block, at a level after sign-in it does not pin. */
  const changeTarget = (
    credential: Credential,
    opened: Opened,
    state: Ready,
    name: string,
    id: string | null,
  ) =>
    Effect.gen(function* () {
      const { pins } = credential.slot.request
      const { levels } = opened.info
      const changeable = levels.filter(
        (level) => level.chosen === "afterSignIn" && !Object.hasOwn(pins, level.name),
      )
      const level = changeable.find((candidate) => candidate.name === name)
      if (level === undefined)
        return notOffered(
          "level",
          name,
          changeable.map((candidate) => candidate.name),
        )
      if (id === null && level.optional !== true) return notOffered("id", id, [])
      const { identity, source } = state
      const before = Object.fromEntries(
        levels.slice(0, levels.indexOf(level)).flatMap((earlier) => {
          const target = identity.targets[earlier.name]
          return target === undefined ? [] : [[earlier.name, target] as const]
        }),
      )
      yield* stop(credential)
      yield* start(credential, () =>
        Effect.gen(function* () {
          if (id === null)
            return yield* accept(credential, opened, identity, source, {
              ...before,
              [level.name]: null,
            })
          const options = yield* bounded(
            opened.provider.targets(level.name, parentOf(levels, level, before, pins)),
          )
          const option = options.find((candidate) => candidate.id === id)
          if (option === undefined)
            return {
              _tag: "ChoosingTarget",
              level,
              options,
              chosen: before,
              identity,
              toward: { _tag: "Accept", source },
            } satisfies Move
          return yield* accept(credential, opened, identity, source, {
            ...before,
            [level.name]: option,
          })
        }),
      )
      return accepted
    })

  const checkAgain = (credential: Credential, open: OpenProvider) =>
    Effect.gen(function* () {
      yield* stop(credential)
      const { opened } = credential
      if (
        Option.isSome(opened) &&
        (credential.state?._tag === "Unavailable" ||
          !sameNetwork(opened.value.network, yield* host.network))
      ) {
        yield* Scope.close(opened.value.scope, Exit.void)
        credential.opened = Option.none()
      }
      yield* host.update((emit) => move(credential, { _tag: "Detecting" }, emit))
      yield* detect(credential, open)
      return accepted
    })

  const noLongerReady = (credential: Credential) =>
    new CredentialError({
      kind: "notSignedIn",
      message: `${credential.slot.id} is no longer signed in.`,
    })

  return {
    stateOf: (index) => at(index).state,

    enter: (startable, emit) =>
      slots.flatMap((slot) => {
        const credential = at(slot.index)
        if (credential.state !== undefined || !startable(slot.index)) return []
        move(credential, { _tag: "Detecting" }, emit)
        return [slot.index]
      }),

    begin: (started, open) =>
      Effect.forEach(started, (index) => detect(at(index), open), { discard: true }),

    acts: (index) => {
      const { state, slot } = at(index)
      return state !== undefined && ACTIONS.some((action) => takes(state, action, slot.request))
    },

    act: (index, action, open) =>
      Effect.gen(function* () {
        const credential = at(index)
        const { state, opened } = credential
        if (state === undefined || !takes(state, action._tag, credential.slot.request))
          return { _tag: "NotAllowed", state: state?._tag ?? "Blocked" } as const
        if (action._tag === "CheckAgain") return yield* checkAgain(credential, open)
        // Every state but Unavailable was reached with the provider open, and Unavailable takes CheckAgain alone.
        if (Option.isNone(opened))
          return yield* Effect.die(
            new Error(`${credential.slot.id} has no provider in ${state._tag}.`),
          )
        const provider = opened.value
        switch (action._tag) {
          case "Confirm":
            if (state._tag !== "Found") break
            yield* stop(credential)
            yield* start(credential, () =>
              accept(credential, provider, state.identity, state.source),
            )
            return accepted
          case "Decline":
            yield* stop(credential)
            yield* host.update((emit) => move(credential, signedOut(credential, provider), emit))
            return accepted
          case "SignIn": {
            const offered = available(provider.methods)
            const method = offered.find((candidate) => candidate.name === action.method)
            if (method === undefined)
              return notOffered(
                "method",
                action.method,
                offered.map((candidate) => candidate.name),
              )
            yield* stop(credential)
            yield* host.update((emit) => move(credential, signingIn(method.name), emit))
            yield* signIn(
              credential,
              provider,
              method.name,
              signInFields(method, action.fields),
              {},
            )
            return accepted
          }
          case "ChooseTarget":
            if (state._tag === "ChoosingTarget")
              return yield* chooseOffered(credential, provider, state, action.level, action.id)
            if (state._tag === "Ready")
              return yield* changeTarget(credential, provider, state, action.level, action.id)
            break
          case "Cancel":
            yield* signOut(
              credential,
              provider,
              new CredentialError({ kind: "cancelled", message: "The sign-in was cancelled." }),
            )
            return accepted
          case "SignOut":
            yield* signOut(credential, provider, undefined)
            return accepted
        }
        return yield* Effect.die(
          new Error(`${state._tag} took ${action._tag}, which TAKEN_IN does not list.`),
        )
      }),

    handle: (index) => {
      const credential = at(index)
      return {
        env: Effect.suspend(() => {
          const { state, opened, turn } = credential
          if (state?._tag !== "Ready" || Option.isNone(opened))
            return Effect.fail(noLongerReady(credential))
          return Effect.gen(function* () {
            const env = yield* bounded(opened.value.provider.env)
            const now = yield* Clock.currentTimeMillis
            const given = yield* host.update((emit) => {
              const current = credential.state
              // Signed out, or moved on, while the provider answered.
              if (credential.turn !== turn || current?._tag !== "Ready") return "gone" as const
              const expiry = expiryOf(current.identity, env)
              if (isExpiring(expiry, now)) {
                move(
                  credential,
                  { _tag: "Expired", identity: withExpiry(current.identity, expiry) },
                  emit,
                )
                return "expiring" as const
              }
              const identity = withExpiry(current.identity, expiry)
              if (sameExpiry(identity, current.identity)) host.store.set(credential.slot.id, env)
              else move(credential, { _tag: "Ready", identity, source: current.source, env }, emit)
              return "given" as const
            })
            switch (given) {
              case "gone":
                return yield* noLongerReady(credential)
              case "expiring":
                return yield* expiringError(credential.slot.id)
              case "given":
                return env
            }
          })
        }),
      }
    },

    outputs: (index) => {
      const { slot } = at(index)
      const env = host.store.get(slot.id)
      if (env === undefined) return undefined
      return new Map(
        env.values.flatMap((value) => {
          const decl = Object.hasOwn(slot.outputs, value.name)
            ? slot.outputs[value.name]
            : undefined
          if (decl === undefined || !value.to.includes("output")) return []
          return [
            [
              value.name,
              hold(decl.sensitive || value.sensitive, Redacted.value(value.value)),
            ] as const,
          ]
        }),
      )
    },
  }
}
