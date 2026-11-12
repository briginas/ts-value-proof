import path from "node:path";
import type { Plugin } from "vite";
import { prepareSource, type PreparedSource } from "../scripts/adapter.ts";
import { verifyPrepared, type SolverLimits } from "../scripts/verifier.ts";
import { assertCurrentInputs, eraseContracts } from "../scripts/contract-erasure.ts";
import { canonicalFile, isContractModule } from "../scripts/source-graph.ts";

export type ValueProofOptions = {
  /** Verification roots, relative to Vite's root. Their dependencies are included. */
  entries: string[];
  limits?: SolverLimits;
};

/** Verify selected TS graphs and erase their contracts during production builds. */
export function valueProof(options: ValueProofOptions): Plugin {
  if (!options || !Array.isArray(options.entries) || !options.entries.length ||
      options.entries.some(entry => typeof entry !== "string" || !entry.trim()))
    throw new Error("valueProof requires a non-empty entries array of TypeScript paths");
  const entries = [...options.entries];
  const limits = { ...options.limits };
  let root = process.cwd();
  type Module = { snapshot: PreparedSource; source: PreparedSource["sources"][number] };
  const modules = new Map<string, Module>();
  const inputs = new Map<string, string | undefined>();
  let ready = false;

  function moduleFor(id: string): Module | undefined {
    if (id.startsWith("\0")) return;
    const file = canonicalFile(id.split(/[?#]/, 1)[0]);
    const module = modules.get(file);
    if ((module || isContractModule(file)) && /[?#]/.test(id))
      throw new Error(`Unsupported query/hash on a verified module: ${id}`);
    return module;
  }
  return {
    name: "ts-value-proof",
    apply: "build",
    enforce: "pre",
    configResolved(config) { root = config.root; },
    async buildStart() {
      ready = false;
      modules.clear();
      inputs.clear();
      for (const entry of entries) {
        const input = path.resolve(root, entry);
        this.addWatchFile(input);
        const snapshot = prepareSource(input, file => this.addWatchFile(file));
        for (const [file, text] of snapshot.inputs) {
          this.addWatchFile(file);
          if (inputs.has(file) && inputs.get(file) !== text)
            this.error(`Verification source mismatch between entry points: ${file}`);
          inputs.set(file, text);
        }
        const report = await verifyPrepared(snapshot, limits);
        if (report.status !== "verified")
          this.error(`Contract verification ${report.status}: ${input}\n${JSON.stringify(report, null, 2)}`);
        for (const source of snapshot.sources) modules.set(canonicalFile(source.fileName), { snapshot, source });
      }
      assertCurrentInputs(inputs);
      ready = true;
    },
    resolveId: {
      order: "pre",
      handler(specifier, importer) {
        if (!ready || !importer) return;
        const module = moduleFor(importer);
        const target = module?.snapshot.edges.get(canonicalFile(module.source.fileName))?.get(specifier);
        if (target && !isContractModule(target)) return target;
      },
    },
    load(id) {
      moduleFor(id); // Reject resource-query variants before another loader can consume them.
      if (isContractModule(id))
        this.error(`Contract API reached the production bundle: ${id}. Include its callers in valueProof entries.`);
    },
    transform: {
      order: "pre",
      handler(code, id) {
        const module = moduleFor(id);
        if (!module) return;
        if (!ready) this.error("Contract verification has not completed");
        return eraseContracts(module.snapshot, module.source, code);
      },
    },
    generateBundle() {
      if (!ready) this.error("Contract verification has not completed");
      for (const id of this.getModuleIds()) {
        const info = this.getModuleInfo(id);
        if (info?.code == null && (id === "ts-value-proof" || isContractModule(id) || moduleFor(id)))
          this.error(`Verified modules and the contract API cannot be external: ${id}`);
        if (info?.code != null && moduleFor(id)) {
          for (const dependency of info.importedIds)
            if (this.getModuleInfo(dependency)?.code == null)
              this.error(`Verified module dependency cannot be external: ${dependency}`);
        }
      }
      assertCurrentInputs(inputs);
    },
  };
}

export default valueProof;
