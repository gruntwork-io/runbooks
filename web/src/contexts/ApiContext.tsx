import { createContext, useContext } from 'react'

export type RunbooksAPI = typeof window.api

const ApiContext = createContext<RunbooksAPI>(null!)

export function ApiProvider({ api, children }: { api: RunbooksAPI; children: React.ReactNode }) {
  return <ApiContext.Provider value={api}>{children}</ApiContext.Provider>
}

export function useApi(): RunbooksAPI {
  return useContext(ApiContext)
}
