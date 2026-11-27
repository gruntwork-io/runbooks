import { GuideLink, GuideSteps, SetupGuide } from "./MethodGuide"

const SERVICE_ACCOUNTS_PAGE = "https://console.cloud.google.com/iam-admin/serviceaccounts"

export function ServiceAccountKeyGuide() {
  return (
    <SetupGuide question="How do I get a key?">
      <GuideSteps>
        <FindServiceAccountSteps />
        <CreateKeySteps />
      </GuideSteps>
      <p>
        Organizations created on or after 3 May 2024 block new keys by default. If you are unable to
        create a key, use another sign-in method.
      </p>
    </SetupGuide>
  )
}

function FindServiceAccountSteps() {
  return (
    <>
      <li>
        In the Google Cloud console, open{" "}
        <GuideLink href={SERVICE_ACCOUNTS_PAGE}>Service accounts</GuideLink> and select a project.
      </li>
      <li>Click the email address of the service account you want to use.</li>
    </>
  )
}

function CreateKeySteps() {
  return (
    <>
      <li>
        On the <strong>Keys</strong> tab, click <strong>Add key</strong>, then{" "}
        <strong>Create new key</strong>.
      </li>
      <li>
        Select <strong>JSON</strong> and click <strong>Create</strong>. Keep the downloaded key file
        safe. You cannot download it again.
      </li>
      <li>
        Return to Runbooks, click <strong>Choose key file…</strong> and select it.
      </li>
    </>
  )
}
