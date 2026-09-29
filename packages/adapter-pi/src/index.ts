/**
 * @relay/adapter-pi — the only Relay package allowed to reference Pi.
 *
 * Exposes the Relay capability doctor as a Pi extension command:
 *
 *   /relay:doctor
 *
 * Public Pi 0.87.0 APIs used (nothing else, no monkey-patching, no Pi session
 * emulation):
 *   - default extension factory receiving `ExtensionAPI`
 *     (docs/extensions.md "Writing an Extension"; loadable via `pi -e`,
 *     `pi install`, settings `extensions`, or `.pi/extensions`)
 *   - `pi.registerCommand(name, { description, handler })`
 *     (docs/extensions.md "ExtensionAPI Methods")
 *   - handler context `ExtensionCommandContext` fields: `mode`, `cwd`, `ui.notify`
 *     (docs/extensions.md "ExtensionContext")
 *   - `VERSION` export for best-effort host version reporting
 *     (dist/index.d.ts of @earendil-works/pi-coding-agent)
 */
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  RELAY_VERSION,
  formatDoctorReport,
  runDoctor,
  type DoctorProbeSpec,
  type ProbeOutcome,
} from "@relay/core";
import { probeSqliteStorage } from "@relay/storage-sqlite";
import { probeArtifactRoot } from "@relay/artifact-fs";

export const RELAY_DOCTOR_COMMAND = "relay:doctor";

export interface RelayExtensionOutput {
  write(chunk: string): void;
}

export interface RelayExtensionOptions {
  /** Override the environment probes (used by tests). */
  probes?: DoctorProbeSpec[];
  /** Override where print/json-mode reports are written (used by tests). */
  output?: RelayExtensionOutput;
}

async function probePiHost(): Promise<ProbeOutcome> {
  try {
    const mod = (await import("@earendil-works/pi-coding-agent")) as { VERSION?: string };
    if (typeof mod.VERSION === "string" && mod.VERSION.length > 0) {
      return { status: "ok", detail: `pi ${mod.VERSION} extension host active` };
    }
  } catch {
    // Version introspection is best-effort; the host is clearly running.
  }
  return { status: "ok", detail: "pi extension host active (version unknown)" };
}

function defaultProbes(cwd: string): DoctorProbeSpec[] {
  const storagePath = join(cwd, ".relay", "storage.db");
  const artifactRoot = join(cwd, ".relay", "artifacts");
  return [
    { id: "pi", label: "Pi host", run: probePiHost },
    { id: "storage", label: "SQLite storage", run: () => probeSqliteStorage({ path: storagePath }) },
    { id: "artifacts", label: "Artifact root", run: () => probeArtifactRoot({ root: artifactRoot }) },
  ];
}

/**
 * Builds the Pi extension factory. The default export is the factory itself,
 * so Pi loads this module directly as an extension.
 */
export function createRelayExtension(options: RelayExtensionOptions = {}) {
  return function relayPiExtension(pi: ExtensionAPI): void {
    pi.registerCommand(RELAY_DOCTOR_COMMAND, {
      description: "Run the Relay capability doctor (pi/storage/artifacts probes)",
      handler: async (_args: string, ctx: ExtensionCommandContext): Promise<void> => {
        const probes = options.probes ?? defaultProbes(ctx.cwd);
        const result = await runDoctor({
          relayVersion: RELAY_VERSION,
          context: { cwd: ctx.cwd },
          probes,
        });
        const text = formatDoctorReport(result);
        if (ctx.mode === "print" || ctx.mode === "json") {
          const out = options.output ?? process.stdout;
          out.write(`${text}\n`);
        } else {
          const tone: "info" | "warning" | "error" =
            result.summary === "ok" ? "info" : result.summary === "warn" ? "warning" : "error";
          ctx.ui.notify(text, tone);
        }
      },
    });
  };
}

export default createRelayExtension();
export { PiTaskAdapter, type PiTaskAdapterOptions } from "./task-adapter.js";
export {
  createMockDeferredProvider,
  discoverDeferred,
  mockDeferredModel,
  MOCK_API,
  MOCK_MODEL_ID,
  MOCK_PROVIDER_ID,
  type DiscoveredDeferred,
  type MockDeferredProviderOptions,
} from "./deferred.js";
