import { describe, it, expect } from "vitest"
import { omitUndefined } from "./omitUndefined"

describe("omitUndefined", () => {
  it("drops keys whose value is undefined", () => {
    const payload = omitUndefined({ startUrl: "https://sso", accountId: undefined })
    expect(payload).toEqual({ startUrl: "https://sso" })
    expect("accountId" in payload).toBe(false)
  })

  it("keeps falsy values that are not undefined", () => {
    expect(omitUndefined({ token: "", count: 0, flag: false, value: null })).toEqual({
      token: "",
      count: 0,
      flag: false,
      value: null,
    })
  })
})
