import type { NextApiRequest, NextApiResponse } from 'next';
import { ethers } from 'ethers';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    if (req.method !== 'POST') return res.status(405).end('Use POST');

    const { to } = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
    if (!to || !/^0x[0-9a-fA-F]{40}$/.test(to)) return res.status(400).json({ error: 'Bad address' });

    const rpc = process.env.NEXT_PUBLIC_RPC_URL!;
    const pk  = process.env.BANK_FUNDER_PK!;
    const amt = BigInt(process.env.WELCOME_WEI || '200000000000000'); // 0.0002

    if (!rpc || !pk) return res.status(500).json({ error: 'Server missing RPC or BANK_FUNDER_PK' });

    const provider = new ethers.JsonRpcProvider(rpc);
    const funder   = new ethers.Wallet(pk, provider);

    // Optional: micro rate-limit / idempotency could be added here for prod.
    const tx = await funder.sendTransaction({ to, value: amt });
    const rc = await tx.wait();
    return res.status(200).json({ hash: rc?.hash ?? tx.hash });
  } catch (e: any) {
    console.error('grant error', e);
    return res.status(500).json({ error: e?.message ?? String(e) });
  }
}
