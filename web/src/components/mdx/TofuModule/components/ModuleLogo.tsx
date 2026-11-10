import { Boxes } from "lucide-react"
import type { TofuModuleSpec } from "../../../../../../src/domain/tofu-module/types"

/**
 * Marks for the providers modules use most, by registry address. A module
 * shows its own logo instead when its runbooks.yml sets one.
 */
const PROVIDER_MARKS: Record<string, { text: string; className: string; label: string }> = {
  "hashicorp/google": { text: "G", className: "bg-[#4285F4] text-white", label: "Google Cloud" },
  "hashicorp/google-beta": {
    text: "G",
    className: "bg-[#4285F4] text-white",
    label: "Google Cloud",
  },
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
