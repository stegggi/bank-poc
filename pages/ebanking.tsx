// pages/ebanking.tsx
import { useEffect, useMemo, useRef, useState } from 'react';
import { usePrivy, useWallets } from '@privy-io/react-auth';
import { BrowserProvider } from 'ethers';
import { encodeFunctionData, formatEther, getAddress } from 'viem';
import { useRouter } from 'next/router';
import { publicClient } from '../shared/lib/aa';
import NavBar from '../shared/components/NavBar';

const CHAIN_ID = 421614; // Arbitrum Sepolia
const DEMO_ETH_CHF = 2000;

const ERC20_MIN_ABI = [
  {
    inputs: [
      { internalType: 'address', name: 'spender', type: 'address' },
      { internalType: 'uint256', name: 'value', type: 'uint256' },
    ],
    name: 'approve',
    outputs: [{ internalType: 'bool', name: '', type: 'bool' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  { inputs: [], name: 'buy', outputs: [], stateMutability: 'nonpayable', type: 'function' },
  {
    inputs: [{ internalType: 'address', name: 'owner', type: 'address' }],
    name: 'balanceOf',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  { inputs: [], name: 'symbol', outputs: [{ internalType: 'string', name: '', type: 'string' }], stateMutability: 'view', type: 'function' },
];

const XBANK = process.env.NEXT_PUBLIC_XBANK_ADDRESS as `0x${string}` | undefined;
const RPC = process.env.NEXT_PUBLIC_RPC_URL;

export default function EBanking() {
  const router = useRouter();
  // NOTE: pull createWallet from usePrivy
  const { ready, authenticated, login, logout, createWallet } = usePrivy() as any;
  const { wallets } = useWallets();

  const [bankLoggedIn, setBankLoggedIn] = useState(false);
  const [passwordInput, setPasswordInput] = useState('');
  const [status, setStatus] = useState('');
  const [eoa, setEoa] = useState<string>('');
  const [ethBal, setEthBal] = useState<bigint>(BigInt(0));
  const [xbBal, setXbBal] = useState<bigint>(BigInt(0));
  const [xbSymbol, setXbSymbol] = useState<string>('XBANK');

  const grantInFlight = useRef(false);
  const initInFlight = useRef(false);

  const walletsRef = useRef<any[]>([]);
  useEffect(() => {
    walletsRef.current = (wallets as any[]) || [];
  }, [wallets]);

  const short = (a?: string) => (a ? a.slice(0, 6) + '…' + a.slice(-4) : '');
  const arbiscanAddr = (addr: string) => `https://sepolia.arbiscan.io/address/${addr}`;

  const checkingChf = useMemo(() => 12345.55, []);
  const savingChf = useMemo(() => 38500.1, []);

  const ensureSepolia = async (eip1193: any) => {
    try {
      await eip1193.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x66eee' }] });
    } catch (err: any) {
      if (err?.code === 4902 && RPC) {
        await eip1193.request({
          method: 'wallet_addEthereumChain',
          params: [
            {
              chainId: '0x66eee',
              chainName: 'Arbitrum Sepolia',
              nativeCurrency: { name: 'Sepolia Ether', symbol: 'ETH', decimals: 18 },
              rpcUrls: [RPC],
              blockExplorerUrls: ['https://sepolia.arbiscan.io'],
            },
          ],
        });
      }
    }
  };

  // Wait for an address; create the wallet if none exists
  const waitForEOAAddress = async (maxMs = 60000): Promise<`0x${string}`> => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const tryGetAddress = async () => {
      const list = walletsRef.current || [];
      const w: any =
        list.find((x: any) => typeof x?.address === 'string' && x.address.startsWith('0x')) ||
        list.find((x: any) => typeof x?.address === 'function');
      let addr: string | undefined;
      if (w?.address && typeof w.address === 'string') addr = w.address;
      if (!addr && typeof w?.address === 'function') {
        try {
          addr = await w.address();
        } catch {}
      }
      return addr && /^0x[0-9a-fA-F]{40}$/.test(addr) ? (getAddress(addr) as `0x${string}`) : undefined;
    };

    // If there are no wallets at all, proactively create one
    if (!walletsRef.current?.length && typeof createWallet === 'function') {
      setStatus('Creating your embedded wallet…');
      try {
        await createWallet();
      } catch (e: any) {
        // If this fails, still continue to poll; the dashboard policy might auto-create shortly.
        setStatus(`Creating wallet… ${e?.message ?? 'retrying'}`);
      }
    }

    const end = Date.now() + maxMs;
    while (Date.now() < end) {
      const addr = await tryGetAddress();
      if (addr) return addr;
      await sleep(300);
    }
    throw new Error('Wallet address not available yet (timeout).');
  };

  const waitForEmbeddedProvider = async (maxMs = 60000) => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const end = Date.now() + maxMs;
    while (Date.now() < end) {
      const list = walletsRef.current || [];
      const embedded =
        list.find(
          (w: any) =>
            typeof w?.getEthereumProvider === 'function' &&
            (w?.chainId === 'eip155:421614' || w?.meta?.chainId === 'eip155:421614')
        ) || list.find((w: any) => typeof w?.getEthereumProvider === 'function');
      if (embedded) return embedded.getEthereumProvider();
      await sleep(300);
    }
    throw new Error('No embedded Privy wallet found (timeout).');
  };

  const refreshBalances = async (addr: `0x${string}`) => {
    try {
      const b = await publicClient.getBalance({ address: addr });
      setEthBal(b);
    } catch {}
    try {
      if (XBANK && /^0x[0-9a-fA-F]{40}$/.test(XBANK)) {
        const bal = (await publicClient.readContract({
          address: XBANK,
          abi: ERC20_MIN_ABI as any,
          functionName: 'balanceOf',
          args: [addr],
        })) as bigint;
        setXbBal(bal);
        const sym = (await publicClient.readContract({
          address: XBANK,
          abi: ERC20_MIN_ABI as any,
          functionName: 'symbol',
          args: [],
        })) as string;
        if (typeof sym === 'string') setXbSymbol(sym);
      }
    } catch {}
  };

  const grantWelcomeIfLow = async (addr: `0x${string}`) => {
    if (grantInFlight.current) return;
    grantInFlight.current = true;
    try {
      const b = await publicClient.getBalance({ address: addr });
      const threshold = BigInt('20000000000000'); // ~0.00002
      if (b < threshold) {
        setStatus('Bank is sponsoring a small gas top-up…');
        const r = await fetch('/api/grant', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ to: addr }),
        });
        const j = await r.json();
        if (!r.ok) throw new Error(j?.error || 'Welcome grant failed');
        setStatus(`Welcome ETH tx: ${j.hash}`);
        setTimeout(() => refreshBalances(addr), 1500);
      }
    } catch (e: any) {
      setStatus(`Welcome grant error: ${e?.message ?? e}`);
    } finally {
      grantInFlight.current = false;
    }
  };

  const onBankLogin = () => {
    if (passwordInput.trim() === 'finalix') {
      setBankLoggedIn(true);
      setStatus('');
    } else {
      setStatus('Wrong password (hint: finalix).');
    }
  };

  const initAfterAuth = async () => {
    if (initInFlight.current) return;
    initInFlight.current = true;
    try {
      setStatus('Preparing your wallet…');
      const addr = await waitForEOAAddress(60000);
      setEoa(addr);
      await grantWelcomeIfLow(addr);
      await refreshBalances(addr);
      setStatus('Wallet created. Finalizing…');

      // Warm up provider in background
      try {
        const eip1193 = await waitForEmbeddedProvider(60000);
        await ensureSepolia(eip1193);
        const ethersProvider = new BrowserProvider(eip1193);
        await ethersProvider.getSigner();
        setStatus('Wallet ready.');
      } catch {
        setStatus('Wallet is initializing. If actions fail, wait a moment and try again.');
      }
    } catch (e: any) {
      setStatus(`Login failed: ${e?.message ?? e}`);
    } finally {
      initInFlight.current = false;
    }
  };

  const onLoginOrOpen = async () => {
    try {
      if (!authenticated) {
        setStatus('Opening Privy login…');
        await login();
        return;
      }
      await initAfterAuth();
    } catch (e: any) {
      setStatus(`Login failed: ${e?.message ?? e}`);
    }
  };

  useEffect(() => {
    if (!bankLoggedIn) return;
    if (ready && authenticated && !eoa) {
      initAfterAuth();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, authenticated, bankLoggedIn, eoa]);

  const onBuyXBank = async () => {
    try {
      if (!authenticated) return setStatus('Please open the wallet first.');
      if (!XBANK || !/^0x[0-9a-fA-F]{40}$/.test(XBANK)) return setStatus('XBANK address missing/invalid (.env).');

      const eip1193 = await waitForEmbeddedProvider(60000);
      await ensureSepolia(eip1193);
      const ethersProvider = new BrowserProvider(eip1193);
      const signer = await ethersProvider.getSigner();

      const data = encodeFunctionData({ abi: ERC20_MIN_ABI as any, functionName: 'buy', args: [] });
      setStatus('Buying 100 XBANK…');
      const tx = await signer.sendTransaction({ to: XBANK, data });
      setStatus(`Submitted. Waiting… ${short(tx.hash)}`);
      const rec = await tx.wait();

      if (eoa) await refreshBalances(eoa as `0x${string}`);
      setStatus(`Purchase successful! Tx: ${rec?.hash ?? tx.hash}`);
    } catch (e: any) {
      setStatus(`Purchase failed: ${e?.message ?? e}`);
    }
  };

  const onGoTransact = () => router.push('/bank-a');

  const onEbankingLogout = async () => {
    try {
      await logout();
    } catch {}
    setBankLoggedIn(false);
    setEoa('');
    setEthBal(BigInt(0));
    setXbBal(BigInt(0));
    setStatus('Signed out.');
    router.push('/');
  };

  useEffect(() => {
    if (!authenticated || !eoa) return;
    refreshBalances(eoa as `0x${string}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authenticated, eoa]);

  if (!ready)
    return (
      <>
        <NavBar active="ebanking" />
        <div style={{ padding: 24 }}>Loading…</div>
      </>
    );

  return (
    <>
      <NavBar active="ebanking" />
      <div style={{ padding: 24, maxWidth: 900, margin: '0 auto' }}>
        <h2>eBanking</h2>

        {!bankLoggedIn ? (
          <div style={panel}>
            <h3>Bank login</h3>
            <p>Please enter the password to open your eBanking.</p>
            <input
              type="password"
              placeholder="Password (finalix)"
              value={passwordInput}
              onChange={(e) => setPasswordInput(e.target.value)}
              style={{ width: '100%', padding: 8, marginBottom: 8 }}
            />
            <button onClick={onBankLogin}>Login</button>
            {status && <p style={{ marginTop: 8 }}>{status}</p>}
          </div>
        ) : (
          <>
            <div style={grid}>
              <div style={card}>
                <h3>Checking (CHF)</h3>
                <p style={bigAmount}>
                  {checkingChf.toLocaleString('en-CH', { style: 'currency', currency: 'CHF' })}
                </p>
                <small>IBAN: CHxx 1234 5678 9012 3456 7</small>
              </div>
              <div style={card}>
                <h3>Saving (CHF)</h3>
                <p style={bigAmount}>
                  {savingChf.toLocaleString('en-CH', { style: 'currency', currency: 'CHF' })}
                </p>
                <small>IBAN: CHxx 7654 3210 9876 5432 1</small>
              </div>
            </div>

            <div style={panel}>
              <h3>Crypto Wallet (EVM) </h3>

              {!authenticated ? (
                <button onClick={onLoginOrOpen}>Log-in or create wallet</button>
              ) : (
                <>
                  <p>
                    <strong>Wallet Address:</strong>{' '}
                    {eoa ? (
                      <>
                        <span style={{ fontFamily: 'monospace' }}>{eoa}</span>{' '}
                        <a href={arbiscanAddr(eoa)} target="_blank" rel="noreferrer">
                          Arbiscan
                        </a>
                      </>
                    ) : (
                      '…'
                    )}
                  </p>

                  <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
                    <div>
                      <div>
                        <small>ETH balance</small>
                      </div>
                      <div style={{ fontFamily: 'monospace', fontSize: 18 }}>
                        {Number(formatEther(ethBal)).toFixed(6)} ETH
                      </div>
                    </div>
                    <div>
                      <div>
                        <small>~ CHF value</small>
                      </div>
                      <div style={{ fontSize: 18 }}>
                        {(Number(formatEther(ethBal)) * DEMO_ETH_CHF).toLocaleString('en-CH', {
                          style: 'currency',
                          currency: 'CHF',
                        })}
                      </div>
                    </div>
                    <div>
                      <div>
                        <small>{xbSymbol} balance</small>
                      </div>
                      <div style={{ fontSize: 18 }}>{(Number(xbBal) / 1e18).toLocaleString('en-CH')}</div>
                    </div>
                  </div>

                  <div style={{ marginTop: 12, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                    <button onClick={onBuyXBank}>Buy 100 xBank stablecoin</button>
                    <button onClick={onGoTransact}>Interbank payment transfer</button>
                    <button onClick={onEbankingLogout} style={{ marginLeft: 'auto', opacity: 0.7 }}>
                      Logout from eBanking
                    </button>
                  </div>
                </>
              )}

              {status && <p style={{ marginTop: 8 }}>{status}</p>}
            </div>
          </>
        )}

        {/* ✅ Updated: Why this matters (premium + logical narrative) */}
        <WhyThisMatters />
      </div>
    </>
  );
}

/* ---------- Updated Section Component ---------- */

function WhyThisMatters() {
  const [open, setOpen] = useState(false);
  const innerRef = useRef<HTMLDivElement | null>(null);
  const [maxH, setMaxH] = useState(0);

  useEffect(() => {
    const update = () => {
      if (!innerRef.current) return;
      setMaxH(open ? innerRef.current.scrollHeight : 0);
    };
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [open]);

  return (
    <div style={whyStickyWrap}>
      <div style={whyShell}>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          style={whyHeaderBtn}
        >
          <span style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
            <span style={whyBadge}>Why this matters</span>
            <span style={whyTitle}>
              Issue a crypto wallet that feels like banking — and settles on-chain
            </span>
          </span>

          <span style={whyRight}>
            <span style={whyHint}>{open ? 'Hide' : 'Show'}</span>
            <span style={{ ...chevWrap, transform: open ? 'rotate(180deg)' : 'rotate(0deg)' }}>
              <Chevron />
            </span>
          </span>
        </button>

        <div
          style={{
            ...whyBodyOuter,
            maxHeight: open ? maxH : 0,
            opacity: open ? 1 : 0,
            transform: open ? 'translateY(0px)' : 'translateY(-4px)',
          }}
        >
          <div ref={innerRef} style={whyBodyInner}>
            {/* 1) Experience */}
            <Section
              k="1"
              title="What you experience (non-technical)"
              subtitle="It looks and feels like normal eBanking — but you end up with a real blockchain wallet."
            >
              <ul style={whyList}>
                <li>
                  You log in, click one button, and you have a <strong>seedless embedded wallet</strong>.
                </li>
                <li>
                  You see a <strong>real wallet address</strong> (EOA) and balances you can verify on the explorer.
                </li>
                <li>
                  You “buy” xBank and the balance updates because an <strong>actual on-chain action</strong> happened.
                </li>
              </ul>
            </Section>

            {/* 2) Building blocks */}
            <Section
              k="2"
              title="What’s happening technically (in plain English)"
              subtitle="Three moving pieces: identity, wallet control, and a chain connection."
            >
              <div style={whyGrid2}>
                <div style={whyCard}>
                  <div style={whyCardTitle}>Identity + wallet UX (Privy)</div>
                  <div style={whyText}>
                    Privy (TPP) handles authentication and creates the embedded wallet. The app waits until an address exists
                    and then issues some "welcome" ETH for first-time users.
                  </div>
                  <div style={pillRow}>
                    <span style={pill}>Privy</span>
                    <span style={pill}>Embedded wallet</span>
                  </div>
                </div>

                <div style={whyCard}>
                  <div style={whyCardTitle}>Network correctness (Arbitrum Sepolia)</div>
                  <div style={whyText}>
                    The UI ensures the wallet is pointed at the right test chain using{' '}
                    <code style={whyCode}>wallet_switchEthereumChain</code> (and can add the chain if missing).
                  </div>
                  <div style={pillRow}>
                    <span style={pill}>Chain safety</span>
                    <span style={pill}>No “wrong network” traps</span>
                  </div>
                </div>
              </div>
            </Section>

            {/* 3) On-chain actions */}
            <Section
              k="3"
              title="What goes on-chain on this page"
              subtitle="This page proves the core blockchain promise: the balances you show match the ledger you don’t control."
            >
              <div style={whyGrid2}>
                <div style={whyCard}>
                  <div style={whyCardTitle}>Reads (no tx)</div>
                  <ul style={whyList}>
                    <li>
                      ETH balance is read directly from the chain (no database).
                    </li>
                    <li>
                      xBank token balance is read via <code style={whyCode}>balanceOf(address)</code>.
                    </li>
                  </ul>
                </div>

                <div style={whyCard}>
                  <div style={whyCardTitle}>Writes (transactions)</div>
                  <ul style={whyList}>
                    <li>
                      <strong>Sponsored gas top-up</strong> (demo): if your wallet is newly created, the app calls{' '}
                      <code style={whyCode}>/api/grant</code> to send a tiny amount of "welcome" ETH.
                    </li>
                    <li>
                      <strong>xBank purchase</strong>: clicking “Buy 100 xBank” sends a tx to the xBank ERC-20 contract’s{' '}
                      <code style={whyCode}>buy()</code>.
                    </li>
                  </ul>
                </div>
              </div>

              <div style={bannerNote}>
                <strong>Why it matters:</strong> the “bank UI” is no longer the source of truth — the chain is.
              </div>
            </Section>

            {/* 4) Why banks care */}
            <Section
              k="4"
              title="Why banks should care (compliance & business)"
              subtitle="This is the onboarding layer that makes regulated on-chain finance usable for normal customers."
            >
              <div style={whyGrid2}>
                <div style={whyCard}>
                  <div style={whyCardTitle}>Regulatory lens</div>
                  <ul style={whyList}>
                    <li>
                      A real rollout binds wallet issuance to a <strong>KYC’d</strong> session (the demo password stands in
                      for that).
                    </li>
                    <li>
                      Banks need a clean foundation before Travel Rule messaging: <strong>who owns the address</strong>, and
                      who the bank can vouch for.
                    </li>
                  </ul>
                </div>

                <div style={whyCard}>
                  <div style={whyCardTitle}>Operational lens</div>
                  <ul style={whyList}>
                    <li>
                      <strong>Fewer user failures</strong>: gas sponsorship avoids “insufficient ETH” support tickets.
                    </li>
                    <li>
                      The demo uses a simple grant today — production typically uses an <strong>EIP-4337 Paymaster</strong>{' '}
                      so users can transact without holding ETH at all.
                    </li>
                  </ul>
                </div>
              </div>

              <div style={nextStep}>
                <div style={{ fontWeight: 950, marginBottom: 4 }}>What it unlocks next</div>
                <div style={{ color: '#333', lineHeight: 1.5 }}>
                  Once the customer has a wallet & assets, the bank can enable interbank transfers, DeFi access, and more.
                </div>
              </div>
            </Section>
          </div>
        </div>
      </div>
    </div>
  );
}

function Section({
  k,
  title,
  subtitle,
  children,
}: {
  k: string;
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <div style={secWrap}>
      <div style={secHead}>
        <div style={secK}>{k}</div>
        <div style={{ minWidth: 0 }}>
          <div style={secTitle}>{title}</div>
          <div style={secSub}>{subtitle}</div>
        </div>
      </div>
      <div style={{ marginTop: 10 }}>{children}</div>
    </div>
  );
}

function Chevron() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/* ---------- Existing Styles ---------- */

const panel: React.CSSProperties = { border: '1px solid #e6e8eb', borderRadius: 14, padding: 16, background: '#fff' };
const grid: React.CSSProperties = { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, margin: '12px 0 20px' };
const card: React.CSSProperties = { border: '1px solid #eee', borderRadius: 14, padding: 16, background: '#fff' };
const bigAmount: React.CSSProperties = { fontSize: 24, margin: 0 };

/* ---------- Updated "Why this matters" Premium Styles ---------- */

const whyStickyWrap: React.CSSProperties = {
  marginTop: 18,
  position: 'sticky',
  bottom: 14,
  zIndex: 20,
};

const whyShell: React.CSSProperties = {
  border: '1px solid #e6e8eb',
  borderRadius: 16,
  overflow: 'hidden',
  background: 'rgba(255,255,255,0.88)',
  backdropFilter: 'blur(10px)',
  boxShadow: '0 10px 24px rgba(0,0,0,0.06)',
};

const whyHeaderBtn: React.CSSProperties = {
  width: '100%',
  border: 'none',
  background: 'transparent',
  padding: 14,
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 12,
};

const whyBadge: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  padding: '4px 10px',
  borderRadius: 999,
  background: '#111',
  color: '#fff',
  fontWeight: 900,
  fontSize: 12,
  flex: '0 0 auto',
};

const whyTitle: React.CSSProperties = {
  fontWeight: 900,
  color: '#111',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};

const whyRight: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  flex: '0 0 auto',
};

const whyHint: React.CSSProperties = {
  fontSize: 12,
  color: '#666',
  fontWeight: 800,
};

const chevWrap: React.CSSProperties = {
  width: 32,
  height: 32,
  borderRadius: 12,
  border: '1px solid #e6e8eb',
  display: 'grid',
  placeItems: 'center',
  color: '#111',
  background: '#fff',
  transition: 'transform 180ms ease',
};

const whyBodyOuter: React.CSSProperties = {
  borderTop: '1px solid #e6e8eb',
  overflow: 'hidden',
  transition: 'max-height 260ms ease, opacity 200ms ease, transform 200ms ease',
  willChange: 'max-height, opacity, transform',
};

const whyBodyInner: React.CSSProperties = {
  padding: 14,
  background: '#fff',
};

const secWrap: React.CSSProperties = {
  padding: 12,
  borderRadius: 14,
  border: '1px solid #eef0f2',
  background: '#fafafa',
  marginBottom: 10,
};

const secHead: React.CSSProperties = {
  display: 'flex',
  gap: 10,
  alignItems: 'flex-start',
};

const secK: React.CSSProperties = {
  width: 30,
  height: 30,
  borderRadius: 12,
  display: 'grid',
  placeItems: 'center',
  background: '#111',
  color: '#fff',
  fontWeight: 950,
  fontSize: 13,
  flex: '0 0 auto',
};

const secTitle: React.CSSProperties = {
  fontWeight: 950,
  color: '#111',
  lineHeight: 1.2,
};

const secSub: React.CSSProperties = {
  marginTop: 4,
  fontSize: 12,
  color: '#666',
  lineHeight: 1.45,
};

const whyGrid2: React.CSSProperties = {
  display: 'grid',
  gap: 10,
  gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
};

const whyCard: React.CSSProperties = {
  border: '1px solid #eef0f2',
  borderRadius: 14,
  padding: 12,
  background: '#fff',
};

const whyCardTitle: React.CSSProperties = {
  fontWeight: 900,
  marginBottom: 8,
  color: '#111',
};

const whyText: React.CSSProperties = {
  color: '#333',
  lineHeight: 1.55,
  fontSize: 13,
};

const whyList: React.CSSProperties = {
  margin: 0,
  paddingLeft: 18,
  color: '#333',
  lineHeight: 1.55,
};

const whyCode: React.CSSProperties = {
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
  fontSize: 12,
  background: '#f6f8fa',
  border: '1px solid #e6e8eb',
  padding: '1px 6px',
  borderRadius: 8,
};

const pillRow: React.CSSProperties = {
  marginTop: 10,
  display: 'flex',
  gap: 8,
  flexWrap: 'wrap',
};

const pill: React.CSSProperties = {
  display: 'inline-flex',
  padding: '4px 10px',
  borderRadius: 999,
  border: '1px solid #e6e8eb',
  background: '#fafafa',
  fontSize: 12,
  fontWeight: 800,
  color: '#444',
};

const bannerNote: React.CSSProperties = {
  marginTop: 10,
  padding: 12,
  borderRadius: 14,
  border: '1px solid #e6e8eb',
  background: '#fafafa',
  color: '#333',
  lineHeight: 1.5,
};

const nextStep: React.CSSProperties = {
  marginTop: 10,
  padding: 12,
  borderRadius: 14,
  border: '1px solid #e6e8eb',
  background: '#fff',
  color: '#333',
};
