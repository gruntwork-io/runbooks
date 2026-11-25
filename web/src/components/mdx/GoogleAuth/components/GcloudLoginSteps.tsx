import { formatGcloudAdcLoginCommand } from "../../../../../../src/domain/google/scopes"
import { GuideCommand, GuideLink, GuideSteps } from "./MethodGuide"

const GCLOUD_INSTALL_PAGE = "https://docs.cloud.google.com/sdk/docs/install"

export function GcloudLoginSteps() {
  return (
    <>
      <GuideSteps>
        <RunLoginCommandStep />
        <li>Choose the account you want to sign in as.</li>
        <li>
          If Google asks which permissions to allow, check <strong>Select all</strong>, then click{" "}
          <strong>Continue</strong>.
        </li>
        <li>
          Return to Runbooks and click <strong>Reload</strong>.
        </li>
      </GuideSteps>
      <InstallHint />
    </>
  )
}

function RunLoginCommandStep() {
  return (
    <li>
      Run <GuideCommand>{formatGcloudAdcLoginCommand([])}</GuideCommand> in a terminal. It opens
      your browser.
    </li>
  )
}

function InstallHint() {
  return (
    <p>
      If you do not have gcloud installed,{" "}
      <GuideLink href={GCLOUD_INSTALL_PAGE}>install the Google Cloud CLI</GuideLink> first.
    </p>
  )
}
