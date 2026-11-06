import { useContext } from "react"
import {
  GeneratedFilesReviewContext,
  type GeneratedFilesReviewContextType,
} from "../contexts/GeneratedFilesContext.types"

export const useGeneratedFilesReview = (): GeneratedFilesReviewContextType => {
  const context = useContext(GeneratedFilesReviewContext)
  if (context === undefined) {
    throw new Error("useGeneratedFilesReview must be used within a GeneratedFilesProvider")
  }
  return context
}
