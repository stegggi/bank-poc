import type { AppProps } from 'next/app';
import { PrivyProvider } from '@privy-io/react-auth';

export default function App({ Component, pageProps }: AppProps) {
  return (
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
  );
}
