import { useEffect, useState } from "react"
import { useApi } from "@/contexts/ApiContext"

/**
 * The app's version, so a bug report can name it: "" until main reports it,
 * and for good if the lookup fails, in which case callers leave it out.
 */
export function useAppVersion(): string {
  const api = useApi()
  const [version, setVersion] = useState("")

  useEffect(() => {
    api
      .invoke("native:app-version")
      .then((result) => setVersion(result.version))
      .catch(() => setVersion(""))
  }, [api])

  return version
}
