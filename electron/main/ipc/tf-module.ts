/**
 * IPC handlers for the <TfModule> block: reading the module it presents,
 * and the lookups that fill its dropdowns and suggestions, from Google or, in
 * simulation mode, from simulation.yml.
 */
import { Effect } from "effect"
import { ipcMain } from "electron"
import { runtime } from "./runtime.ts"
import { moduleDir } from "./tf-module-source.ts"
import { activeSimulationScenario, simulationEnabled } from "./simulation.ts"
import { loadModule } from "../../../src/domain/tf-module/load.ts"
import { simulatedRows } from "../../../src/domain/tf-module/simulation.ts"
import {
  customerRows,
  domainRows,
  isLookupName,
  LOOKUPS,
  matchesQuery,
  meRows,
  personRows,
} from "../../../src/domain/tf-module/lookups.ts"
import { GoogleClient } from "../../../src/services/GoogleClient.ts"
import { activeCredentialFor } from "./google-credential-registry.ts"
import { TfModuleError } from "../../../src/errors/index.ts"
import { unpinnedSourceWarning } from "../../../src/domain/tf-module/moduleSource.ts"
import type { TfModuleLookupRequest, TfModuleReadRequest } from "../../shared/channels.ts"

/** The most rows a lookup returns; the user narrows the rest by typing. */
const MAX_LOOKUP_ROWS = 50

const fail = (message: string) => new TfModuleError({ message })

/**
 * A lookup's rows from Google, read with the account the runbook's GoogleAuth
 * block signed in most recently, narrowed to what the user typed.
 */
const googleLookup = (from: string, query: string) =>
  Effect.gen(function* () {
    if (!isLookupName(from)) {
      return yield* fail(
        `runbook_block.yml names a lookup Runbooks doesn't have: ${from}. It has ${Object.entries(
          LOOKUPS,
        )
          .map(([name, gives]) => `${name} (${gives})`)
          .join("; ")}.`,
      )
    }
    const credential = activeCredentialFor(undefined)
    if (!credential) {
      return yield* fail(
        "Suggestions here come from Google. Sign in with a GoogleAuth block above this one.",
      )
    }
    const google = yield* GoogleClient
    const asLookupError = (cause: { message: string }) => fail(cause.message)
    switch (from) {
      case "google.me":
        return meRows(credential.principal)
      case "google.customer": {
        const customer = yield* google
          .getCustomer(credential.ref, credential.projectId)
          .pipe(Effect.mapError(asLookupError))
        return customerRows(customer)
      }
      case "google.domains": {
        const domains = yield* google
          .listDomains(credential.ref, credential.projectId)
          .pipe(Effect.mapError(asLookupError))
        return domainRows(domains).filter((row) => matchesQuery(row, query))
      }
      case "google.people": {
        const people = yield* google
          .searchPeople(credential.ref, query, MAX_LOOKUP_ROWS, credential.projectId)
          .pipe(Effect.mapError(asLookupError))
        return personRows(people)
      }
    }
  })

export function registerTfModuleHandlers(): void {
  ipcMain.handle("tf-module:read", async (_event, params: TfModuleReadRequest) =>
    runtime.runPromise(
      Effect.gen(function* () {
        if (!params?.source) {
          return yield* new TfModuleError({
            message: "The block needs a source: the module's path or URL.",
          })
        }
        const spec = yield* loadModule(yield* moduleDir(params.source))
        const warning = unpinnedSourceWarning(params.source)
        return warning ? { ...spec, warnings: [...spec.warnings, warning] } : spec
      }),
    ),
  )

  ipcMain.handle("tf-module:lookup", async (_event, params: TfModuleLookupRequest) =>
    runtime.runPromise(
      Effect.gen(function* () {
        if (!simulationEnabled()) {
          const rows = yield* googleLookup(params.from, params.query ?? "")
          return { rows: rows.slice(0, MAX_LOOKUP_ROWS) }
        }
        const scenario = yield* activeSimulationScenario
        const answer = scenario.lookups[params.from]
        if (answer?.delayMs) yield* Effect.sleep(answer.delayMs)
        const rows = yield* Effect.try({
          try: () => simulatedRows(scenario, params.from, params.query ?? ""),
          catch: (cause) =>
            cause instanceof TfModuleError
              ? cause
              : new TfModuleError({ message: String(cause), cause }),
        })
        return { rows: rows.slice(0, MAX_LOOKUP_ROWS) }
      }),
    ),
  )
}
