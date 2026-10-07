import react from "@vitejs/plugin-react"

export function reactWithCompiler() {
  return react({ babel: { plugins: ["babel-plugin-react-compiler"] } })
}
