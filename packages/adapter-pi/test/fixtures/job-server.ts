/**
 * M5 job-server fixture: a local async provider whose jobs complete after a
 * delay. POST /js (submissions counted once per job), GET /js/:id, GET /state.
 */
import { createServer, type Server } from "node:http";
import { performance } from "node:perf_hooks";

export interface JobServer {
  baseUrl: string;
  submissions: () => number;
  completed: () => boolean;
  stop: () => Promise<void>;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function startJobServer(completeAfterMs = 1_500): Promise<JobServer> {
  let submissions = 0;
  let completed = false;
  const jobs = new Map<string, { submittedAt: number }>();
  let nextId = 0;

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "POST" && url.pathname === "/js") {
      nextId += 1;
      submissions += 1;
      const jobId = `job-${nextId}`;
      jobs.set(jobId, { submittedAt: performance.now() });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jobId }));
      return;
    }
    const match = url.pathname.match(/^\/js\/(.+)$/);
    if (req.method === "GET" && match !== null) {
      const jobId = decodeURIComponent(match[1] ?? "");
      const job = jobs.get(jobId);
      if (job === undefined) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "unknown job" }));
        return;
      }
      if (performance.now() - job.submittedAt >= completeAfterMs) {
        completed = true;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "complete", result: `job ${jobId} finished: 42` }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "pending" }));
      return;
    }
    if (req.method === "GET" && url.pathname === "/state") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ submissions, completed }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no listen address");
  void sleep(0);
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    submissions: () => submissions,
    completed: () => completed,
    stop: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
