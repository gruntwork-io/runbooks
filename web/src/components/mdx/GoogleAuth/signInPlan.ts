import type { GoogleAuthMethod, GoogleAuthProps, GoogleCredentialSource } from "./types"
import { AUTH_METHODS, resolveDefaultAuthMethod } from "./utils"

export interface SignInPlan {
  methods: readonly GoogleAuthMethod[]
  openingMethod: GoogleAuthMethod
  detectCredentials: false | GoogleCredentialSource[]
  configurationError?: string
}

type SignInProps = {
  [Prop in "methods" | "defaultTab" | "detectCredentials"]?: GoogleAuthProps[Prop] | undefined
}

const METHOD_NAMES = AUTH_METHODS.join(", ")

const ENVIRONMENT_THEN_GCLOUD_LOGIN: GoogleCredentialSource[] = ["env", "adc"]
const ENVIRONMENT_ONLY: GoogleCredentialSource[] = ["env"]

export function planSignIn(props: SignInProps): SignInPlan {
  if (props.methods === undefined) return planEveryMethod(props)
  const configurationError = findConfigurationError(props)
  if (configurationError) {
    return { ...planEveryMethod({ detectCredentials: false }), configurationError }
  }
  return planListedMethods({ ...props, methods: [...new Set(props.methods)] })
}

function planEveryMethod({ defaultTab, detectCredentials }: SignInProps): SignInPlan {
  return {
    methods: AUTH_METHODS,
    openingMethod: resolveDefaultAuthMethod(defaultTab),
    detectCredentials: detectCredentials ?? ENVIRONMENT_THEN_GCLOUD_LOGIN,
  }
}

function planListedMethods(props: SignInProps & { methods: GoogleAuthMethod[] }): SignInPlan {
  const { methods, defaultTab, detectCredentials } = props
  return {
    methods,
    openingMethod: resolveDefaultAuthMethod(defaultTab ?? methods[0]),
    detectCredentials: detectCredentials ?? defaultDetection(methods),
  }
}

function defaultDetection(methods: GoogleAuthMethod[]): GoogleCredentialSource[] {
  return methods.includes("gcloud") ? ENVIRONMENT_THEN_GCLOUD_LOGIN : ENVIRONMENT_ONLY
}

function findConfigurationError(props: SignInProps): string | undefined {
  const { methods, defaultTab } = props
  if (!Array.isArray(methods) || methods.length === 0) {
    return `The methods prop must list at least one of: ${METHOD_NAMES}.`
  }
  const unknown = methods.filter((method) => !AUTH_METHODS.includes(method))
  if (unknown.length > 0) {
    return `The methods prop lists "${unknown.join('", "')}". Use only: ${METHOD_NAMES}.`
  }
  if (defaultTab && !methods.includes(defaultTab)) {
    return `The defaultTab prop is "${defaultTab}", which the methods prop does not list.`
  }
  return findUnlistedGcloudLoginSource(props)
}

function findUnlistedGcloudLoginSource(props: SignInProps): string | undefined {
  const { methods, detectCredentials } = props
  if (!Array.isArray(detectCredentials) || methods?.includes("gcloud")) return undefined
  const source = detectCredentials.find(readsGcloudLogin)
  if (!source) return undefined
  return `The detectCredentials prop includes '${source}', which reads the gcloud login, but the methods prop does not list gcloud.`
}

function readsGcloudLogin(source: GoogleCredentialSource): source is "adc" | "gcloud" {
  return source === "adc" || source === "gcloud"
}
