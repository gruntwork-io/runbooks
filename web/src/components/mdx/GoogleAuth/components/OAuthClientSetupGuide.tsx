import { GuideLink, GuideSteps, SetupGuide } from "./MethodGuide"

const CONSOLE = {
  home: "https://console.cloud.google.com/",
  resourceManagerApi:
    "https://console.developers.google.com/apis/api/cloudresourcemanager.googleapis.com/overview",
  branding: "https://console.developers.google.com/auth/branding",
  clients: "https://console.developers.google.com/auth/clients",
  audience: "https://console.developers.google.com/auth/audience",
  dataAccess: "https://console.developers.google.com/auth/scopes",
} as const

export function OAuthClientSetupGuide({ scopes }: { scopes: string[] }) {
  return (
    <SetupGuide question="How do I create an OAuth client?">
      <GuideSteps>
        <ProjectSteps />
        <BrandingStep />
        <ClientSteps />
      </GuideSteps>
      <ExternalAppSteps scopes={scopes} />
    </SetupGuide>
  )
}

function ProjectSteps() {
  return (
    <>
      <li>
        In the <GuideLink href={CONSOLE.home}>Google Cloud console</GuideLink>, select a project you
        administer, or create one. If you have an organization, use a project inside it so you can
        choose <strong>Internal</strong> in step 3.
      </li>
      <li>
        Turn on the{" "}
        <GuideLink href={CONSOLE.resourceManagerApi}>Cloud Resource Manager API</GuideLink> for that
        project. Runbooks needs it to list your projects when you sign in.
      </li>
    </>
  )
}

function BrandingStep() {
  return (
    <li>
      Open <GuideLink href={CONSOLE.branding}>Branding</GuideLink>. Fill in the app name and support
      email. Choose <strong>Internal</strong> as the audience, or <strong>External</strong> if the
      project is not in an organization. Add a contact email, accept the policy and click{" "}
      <strong>Create</strong>.
    </li>
  )
}

function ClientSteps() {
  return (
    <>
      <li>
        Open <GuideLink href={CONSOLE.clients}>Clients</GuideLink>, click{" "}
        <strong>Create client</strong>, choose <strong>Desktop app</strong>, enter a name and click{" "}
        <strong>Create</strong>.
      </li>
      <li>
        Download the JSON file from the dialog that opens and keep it somewhere safe. You cannot
        download it again.
      </li>
      <li>
        Return to Runbooks, click <strong>Choose Desktop OAuth client JSON</strong> and select the
        file.
      </li>
    </>
  )
}

function ExternalAppSteps({ scopes }: { scopes: string[] }) {
  return (
    <>
      <p>
        For an <strong>External</strong> app, also do these before step 4:
      </p>
      <GuideSteps>
        <li>
          Open <GuideLink href={CONSOLE.audience}>Audience</GuideLink>. Under{" "}
          <strong>Test users</strong>, add your own email. While the app is in{" "}
          <strong>Testing</strong>, only test users can sign in.
        </li>
        <DataAccessStep scopes={scopes} />
      </GuideSteps>
      <TestingLimits />
    </>
  )
}

function TestingLimits() {
  return (
    <p>
      Google will warn you that the app is not verified. You can continue past the warning. While
      the app is in <strong>Testing</strong>, your sign-in expires after 7 days and you will need to
      sign in again.
    </p>
  )
}

function DataAccessStep({ scopes }: { scopes: string[] }) {
  return (
    <li>
      Open <GuideLink href={CONSOLE.dataAccess}>Data Access</GuideLink>, click{" "}
      <strong>Add or Remove Scopes</strong>, add these scopes and click <strong>Save</strong>:
      <ul className="ml-4 list-disc space-y-0.5">
        {scopes.map((scope) => (
          <li key={scope} className="font-mono text-xs break-all">
            {scope}
          </li>
        ))}
      </ul>
    </li>
  )
}
