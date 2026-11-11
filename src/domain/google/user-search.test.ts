import { describe, expect, it } from "bun:test"
import { userSearchQueries } from "./user-search"

describe("userSearchQueries", () => {
  it("lists active users for nothing typed", () => {
    expect(userSearchQueries("  ")).toEqual(["isSuspended=false"])
  })

  it("matches the start of a first name, last name or email for one word", () => {
    expect(userSearchQueries("Josh")).toEqual([
      "givenName:josh* isSuspended=false",
      "familyName:josh* isSuspended=false",
      "email:josh* isSuspended=false",
    ])
  })

  it("matches a first and last name for two words", () => {
    expect(userSearchQueries("ana li")).toEqual(["givenName:ana* familyName:li* isSuspended=false"])
  })

  it("drops characters that would change the query", () => {
    expect(userSearchQueries("o'brien*")).toEqual([
      "givenName:obrien* isSuspended=false",
      "familyName:obrien* isSuspended=false",
      "email:obrien* isSuspended=false",
    ])
  })
})
