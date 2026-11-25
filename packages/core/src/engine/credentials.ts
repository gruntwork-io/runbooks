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
 *
 * A provider call runs in a fiber of the session's scope, so closing the
 * session stops it, one at a time for each block. It moves the block only
 * if no action has come since it started; an action stops the block's
 * running call first.
 */
import path from "node:path"
import type { Duration } from "effect"
import { Cause, Effect, Exit, Fiber, Option, Redacted, Scope, Stream } from "effect"
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

/** A credential block with no configuration errors, and the request its props make. */
export interface CredentialSlot {
  readonly index: number
  readonly id: BlockId
  readonly block: CredentialBlock<unknown>
  readonly request: CredentialRequest
  /** The outputs the block declares, from its props. */
  readonly outputs: OutputDecls<string>
}

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
}

/** A sign-in method's fields as a client sends them: every one redacted. */
type Fields = { readonly [name: string]: Redacted.Redacted<string> }

type Ready = Extract<CredentialState, { readonly _tag: "Ready" }>
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

const idsOf = (chosen: Readonly<Record<string, Target>>): Record<string, string> =>
  Object.fromEntries(Object.entries(chosen).map(([level, target]) => [level, target.id]))

/** The id chosen or pinned at the level before `level`, whose targets `level`'s are listed under. */
function parentOf(
  levels: ReadonlyArray<Level>,
  level: Level,
  chosen: Readonly<Record<string, Target>>,
  pins: CredentialRequest["pins"],
): Option.Option<string> {
  const before = levels[levels.indexOf(level) - 1]
  if (before === undefined) return Option.none()
  return Option.fromUndefinedOr(chosen[before.name]?.id ?? pins[before.name])
}

/** The first level chosen at `when` that is neither chosen yet nor pinned. */
const nextLevel = (
  levels: ReadonlyArray<Level>,
  when: Level["chosen"],
  chosen: Readonly<Record<string, Target>>,
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
 * except from Unavailable, where it opens the provider again.
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
    emit({ _tag: "CredentialChanged", block: credential.slot.id, state })
  }

  /** Moves the block if no action came since `turn`. */
  const record = (credential: Credential, turn: number, next: Move) =>
    host.update((emit) => {
      if (credential.turn === turn) move(credential, next, emit)
    })

  /** The sign-in methods, the block's default first if its provider describes it, and why the last attempt failed. */
  const signedOut = (credential: Credential, opened: Opened, lastError?: CredentialError): Move => {
    const preferred = Option.filter(credential.slot.request.defaultMethod, (name) =>
      opened.methods.some((method) => method.name === name),
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
   * if no action came since it started. A stopped call moves nothing.
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
          const config: ProviderConfig = {
            stateDir: path.join(host.stateFolder, id),
            // The settings store (2.7) gives the CA bundle and proxy; until then a provider gets neither.
            caBundleFile: Option.none(),
            proxy: Option.none(),
            settings: request.settings,
          }
          const provider = yield* Scope.provide(bounded(open(block.provider, config)), scope).pipe(
            Effect.onError(() => Scope.close(scope, Exit.void)),
          )
          const info = yield* bounded(provider.describe).pipe(
            Effect.onError(() => Scope.close(scope, Exit.void)),
          )
          const opened: Opened = { provider, info, methods: methodViews(info, request), scope }
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
   * the values a run will have, and is Ready.
   */
  const accept = (
    credential: Credential,
    opened: Opened,
    identity: Identity,
    source: string,
    chosen: Readonly<Record<string, Target>> = identity.targets,
  ): Effect.Effect<Move, CredentialError> =>
    Effect.gen(function* () {
      const { pins } = credential.slot.request
      const { levels } = opened.info
      const picked: Record<string, Target> = { ...chosen }
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
        ([name, target]) => identity.targets[name]?.id !== target.id,
      )
      const selected = changed ? yield* bounded(opened.provider.select(idsOf(picked))) : identity
      const unmet = unmetPins(pins, selected)
      if (unmet.length > 0) return signedOut(credential, opened, pinMismatch(unmet, selected))
      const env = yield* bounded(opened.provider.env)
      return { _tag: "Ready", identity: selected, source, env }
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
    chosen: Readonly<Record<string, Target>>,
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
        const prompt = (next: Extract<Move, { _tag: "SigningIn" }>["prompt"]) =>
          record(credential, turn, {
            _tag: "SigningIn",
            method,
            ...(next === undefined ? {} : { prompt: next }),
          })
        yield* bounded(
          Stream.runForEach(
            opened.provider.signIn(method, fields, {
              pins: { ...pins, ...idsOf(chosen) },
              requirements,
            }),
            (event) => {
              switch (event._tag) {
                case "SignedIn":
                  identity = event.identity
                  return Effect.void
                case "OpenUrl":
                  return prompt({
                    _tag: "OpenUrl",
                    url: event.url,
                    ...Option.match(event.code, {
                      onNone: () => ({}),
                      onSome: (code) => ({ code }),
                    }),
                  })
                case "ShowCode":
                  return prompt({ _tag: "ShowCode", code: event.code })
                case "Waiting":
                  return prompt({ _tag: "Waiting" })
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
    value: string,
    offered: ReadonlyArray<string>,
  ): ActResult => ({ _tag: "NotOffered", field, value, offered })

  const accepted: ActResult = { _tag: "Accepted" }

  /** Chooses the target offered at the level being chosen, then goes on to the next level, a sign-in or Ready. */
  const chooseOffered = (
    credential: Credential,
    opened: Opened,
    state: ChoosingTarget,
    level: string,
    id: string,
  ) =>
    Effect.gen(function* () {
      if (level !== state.level.name) return notOffered("level", level, [state.level.name])
      const option = state.options.find((candidate) => candidate.id === id)
      if (option === undefined)
        return notOffered(
          "id",
          id,
          state.options.map((candidate) => candidate.id),
        )
      const chosen = { ...state.chosen, [level]: option }
      const choosing = credential.choosing
      yield* stop(credential)
      if (Option.isNone(choosing))
        return yield* Effect.die(new Error("A block was choosing a target for nothing."))
      const next = choosing.value
      switch (next._tag) {
        case "SignIn":
          yield* host.update((emit) =>
            move(credential, { _tag: "SigningIn", method: next.method }, emit),
          )
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

  /** Chooses another target for a Ready block, at a level after sign-in it does not pin. */
  const changeTarget = (
    credential: Credential,
    opened: Opened,
    state: Ready,
    name: string,
    id: string,
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
      if (credential.state?._tag === "Unavailable" && Option.isSome(credential.opened)) {
        yield* Scope.close(credential.opened.value.scope, Exit.void)
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
            const method = provider.methods.find((candidate) => candidate.name === action.method)
            if (method === undefined)
              return notOffered(
                "method",
                action.method,
                provider.methods.map((candidate) => candidate.name),
              )
            yield* stop(credential)
            yield* host.update((emit) =>
              move(credential, { _tag: "SigningIn", method: method.name }, emit),
            )
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
          return bounded(opened.value.provider.env).pipe(
            Effect.flatMap((env) =>
              host
                .update(() => {
                  // Signed out, or moved on, while the provider answered.
                  if (credential.turn !== turn || credential.state?._tag !== "Ready") return false
                  host.store.set(credential.slot.id, env)
                  return true
                })
                .pipe(
                  Effect.flatMap((current) =>
                    current ? Effect.succeed(env) : Effect.fail(noLongerReady(credential)),
                  ),
                ),
            ),
          )
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
