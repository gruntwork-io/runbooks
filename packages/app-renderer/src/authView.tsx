/**
 * The common auth view: every credential block's default view, drawn from
 * the lifecycle state the engine sends (`BlockView.credential`). The tabs
 * and fields are the provider's sign-in methods, from its `describe`
 * answer; the pickers are the targets the engine offers at one level; the
 * card is the `Identity`. Each button sends the action the state takes
 * (`ActOnCredential`), and the engine moves the block.
 *
 * The tab the person chose, and what they typed into each tab's fields but
 * a secret, stay while the block is drawn. A sign-in that fails, is
 * cancelled, or expires and is signed out comes back to SignedOut, which
 * draws the tabs anew from them. The engine's `defaultMethod` is the tab
 * until the person chooses one, or once a SignedOut no longer offers theirs.
 *
 * Secrets travel one way. A secret field is a password input the page
 * holds nothing of: its value goes into the sign-in action as a Redacted,
 * and the field is emptied once the action is sent. Nothing keeps what is
 * typed into it. No state the engine sends holds a secret, so nothing here
 * shows one.
 *
 * A provider adds a view of its own only for what this one cannot draw.
 */
import { DateTime, Redacted } from "effect"
import { type FormEvent, Fragment, useId, useState } from "react"
import type { ViewRequest } from "@runbooks/blocks/views"
import type { BlockView } from "@runbooks/core/protocol"
import { BlockLink } from "./blockLink.tsx"
import { linkTarget } from "./markdown.tsx"

type State = NonNullable<BlockView["credential"]>
type Identity = Extract<State, { readonly _tag: "Ready" }>["identity"]
type Method = Extract<State, { readonly _tag: "SignedOut" }>["methods"][number]
type Action = Extract<ViewRequest, { readonly _tag: "ActOnCredential" }>["action"]
/** The text the person typed or picked in each method's fields, by method, then field. */
type Typed = ReadonlyMap<string, ReadonlyMap<string, string>>

export function AuthView({
  state,
  act,
  block,
  onPage,
}: {
  readonly state: State | undefined
  readonly act: (request: ViewRequest) => void
  /** The block's own id. */
  readonly block: string | undefined
  /** The ids of the blocks on the page, which a link to one scrolls to. */
  readonly onPage: ReadonlySet<string>
}) {
  const [chosen, choose] = useState<string>()
  const [typed, setTyped] = useState<Typed>(() => new Map())
  const keep = (method: string, field: string, text: string) =>
    setTyped((before) => new Map(before).set(method, new Map(before.get(method)).set(field, text)))
  const send = (action: Action) => act({ _tag: "ActOnCredential", action })
  if (state === undefined) return null
  switch (state._tag) {
    case "Detecting":
      return <p className="block-status">Looking for a login.</p>
    case "Found":
      return (
        <>
          <p className="block-status">
            <FoundIn source={state.source} block={block} onPage={onPage} /> Use it?
          </p>
          <IdentityCard identity={state.identity} />
          <Buttons
            buttons={[
              ["Use this login", { _tag: "Confirm" }],
              ["Sign in another way", { _tag: "Decline" }],
            ]}
            send={send}
          />
        </>
      )
    case "SignedOut":
      return (
        <>
          {state.lastError === undefined ? null : (
            <p className="form-error" role="alert">{`Not signed in: ${state.lastError.message}`}</p>
          )}
          <SignIn
            methods={state.methods}
            first={state.defaultMethod}
            chosen={chosen}
            choose={choose}
            typed={typed}
            keep={keep}
            send={send}
          />
          <Buttons buttons={[["Check again", { _tag: "CheckAgain" }]]} send={send} />
        </>
      )
    case "SigningIn":
      return (
        <>
          <p className="block-status">Signing in.</p>
          <Prompt url={state.url} code={state.code} waiting={state.waiting} />
          <Buttons buttons={[["Cancel", { _tag: "Cancel" }]]} send={send} />
        </>
      )
    case "ChoosingTarget":
      return (
        <>
          {state.identity === undefined ? null : <IdentityCard identity={state.identity} />}
          <div role="group" aria-label={`Choose the ${state.level.label}`} className="auth-targets">
            <p className="form-label">{`Choose the ${state.level.label}:`}</p>
            <Buttons
              buttons={[
                ...state.options.map(
                  (target) =>
                    [
                      targetName(target),
                      { _tag: "ChooseTarget", level: state.level.name, id: target.id },
                    ] as const,
                ),
                ...(state.level.optional === true
                  ? [["None", { _tag: "ChooseTarget", level: state.level.name, id: null }] as const]
                  : []),
              ]}
              send={send}
            />
          </div>
          <Buttons buttons={[["Cancel", { _tag: "Cancel" }]]} send={send} />
        </>
      )
    case "RequirementNotMet":
      return (
        <>
          <p className="form-error" role="alert">
            {`The login lacks what the block requires: ${state.unmet.map(unmetWords).join("; ")}.`}
          </p>
          {state.identity === undefined ? null : <IdentityCard identity={state.identity} />}
          <Buttons
            buttons={[
              ["Check again", { _tag: "CheckAgain" }],
              ["Sign out", { _tag: "SignOut" }],
            ]}
            send={send}
          />
        </>
      )
    case "Ready":
      return (
        <>
          <p className="block-status">Signed in.</p>
          <IdentityCard identity={state.identity} />
          <Buttons buttons={[["Sign out", { _tag: "SignOut" }]]} send={send} />
        </>
      )
    case "Expired":
      return (
        <>
          <p className="form-error" role="alert">
            The login has expired. Sign out, then sign in again.
          </p>
          <IdentityCard identity={state.identity} />
          <Buttons
            buttons={[
              ["Check again", { _tag: "CheckAgain" }],
              ["Sign out", { _tag: "SignOut" }],
            ]}
            send={send}
          />
        </>
      )
    case "Unavailable":
      return (
        <>
          <p className="form-error" role="alert">{`Can't sign in: ${state.error.message}`}</p>
          {state.error.tool === undefined ? null : (
            <ToolLink name={state.error.tool.name} url={state.error.tool.installUrl} />
          )}
          <Buttons buttons={[["Check again", { _tag: "CheckAgain" }]]} send={send} />
        </>
      )
    default: {
      const unhandled: never = state
      throw new Error(`The auth view has no view of the state ${JSON.stringify(unhandled)}.`)
    }
  }
}

