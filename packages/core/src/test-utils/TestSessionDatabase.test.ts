import { memorySessionDatabase } from "./TestSessionDatabase.ts"
import { sessionDatabaseContract } from "./sessionDatabaseContract.ts"

sessionDatabaseContract("in memory", async () => ({
  layer: memorySessionDatabase().layer,
  release: async () => {},
}))
