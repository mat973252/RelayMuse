/**
 * pi-muse release server: a local, fully observable "remote" for the
 * vertical slice. Two surfaces:
 *   - deferred jobs:  POST /js (counted once)  GET /js/:id (pending -> complete)
 *   - mutation:       POST /publish {key}      — counted, idempotent BY KEY on
 *                     the server, and queryable via GET /effects/:key so the
 *                     client can reconcile after an ambiguous commit.
 *   - GET /state      — every counter the acceptance tests assert on.
 */
import { createServer } from "node:http";

export async function startReleaseServer(completeAfterMs = 600) {
  const jobs = new Map();
  const published = new Map();
  let nextJob = 0;
  let submissions = 0;
  let publishRequests = 0;

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const send = (code, body) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };

    if (req.method === "POST" && url.pathname === "/js") {
      nextJob += 1;
      submissions += 1;
      const jobId = `job-${nextJob}`;
      jobs.set(jobId, { submittedAt: Date.now() });
      return send(200, { jobId });
    }
    const jobMatch = url.pathname.match(/^\/js\/(.+)$/);
    if (req.method === "GET" && jobMatch !== null) {
      const job = jobs.get(jobMatch[1]);
      if (job === undefined) return send(404, { error: "unknown job" });
      if (Date.now() - job.submittedAt >= completeAfterMs) {
        return send(200, { status: "complete", result: `agent checked release ${jobMatch[1]}: ok` });
      }
      return send(200, { status: "pending" });
    }
    if (req.method === "POST" && url.pathname === "/publish") {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        publishRequests += 1;
        const { key } = JSON.parse(raw || "{}");
        // Server-side idempotency by key: a second POST for the same key is
        // still a remote REQUEST (counted) but not a second MUTATION.
        if (!published.has(key)) {
          published.set(key, { remoteRef: `pub-${key}`, at: Date.now() });
        }
        const record = published.get(key);
        send(200, { remoteRef: record.remoteRef, key });
      });
      return;
    }
    const effMatch = url.pathname.match(/^\/effects\/(.+)$/);
    if (req.method === "GET" && effMatch !== null) {
      const key = decodeURIComponent(effMatch[1]);
      const record = published.get(key);
      if (record === undefined) return send(404, { found: false });
      return send(200, { found: true, remoteRef: record.remoteRef, key });
    }
    if (req.method === "GET" && url.pathname === "/state") {
      return send(200, {
        submissions,
        publishRequests,
        mutations: published.size,
        publishedKeys: [...published.keys()],
      });
    }
    send(404, { error: "not found" });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    state: async () => (await fetch(`http://127.0.0.1:${port}/state`)).json(),
    stop: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  };
}
