import type { Uc4BankId } from "./blobRefStore";

export type Uc4ReadSource = "query_bundle" | "server_bundle" | "query_legacy_pair" | "server_legacy_pair" | "missing";
export type Uc4WriteKind = "bundle_put" | "legacy_context_put" | "legacy_dek_put";

type MetricsState = {
  readsTotal: number;
  writesTotal: number;
  readsByKey: Record<string, number>;
  writesByKey: Record<string, number>;
  updatedAtIso: string;
};

const METRICS_KEY = "__UC4_BLOB_METRICS__";

function getState(): MetricsState {
  const g = globalThis as unknown as Record<string, MetricsState | undefined>;
  if (!g[METRICS_KEY]) {
    g[METRICS_KEY] = {
      readsTotal: 0,
      writesTotal: 0,
      readsByKey: {},
      writesByKey: {},
      updatedAtIso: new Date().toISOString(),
    };
  }
  return g[METRICS_KEY] as MetricsState;
}

function incCounter(bucket: Record<string, number>, key: string) {
  bucket[key] = (bucket[key] ?? 0) + 1;
}

export function recordUc4Read(bank: Uc4BankId, source: Uc4ReadSource) {
  const state = getState();
  state.readsTotal += 1;
  incCounter(state.readsByKey, `${bank}:${source}`);
  state.updatedAtIso = new Date().toISOString();

  // Lightweight periodic log for visibility without excessive noise.
  if (state.readsTotal % 20 === 0) {
    console.info("[uc4/blob-metrics] read-snapshot", {
      readsTotal: state.readsTotal,
      writesTotal: state.writesTotal,
      readsByKey: state.readsByKey,
      writesByKey: state.writesByKey,
      updatedAtIso: state.updatedAtIso,
    });
  }
}

export function recordUc4Write(bank: Uc4BankId, kind: Uc4WriteKind) {
  const state = getState();
  state.writesTotal += 1;
  incCounter(state.writesByKey, `${bank}:${kind}`);
  state.updatedAtIso = new Date().toISOString();

  if (state.writesTotal % 20 === 0) {
    console.info("[uc4/blob-metrics] write-snapshot", {
      readsTotal: state.readsTotal,
      writesTotal: state.writesTotal,
      readsByKey: state.readsByKey,
      writesByKey: state.writesByKey,
      updatedAtIso: state.updatedAtIso,
    });
  }
}
