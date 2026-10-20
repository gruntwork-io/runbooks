import babel from "@rolldown/plugin-babel"
import react, { reactCompilerPreset } from "@vitejs/plugin-react"

export function reactWithCompiler() {
  return [react(), babel({ presets: [reactCompilerPreset()] })]
}