/**
 * Where a login was found, in words. The engine's source is `env`, a
 * block's id for the outputs it read (the block's own, for the login it
 * had before), or the name of a source the provider looks in itself, as
 * `cli`. An `env` source under a prefix is `env` too.
 */
function FoundIn({
  source,
  block,
  onPage,
}: {
  readonly source: string
  readonly block: string | undefined
  readonly onPage: ReadonlySet<string>
}) {
  if (source === "env") return "Found a login in the environment Runbooks started in."
  if (source === block) return "Found the login this block had before."
  if (onPage.has(source))
    return (
      <>
        {"Found a login in the outputs of "}
        <BlockLink block={source} onPage={onPage} />.
      </>
    )
  return `Found a login in the ${source} source.`
}

/** A row of buttons, each sending its action. */
function Buttons({
  buttons,
  send,
}: {
  readonly buttons: ReadonlyArray<readonly [string, Action]>
  readonly send: (action: Action) => void
}) {
  return (
    <div className="block-actions">
      {buttons.map(([label, action]) => (
        <button key={label} type="button" onClick={() => send(action)}>
          {label}
        </button>
      ))}
    </div>
  )
}

/** One tab per sign-in method, and the chosen one's fields. */
function SignIn({
  methods,
  first,
  chosen,
  choose,
  typed,
  keep,
  send,
}: {
  readonly methods: ReadonlyArray<Method>
  readonly first: string | undefined
  readonly chosen: string | undefined
  readonly choose: (method: string) => void
  readonly typed: Typed
  readonly keep: (method: string, field: string, text: string) => void
  readonly send: (action: Action) => void
}) {
  const id = useId()
  const method =
    methods.find((offered) => offered.name === chosen) ??
    methods.find((offered) => offered.name === first) ??
    methods[0]
  if (method === undefined) return null
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    // Entries, not assignment: a provider may name a field `__proto__`.
    const fields: Array<readonly [string, Redacted.Redacted<string>]> = []
    for (const field of method.fields) {
      const control = event.currentTarget.elements.namedItem(field.name)
      if (control === null || !("value" in control)) continue
      if (control.value !== "") fields.push([field.name, Redacted.make(control.value)])
      // The page keeps no secret once it is sent.
      if (field.secret) control.value = ""
    }
    send({ _tag: "SignIn", method: method.name, fields: Object.fromEntries(fields) })
  }
  return (
    <>
      <div role="tablist" aria-label="Sign-in methods" className="auth-tabs">
        {methods.map((offered) => (
          <button
            key={offered.name}
            type="button"
            role="tab"
            id={`${id}-${offered.name}`}
            aria-selected={offered.name === method.name}
            onClick={() => choose(offered.name)}
          >
            {offered.label}
          </button>
        ))}
      </div>
      <form
        // A form per method, so a field another tab left is not sent with this one.
        key={method.name}
        role="tabpanel"
        aria-labelledby={`${id}-${method.name}`}
        className="form"
        onSubmit={submit}
      >
        {method.fields.map((field) => (
          <Field
            key={field.name}
            id={`${id}-${method.name}-${field.name}`}
            field={field}
            value={
              field.secret
                ? undefined
                : (typed.get(method.name)?.get(field.name) ??
                  (Object.hasOwn(method.defaults, field.name)
                    ? method.defaults[field.name]
                    : undefined))
            }
            keep={(text) => keep(method.name, field.name, text)}
          />
        ))}
        {(method.oneOf ?? []).map((group) => (
          <p
            key={group.join()}
            className="form-description"
          >{`Give one of: ${group.join(", ")}.`}</p>
        ))}
        {method.unavailable === undefined ? (
          <div className="block-actions">
            <button type="submit">Sign in</button>
          </div>
        ) : (
          <p className="form-error">{`${method.label} can't be used: ${method.unavailable.message}`}</p>
        )}
      </form>
    </>
  )
}

