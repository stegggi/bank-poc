// Privy's embedded-wallet UI (auth.privy.io) lazy-loads JS chunks the first time it
// needs to render a sign/confirm prompt. If that chunk 404s — e.g. the tab has been open
// across a Privy deploy and the browser still references a retired build — the SDK call
// (getEthereumProvider/sendTransaction) rejects with a raw "Loading chunk N failed" error
// before anything is ever signed, so it's always safe to retry once.
function collectMessages(e: any, depth = 0): string[] {
  if (!e || depth > 4) return [];
  const msgs: string[] = [];
  if (typeof e === "string") msgs.push(e);
  if (e?.message) msgs.push(String(e.message));
  if (e?.shortMessage) msgs.push(String(e.shortMessage));
  if (e?.error) msgs.push(...collectMessages(e.error, depth + 1));
  if (e?.info?.error) msgs.push(...collectMessages(e.info.error, depth + 1));
  if (e?.cause) msgs.push(...collectMessages(e.cause, depth + 1));
  return msgs;
}

export function isChunkLoadError(e: any): boolean {
  const msg = collectMessages(e).join(" ");
  return /loading chunk .* failed|chunkloaderror|failed to fetch dynamically imported module|importing a module script failed/i.test(msg);
}

export function formatTxError(e: any): string {
  if (isChunkLoadError(e)) {
    return "Wallet sign-in module failed to load (stale cache). Please refresh this page and try again.";
  }
  return e?.shortMessage || e?.message || String(e);
}

export async function withChunkRetry<T = any>(fn: () => Promise<T>, retries = 1, delayMs = 800): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (retries > 0 && isChunkLoadError(e)) {
      await new Promise((r) => setTimeout(r, delayMs));
      return withChunkRetry(fn, retries - 1, delayMs);
    }
    throw e;
  }
}
