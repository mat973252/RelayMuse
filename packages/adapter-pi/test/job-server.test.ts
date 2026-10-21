import assert from "node:assert/strict";
import { it } from "node:test";
import { startJobServer } from "./fixtures/job-server.js";

const { startReleaseServer } = await import(new URL("../../../../examples/pi-muse/fixtures/release-server.mjs", import.meta.url).href) as {
  startReleaseServer: (delay: number) => Promise<{ baseUrl: string; stop: () => Promise<void> }>;
};

for (const [fixture, start] of [["job", startJobServer], ["release", startReleaseServer]] as const) {
  for (const [label, delay, jump, expected] of [
    ["backward", 0, -60_000, "complete"],
    ["forward", 60_000, 120_000, "pending"],
  ] as const) {
    it(`${fixture} completion ignores a ${label} wall-clock jump`, async (t) => {
      const server = await start(delay);
      try {
        const submitted = await fetch(`${server.baseUrl}/js`, { method: "POST", headers: { connection: "close" } });
        const { jobId } = await submitted.json() as { jobId: string };
        const wallTime = Date.now();
        t.mock.method(Date, "now", () => wallTime + jump);
        const response = await fetch(`${server.baseUrl}/js/${jobId}`, { headers: { connection: "close" } });
        const body = await response.json() as { status: string };
        assert.equal(body.status, expected);
      } finally {
        t.mock.restoreAll();
        await server.stop();
      }
    });
  }
}