function Field({
  id,
  field,
  value,
  keep,
}: {
  readonly id: string
  readonly field: Method["fields"][number]
  readonly value: string | undefined
  /** Keeps what the person typed or picked. A secret field never calls it. */
  readonly keep: (text: string) => void
}) {
  const label = (
    <label htmlFor={id} className="form-label">
      {field.label}
      {field.required ? <span className="form-required">*</span> : null}
    </label>
  )
  if (field.secret)
    return (
      <div className="form-field">
        {label}
        <input id={id} name={field.name} type="password" autoComplete="off" spellCheck={false} />
      </div>
    )
  return (
    <div className="form-field">
      {label}
      {field.choices === undefined ? (
        <input
          id={id}
          name={field.name}
          type="text"
          defaultValue={value}
          spellCheck={false}
          onChange={(event) => keep(event.currentTarget.value)}
        />
      ) : (
        <select
          id={id}
          name={field.name}
          defaultValue={value ?? ""}
          onChange={(event) => keep(event.currentTarget.value)}
        >
          {field.required ? null : <option value="">None</option>}
          {field.choices.map((choice) => (
            <option key={choice.value} value={choice.value}>
              {choice.label}
            </option>
          ))}
        </select>
      )}
    </div>
  )
}

/** What a sign-in shows the person: the page to open, the code to give it, and that it waits. */
function Prompt({
  url,
  code,
  waiting,
}: {
  readonly url: string | undefined
  readonly code: string | undefined
  readonly waiting: boolean
}) {
  const target = url === undefined ? undefined : linkTarget(url)
  return (
    <>
      {url === undefined ? null : target === undefined ? (
        <p>{`Open ${url} in your browser.`}</p>
      ) : (
        <p>
          <a href={target}>Open the sign-in page</a>
        </p>
      )}
      {code === undefined ? null : (
        <p>
          {"Code: "}
          <code>{code}</code>
        </p>
      )}
      {waiting ? <p className="block-status">Waiting for you to finish signing in.</p> : null}
    </>
  )
}

/** Who signed in, what is selected at each level, and when it expires. */
function IdentityCard({ identity }: { readonly identity: Identity }) {
  return (
    <>
      <dl className="block-outputs" aria-label="Signed in as">
        <dt>signed in as</dt>
        <dd>{identity.principal}</dd>
        {Object.entries(identity.targets).map(([level, target]) => (
          <Fragment key={level}>
            <dt>{level}</dt>
            <dd>{target === null ? "none" : targetName(target)}</dd>
          </Fragment>
        ))}
        {identity.expiresAt === undefined ? null : (
          <>
            <dt>expires</dt>
            <dd>{DateTime.formatIso(identity.expiresAt)}</dd>
          </>
        )}
      </dl>
      {(identity.warnings ?? []).map((warning) => (
        <p key={warning.message} className="form-description">
          {warning.message}
        </p>
      ))}
    </>
  )
}

function ToolLink({ name, url }: { readonly name: string; readonly url: string }) {
  const target = linkTarget(url)
  return target === undefined ? (
    <p>{`It needs ${name}: ${url}`}</p>
  ) : (
    <p>
      {`It needs ${name}: `}
      <a href={target}>{`install ${name}`}</a>
    </p>
  )
}

const targetName = (target: { readonly id: string; readonly name: string }) =>
  target.name === target.id ? target.id : `${target.name} (${target.id})`

const unmetWords = (
  unmet: Extract<State, { readonly _tag: "RequirementNotMet" }>["unmet"][number],
): string =>
  unmet.kind === "scopes"
    ? `scopes ${unmet.scopes.join(", ")}`
    : `roles ${unmet.roles.map((role) => role.role).join(", ")}`
