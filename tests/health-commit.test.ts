import { afterEach, expect, it } from "vitest";
import { GET } from "@/app/api/health/route";

afterEach(() => { delete process.env.VERCEL_GIT_COMMIT_SHA; });

it("health reports the commit the deployment was built from", async () => {
  process.env.VERCEL_GIT_COMMIT_SHA = "0123456789abcdef0123456789abcdef01234567";
  const body = await (await GET()).json();
  expect(body).toMatchObject({ ok: true, commit: "0123456789abcdef0123456789abcdef01234567" });
});

it("health reports no commit outside Vercel", async () => {
  expect((await (await GET()).json()).commit).toBeNull();
});
