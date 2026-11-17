import { afterEach, expect, it } from "vitest";
import { GET } from "@/app/api/health/route";

afterEach(() => { delete process.env.VERCEL_GIT_COMMIT_SHA; });

it("health reports the commit the deployment was built from (on Vercel)", async () => {
  process.env.VERCEL_GIT_COMMIT_SHA = "0123456789abcdef0123456789abcdef01234567";
  expect(await (await GET()).json()).toEqual({ ok: true, wave: 1, service: "nws-gas-saas-app", commit: "0123456789abcdef0123456789abcdef01234567" });
});

it("outside Vercel the reply is exactly the shape the NWS build health probe requires", async () => {
  expect(await (await GET()).json()).toEqual({ ok: true, wave: 1, service: "nws-gas-saas-app" });
});
