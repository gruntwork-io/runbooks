import { Boxes } from "lucide-react"
import googleLogo from "@/assets/google-g-logo.svg"
import type { TofuModuleSpec } from "../../../../../../src/domain/tofu-module/types"

/**
 * Marks for the providers modules use most, by registry address. A module
 * shows its own logo instead when its runbooks.yml sets one.
 */
type ProviderMark =
  | { image: string; label: string }
  | { text: string; className: string; label: string }

const GOOGLE: ProviderMark = { image: googleLogo, label: "Google" }

const PROVIDER_MARKS: Record<string, ProviderMark> = {
  "hashicorp/google": GOOGLE,
  "hashicorp/google-beta": GOOGLE,
  "hashicorp/googleworkspace": GOOGLE,
  "hashicorp/aws": { text: "aws", className: "bg-[#232F3E] text-[#FF9900]", label: "AWS" },
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

export function ModuleLogo({ spec }: { spec: TofuModuleSpec }) {
  const box = "flex size-10 shrink-0 items-center justify-center rounded-lg"
  if (spec.logo) {
    return <img src={spec.logo} alt="" className={`${box} object-contain`} />
  }
  for (const provider of spec.providers) {
    const mark = PROVIDER_MARKS[address(provider.source, provider.name)]
    if (mark && "image" in mark) {
      return (
        <div className={`${box} border border-border bg-card p-1.5`} title={mark.label}>
          <img src={mark.image} alt={mark.label} className="size-full object-contain" />
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
