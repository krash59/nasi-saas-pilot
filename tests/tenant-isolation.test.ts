import { describe, expect, it } from "vitest";
import { canAccessProject } from "@/lib/tenant/access";

describe("tenant access helpers (BDD_F05_01 app-layer)", () => {
  it("denies when customer does not own project", () => {
    expect(
      canAccessProject(
        { customerId: "aaa", projectCustomerId: "bbb" },
      ),
    ).toBe(false);
  });

  it("allows when customer owns project", () => {
    expect(
      canAccessProject(
        { customerId: "aaa", projectCustomerId: "aaa" },
      ),
    ).toBe(true);
  });
});
