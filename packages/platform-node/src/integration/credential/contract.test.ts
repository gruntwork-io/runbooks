/**
 * The credential provider contract
 * (`@runbooks/core/test-utils/credentialProviderContract`) against plugins
 * as processes, through the credential client and the transport owner, as
 * the app runs them: the fake always, and a released binary when the
 * environment names one. From the repository's root:
 *
 *   RUNBOOKS_CONTRACT_BINARY=/path/to/the/binary \
 *   RUNBOOKS_CONTRACT_SHA256=<its SHA-256, as plugins.lock pins it> \
 *   bun test packages/platform-node/src/integration/credential/contract.test.ts
 *
 * The plugin's name is the binary's file name after the kind's prefix, up
 * to a `_` (a release asset's version and platform);
 * `RUNBOOKS_CONTRACT_PLUGIN` names it otherwise. The offline scenarios for
 * `aws` are built in. For another plugin, or to add the `[account]` cases,
 * `RUNBOOKS_CONTRACT_SCENARIOS` names a JSON file holding
 * `ContractScenarios`, with `environment` (more variables for the plugin)
 * and `settings` (the block's) when it needs them. Only the account cases
 * reach the cloud. `-t '\[account\]'` runs only those.
 *
 * Each case gets a temporary folder holding a bin folder with a copy of the
 * binary, pinned by the given hash (the owner refuses another), a HOME of
 * its own, and the block's state folder. An offline case's proxy is a
 * port on 127.0.0.1 that accepts connections and never answers, so a
 * sign-in that would reach the network waits there until the suite gives
 * it up. An account case has no proxy.
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs"
import { createServer, type Socket } from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"
import { Option, Redacted, Schema } from "effect"
import { FAKE_SCRIPT } from "@runbooks/core/credential/fake"
import type { ProviderConfig } from "@runbooks/core/credential/provider"
import type { PluginEntry } from "@runbooks/core/plugin/transport"
import {
  ContractScenarios,
  credentialProviderContract,
  FAKE_SCENARIOS,
  type OpenedSubject,
  type Reach,
} from "@runbooks/core/test-utils/credentialProviderContract"
import { binaryName } from "../../layers/NodePluginProcess.ts"
import { installBinary, installFake, PLATFORM, pluginProviders } from "./pluginBin.ts"

/** A port that accepts connections and never answers: a network that does not. */
const blackhole = async () => {
  const sockets = new Set<Socket>()
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.on("close", () => sockets.delete(socket))
  })
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  const port = typeof address === "object" && address !== null ? address.port : 0
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy()
        server.close(() => resolve())
      }),
  }
}

/**
 * A fresh case: a temporary folder with a bin folder, a HOME and a state
 * folder, `install` putting the plugin in the bin folder, and for an
 * offline case a proxy that never answers. An account case has no proxy.
 */
const subject =
  (
    provider: string,
    install: (binDir: string) => PluginEntry,
    more: {
      readonly environment?: { readonly [name: string]: string }
      readonly settings?: { readonly [name: string]: string }
    } = {},
  ) =>
  async (reach: Reach): Promise<OpenedSubject> => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "runbooks-contract-")))
    const binDir = path.join(root, "bin")
    mkdirSync(binDir)
    mkdirSync(path.join(root, "home"))
    const proxy = reach === "offline" ? await blackhole() : undefined
    const environment = {
      PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
      HOME: path.join(root, "home"),
      ...more.environment,
    }
    const config: ProviderConfig = {
      stateDir: path.join(root, "state", "s1", "block"),
      environment: new Map(
        Object.entries(environment).map(([name, value]) => [name, Redacted.make(value)]),
      ),
      caBundleFile: Option.none(),
      proxy: Option.fromUndefinedOr(proxy?.url),
      settings: more.settings ?? {},
    }
    return {
      layer: pluginProviders(binDir, [install(binDir)]),
      provider,
      config,
      release: async () => {
        await proxy?.close()
        rmSync(root, { recursive: true, force: true })
      },
    }
  }

credentialProviderContract("the fake, as a process", {
  scenarios: FAKE_SCENARIOS,
  open: subject("fake", (binDir) => installFake(binDir), {
    settings: { fakeScript: JSON.stringify(FAKE_SCRIPT) },
  }),
})

/**
 * The offline scenarios for the AWS plugin: refused before it reaches the
 * network (a missing field, a pin that is no account id, a start URL that
 * is not https), or an SSO sign-in waiting on the proxy. A plugin that
 * ignored `proxy` would reach AWS here and fail the waiting case.
 */
const AWS_OFFLINE: ContractScenarios = {
  invalidSignIns: [
    { method: "credentials", fields: {} },
    {
      method: "credentials",
      fields: { accessKeyId: "contract-test-key", secretAccessKey: "contract-test-secret" },
      pins: { account: "not-an-account" },
    },
    { method: "sso", fields: { ssoStartUrl: "http://example.awsapps.com/start" } },
  ],
  waitingSignIn: {
    method: "sso",
    fields: { ssoStartUrl: "https://example.awsapps.com/start", ssoRegion: "us-east-1" },
  },
  giveUpAfterMillis: 2_000,
}

const ScenariosFile = Schema.Struct({
  ...ContractScenarios.fields,
  environment: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  settings: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
})

const binary = process.env["RUNBOOKS_CONTRACT_BINARY"]
if (binary !== undefined) {
  const sha256 = process.env["RUNBOOKS_CONTRACT_SHA256"]
  if (sha256 === undefined) throw new Error("RUNBOOKS_CONTRACT_SHA256 must give the binary's hash.")
  const prefix = binaryName("credential", "", PLATFORM).replace(/\.exe$/, "")
  const fileName = path.basename(binary)
  const plugin =
    process.env["RUNBOOKS_CONTRACT_PLUGIN"] ??
    (fileName.startsWith(prefix) ? fileName.slice(prefix.length).split(/[_.]/)[0] : undefined)
  if (plugin === undefined || plugin === "")
    throw new Error("RUNBOOKS_CONTRACT_PLUGIN must name the plugin.")
  const file = process.env["RUNBOOKS_CONTRACT_SCENARIOS"]
  const scenarios =
    file === undefined
      ? plugin === "aws"
        ? AWS_OFFLINE
        : undefined
      : Schema.decodeUnknownSync(ScenariosFile)(JSON.parse(readFileSync(file, "utf8")))
  if (scenarios === undefined)
    throw new Error(`RUNBOOKS_CONTRACT_SCENARIOS must name the scenarios for ${plugin}.`)
  const { environment, settings } = scenarios as typeof ScenariosFile.Type
  credentialProviderContract(`${plugin}, ${fileName}`, {
    scenarios,
    open: subject(plugin, (binDir) => installBinary(binDir, plugin, binary, sha256), {
      ...(environment === undefined ? {} : { environment }),
      ...(settings === undefined ? {} : { settings }),
    }),
  })
}
