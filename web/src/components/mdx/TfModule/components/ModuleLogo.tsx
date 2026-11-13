import { Boxes } from "lucide-react"
import awsLogo from "@/assets/aws-logo.svg"
import awsLogoLight from "@/assets/aws-logo-light.svg"
import googleLogo from "@/assets/google-g-logo.svg"
import openTofuLogo from "@/assets/opentofu-logo.svg"
import { useTheme } from "@/contexts/useTheme"
import type { TfModuleSpec } from "../../../../../../src/domain/tf-module/types"

/**
 * Marks for the providers modules use most, by registry address. A module
 * shows its own logo instead when its runbook_block.yml sets one.
 */
type ProviderMark =
  | { image: string; imageOnDark?: string; label: string }
  | { text: string; className: string; label: string }

const GOOGLE: ProviderMark = { image: googleLogo, label: "Google" }

const PROVIDER_MARKS: Record<string, ProviderMark> = {
  "hashicorp/google": GOOGLE,
  "hashicorp/google-beta": GOOGLE,
  "hashicorp/googleworkspace": GOOGLE,
  "hashicorp/aws": { image: awsLogo, imageOnDark: awsLogoLight, label: "AWS" },
  "integrations/github": { text: "GH", className: "bg-[#24292F] text-white", label: "GitHub" },
  "cloudflare/cloudflare": {
    text: "CF",
    className: "bg-[#F38020] text-white",
    label: "Cloudflare",
  },
}

/** The registry address a provider entry names, with the default namespace filled in. */
const address = (source: string | undefined, name: string) => {
  const raw = (source ?? `hashicorp/${name}`).toLowerCase()
  return raw.replace(/^(registry\.(terraform|opentofu)\.(io|org)\/)/, "")
}

/**
 * The module's logo, with the OpenTofu mark on its corner so the block reads
 * as an OpenTofu module whatever provider it uses.
 */
export function ModuleLogo({ spec }: { spec: TfModuleSpec }) {
  return (
    <div className="relative shrink-0">
      <Mark spec={spec} />
      <img
        src={openTofuLogo}
        alt="OpenTofu"
        title="OpenTofu module"
        className="absolute -right-1.5 -bottom-1.5 size-5"
      />
    </div>
  )
}

function Mark({ spec }: { spec: TfModuleSpec }) {
  const dark = useTheme().resolvedTheme === "dark"
  const box = "flex size-10 shrink-0 items-center justify-center rounded-lg"
  if (spec.logo) {
    return <img src={spec.logo} alt="" className={`${box} object-contain`} />
  }
  for (const provider of spec.providers) {
    const mark = PROVIDER_MARKS[address(provider.source, provider.name)]
    if (mark && "image" in mark) {
      return (
        <div className={`${box} border border-border bg-card p-1.5`} title={mark.label}>
          <img
            src={dark && mark.imageOnDark ? mark.imageOnDark : mark.image}
            alt={mark.label}
            className="size-full object-contain"
          />
        </div>
      )
    }
    if (mark) {
      return (
        <div
          role="img"
          aria-label={mark.label}
          title={mark.label}
          className={`${box} text-sm font-bold ${mark.className}`}
        >
          {mark.text}
        </div>
      )
    }
  }
  return (
    <div className={`${box} bg-muted text-muted-foreground`} aria-hidden>
      <Boxes className="size-5" />
    </div>
  )
}
