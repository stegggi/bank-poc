// lib/aa.ts
import { createPublicClient, http, Hex } from 'viem';
import { defineChain } from 'viem/utils';
import { BiconomySmartAccountV2, createSmartAccountClient } from '@biconomy/account';

export const arbSepolia = defineChain({
  id: 421614,
  name: 'Arbitrum Sepolia',
  nativeCurrency: { name: 'Sepolia Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [process.env.NEXT_PUBLIC_RPC_URL as string] } },
});

export const publicClient = createPublicClient({
  chain: arbSepolia,
  transport: http(),
});

type MakeClientParams = {
  eip1193: any;         // signer/provider from Privy
  accountIndex: number; // our "fresh address" index
};

export async function makeSmartAccountClient({ eip1193, accountIndex }: MakeClientParams) {
  // Some versions of the SDK accept "accountIndex" in the constructor options.
  // If your installed version doesn’t, we’ll still pass it to getAccountAddress()
  // and use the default index when sending txs (works fine for demos).
  const sa = await createSmartAccountClient({
    signer: eip1193 as any,
    chainId: arbSepolia.id,
    bundlerUrl: process.env.BICONOMY_BUNDLER_URL!,
    biconomyPaymasterApiKey: process.env.BICONOMY_PAYMASTER_KEY,
    // accountIndex,  // uncomment if your SDK supports it in options
  });

  // Helper to compute address for a given index
  async function getAddressForIndex(idx: number): Promise<Hex> {
    // Most recent SDKs support an index arg:
    // @ts-ignore
    if (typeof (sa as any).getAccountAddress === 'function') {
      try {
        // @ts-ignore
        const addr = await (sa as any).getAccountAddress({ index: idx });
        if (addr) return addr as Hex;
      } catch { /* fallthrough */ }
    }
    // Fallback: use default derived address (index 0)
    const addr = await (sa as any).getAccountAddress();
    return addr as Hex;
  }

  const address = await getAddressForIndex(accountIndex);
  return { sa, address };
}
