import { useEffect } from 'react';
import type { AppProps } from 'next/app';
import { PrivyProvider } from '@privy-io/react-auth';
import { ThemeProvider } from '../shared/lib/theme-context';
import '../styles/globals.css';

const CHUNK_ERROR_RE = /loading chunk .* failed|chunkloaderror|failed to fetch dynamically imported module/i;
const RELOAD_GUARD_KEY = 'chunk-error-reload-at';

// Privy's embedded-wallet UI (auth.privy.io) lazy-loads JS chunks on demand. If a tab has
// been open across a Privy deploy, those chunk URLs 404 and surface as an uncaught
// "Loading chunk N failed" error anywhere Privy renders its iframe. The only real fix is a
// fresh page load to pick up the current chunk manifest; this is a one-shot, debounced
// auto-reload so it doesn't loop if the failure is persistent (e.g. offline).
function handlePossibleChunkError(err: unknown) {
  const msg = String((err as any)?.message ?? err ?? '');
  if (!CHUNK_ERROR_RE.test(msg)) return;
  const last = Number(sessionStorage.getItem(RELOAD_GUARD_KEY) || 0);
  if (Date.now() - last < 10000) return;
  sessionStorage.setItem(RELOAD_GUARD_KEY, String(Date.now()));
  window.location.reload();
}

export default function App({ Component, pageProps }: AppProps) {
  useEffect(() => {
    const onError = (e: ErrorEvent) => handlePossibleChunkError(e.error ?? e.message);
    const onRejection = (e: PromiseRejectionEvent) => handlePossibleChunkError(e.reason);
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
    return () => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
    };
  }, []);

  return (
    <ThemeProvider>
      <PrivyProvider
        appId={process.env.NEXT_PUBLIC_PRIVY_APP_ID!}
        config={{
          loginMethods: ['email'],              // simple for demo
          embeddedWallets: {
            ethereum: { createOnLogin: 'all-users' },
            solana: { createOnLogin: 'all-users' },
          },
        }}
      >
        <Component {...pageProps} />
      </PrivyProvider>
    </ThemeProvider>
  );
}
