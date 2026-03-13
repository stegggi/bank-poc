// pages/ebanking.tsx
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { usePrivy, useWallets } from '@privy-io/react-auth';
import { BrowserProvider } from 'ethers';
import { encodeFunctionData, formatEther, getAddress } from 'viem';
import { useRouter } from 'next/router';
import { publicClient } from '../shared/lib/aa';
import NavBar from '../shared/components/NavBar';
import { useBreakpoint } from '../shared/hooks/useBreakpoint';

const CHAIN_ID = 421614; // Arbitrum Sepolia
const DEMO_ETH_CHF = 2000;
const UC_ACCENT = '#3b82f6';

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
  const { ready, authenticated, login, logout, createWallet } = usePrivy() as any;
  const { wallets } = useWallets();
  const { isMobile, isMobileOrTablet } = useBreakpoint();

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
        try { addr = await w.address(); } catch {}
      }
      return addr && /^0x[0-9a-fA-F]{40}$/.test(addr) ? (getAddress(addr) as `0x${string}`) : undefined;
    };

    if (!walletsRef.current?.length && typeof createWallet === 'function') {
      setStatus('Creating your embedded wallet…');
      try {
        await createWallet();
      } catch (e: any) {
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
      const threshold = BigInt('20000000000000');
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
    try { await logout(); } catch {}
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

  /* ── Loading ── */
  if (!ready) return (
    <>
      <NavBar active="ebanking" />
      <div style={pageRoot}>
        <div style={loadingWrap}>
          <span style={loadingText}>Initializing…</span>
        </div>
      </div>
    </>
  );

  /* ── Main render ── */
  return (
    <>
      <NavBar active="ebanking" />
      <div style={pageRoot}>
        <style jsx global>{`
          html, body {
            background: #07080f;
            margin: 0;
            padding: 0;
            -webkit-font-smoothing: antialiased;
          }
          .eb-input {
            transition: border-color 140ms ease, box-shadow 140ms ease;
          }
          .eb-input:focus {
            outline: none;
            border-color: rgba(59,130,246,0.60) !important;
            box-shadow: 0 0 0 3px rgba(59,130,246,0.12) !important;
          }
          .eb-btn-pri {
            transition: opacity 140ms ease, filter 140ms ease;
          }
          .eb-btn-pri:hover {
            opacity: 0.88;
            filter: brightness(1.08);
          }
          .eb-btn-sec {
            transition: background 130ms ease, border-color 130ms ease;
          }
          .eb-btn-sec:hover {
            background: rgba(255,255,255,0.09) !important;
            border-color: rgba(255,255,255,0.18) !important;
          }
          .eb-bal {
            transition: background 150ms ease;
          }
          .eb-bal:hover {
            background: rgba(255,255,255,0.055) !important;
          }
          .eb-arbi {
            transition: color 130ms ease;
          }
          .eb-arbi:hover {
            color: rgba(255,255,255,0.90) !important;
          }
          /* Why This Matters tabs */
          .wtm-tab {
            transition: background 130ms ease, border-color 130ms ease, color 130ms ease;
          }
          .wtm-tab:hover {
            background: rgba(255,255,255,0.07) !important;
            border-color: rgba(255,255,255,0.14) !important;
          }
          .wtm-panel {
            animation: wtmIn 220ms ease;
          }
          @keyframes wtmIn {
            from { opacity: 0; transform: translateY(8px); }
            to   { opacity: 1; transform: translateY(0);   }
          }
        `}</style>

        {!bankLoggedIn ? (
          /* ── Login screen ── */
          <div style={{ ...loginOuter, padding: isMobile ? '60px 16px 100px' : '88px 24px 140px' }}>
            <div style={loginCard}>
              {/* UC chip */}
              <div style={loginChipRow}>
                <span style={loginChip}>
                  <span style={{ color: UC_ACCENT, fontWeight: 800 }}>01</span>
                  <span style={{ color: 'rgba(255,255,255,0.30)', margin: '0 5px' }}>·</span>
                  eBanking
                </span>
              </div>

              <h1 style={loginTitle}>Welcome back</h1>
              <p style={loginSub}>Enter your password to access your eBanking portal.</p>

              <input
                type="password"
                placeholder="Password (finalix)"
                value={passwordInput}
                onChange={(e) => setPasswordInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && onBankLogin()}
                className="eb-input"
                style={inputField}
              />
              <button onClick={onBankLogin} className="eb-btn-pri" style={btnPrimary}>
                Sign in →
              </button>

              {status && <div style={statusBox}>{status}</div>}
            </div>
          </div>
        ) : (
          /* ── Dashboard ── */
          <div style={{ ...pageOuter, padding: isMobile ? '20px 16px 80px' : '40px 24px 120px' }}>
            {/* Page header */}
            <div style={dashHeader}>
              <div>
                <div style={dashChip}>
                  <span style={{ color: UC_ACCENT }}>01</span> · eBanking
                </div>
                <h1 style={{ ...dashTitle, fontSize: isMobile ? 22 : 30 }}>Your Accounts</h1>
              </div>
              <button onClick={onEbankingLogout} className="eb-btn-sec" style={btnGhost}>
                Sign out
              </button>
            </div>

            {/* Traditional CHF accounts */}
            <div style={{ ...acctGrid, gridTemplateColumns: isMobile ? '1fr' : 'repeat(auto-fit, minmax(260px, 1fr))' }}>
              <div style={{ ...acctCard, padding: isMobile ? '16px' : '22px 24px' }}>
                <div style={acctLabel}>Checking Account</div>
                <div style={{ ...acctAmount, fontSize: isMobile ? 24 : 30 }}>
                  {checkingChf.toLocaleString('en-CH', { style: 'currency', currency: 'CHF' })}
                </div>
                <div style={acctIban}>IBAN · CHxx 1234 5678 9012 3456 7</div>
              </div>
              <div style={{ ...acctCard, padding: isMobile ? '16px' : '22px 24px' }}>
                <div style={acctLabel}>Savings Account</div>
                <div style={{ ...acctAmount, fontSize: isMobile ? 24 : 30 }}>
                  {savingChf.toLocaleString('en-CH', { style: 'currency', currency: 'CHF' })}
                </div>
                <div style={acctIban}>IBAN · CHxx 7654 3210 9876 5432 1</div>
              </div>
            </div>

            {/* Crypto wallet panel */}
            <div style={{ ...walletPanel, padding: isMobile ? '16px' : '24px' }}>
              <div style={walletPanelHead}>
                <span style={walletPanelTitle}>Crypto Wallet</span>
                <span style={walletEvmBadge}>EVM</span>
              </div>

              {!authenticated ? (
                <div style={walletUnauth}>
                  <p style={walletUnauthText}>
                    Connect your embedded wallet to view on-chain balances and transact.
                  </p>
                  <button onClick={onLoginOrOpen} className="eb-btn-pri" style={btnPrimary}>
                    Open Wallet
                  </button>
                </div>
              ) : (
                <>
                  {/* Address row */}
                  <div style={addrRow}>
                    <span style={addrLabel}>Address</span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <code style={addrValue}>{eoa || '…'}</code>
                      {eoa && (
                        <a
                          href={arbiscanAddr(eoa)}
                          target="_blank"
                          rel="noreferrer"
                          className="eb-arbi"
                          style={arbiscanLink}
                        >
                          Arbiscan ↗
                        </a>
                      )}
                    </div>
                  </div>

                  {/* Balances */}
                  <div style={{ ...balGrid, gridTemplateColumns: isMobile ? '1fr' : 'repeat(auto-fit, minmax(160px, 1fr))' }}>
                    <div className="eb-bal" style={balCard}>
                      <div style={balLabel}>ETH Balance</div>
                      <div style={balValue}>
                        {Number(formatEther(ethBal)).toFixed(6)}
                        <span style={balUnit}> ETH</span>
                      </div>
                    </div>
                    <div className="eb-bal" style={balCard}>
                      <div style={balLabel}>~ CHF Value</div>
                      <div style={balValue}>
                        {(Number(formatEther(ethBal)) * DEMO_ETH_CHF).toLocaleString('en-CH', {
                          style: 'currency',
                          currency: 'CHF',
                        })}
                      </div>
                    </div>
                    <div className="eb-bal" style={balCard}>
                      <div style={balLabel}>{xbSymbol} Balance</div>
                      <div style={balValue}>
                        {(Number(xbBal) / 1e18).toLocaleString('en-CH')}
                      </div>
                    </div>
                  </div>

                  {/* Actions */}
                  <div style={actionRow}>
                    <button onClick={onBuyXBank} className="eb-btn-pri" style={btnPrimary}>
                      Buy 100 xBank →
                    </button>
                    <button onClick={onGoTransact} className="eb-btn-sec" style={btnSecondary}>
                      Interbank Transfer →
                    </button>
                  </div>
                </>
              )}

              {status && <div style={statusBox}>{status}</div>}
            </div>
          </div>
        )}

        <WhyThisMatters />
      </div>
    </>
  );
}

/* ─────────────────────────────────────────────
   Why This Matters — tabbed section
───────────────────────────────────────────── */

function WhyThisMatters() {
  const [tab, setTab] = useState(0);
  const { isMobile } = useBreakpoint();

  const tabs = [
    {
      n: '01', label: 'Experience',
      title: 'What you experience',
      subtitle: 'It looks and feels like normal eBanking — but you end up with a real blockchain wallet.',
      body: (
        <div style={wtmList}>
          {([
            <>You log in, click one button, and you have a <strong>seedless embedded wallet</strong>.</>,
            <>You see a <strong>real wallet address</strong> (EOA) and balances verifiable on the block explorer.</>,
            <>You "buy" xBank and the balance updates — because an <strong>actual on-chain transaction</strong> just happened.</>,
          ] as React.ReactNode[]).map((item, i) => (
            <div key={i} style={wtmListItem}>
              <span style={wtmArrow}>▸</span>
              <span style={wtmListText}>{item}</span>
            </div>
          ))}
        </div>
      ),
    },
    {
      n: '02', label: 'Technical',
      title: "What's happening under the hood",
      subtitle: 'Three moving pieces: identity, wallet control, and a chain connection.',
      body: (
        <div style={{ ...whyGrid2, gridTemplateColumns: isMobile ? '1fr' : 'repeat(auto-fit, minmax(280px, 1fr))' }}>
          <div style={whyCard}>
            <div style={whyCardTitle}>Identity + wallet UX (Privy)</div>
            <div style={whyText}>
              Privy (TPP) handles authentication and creates the embedded wallet. The app waits until an address
              exists and then issues some "welcome" ETH for first-time users.
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
              <code style={whyCode}>wallet_switchEthereumChain</code> and can add the chain automatically if missing.
            </div>
            <div style={pillRow}>
              <span style={pill}>Chain safety</span>
              <span style={pill}>No "wrong network" traps</span>
            </div>
          </div>
        </div>
      ),
    },
    {
      n: '03', label: 'On-Chain',
      title: 'What goes on-chain',
      subtitle: "The balances shown match the ledger you don't control — the chain is the source of truth.",
      body: (
        <>
          <div style={{ ...whyGrid2, gridTemplateColumns: isMobile ? '1fr' : 'repeat(auto-fit, minmax(280px, 1fr))' }}>
            <div style={whyCard}>
              <div style={whyCardTitle}>Reads (no transaction)</div>
              <div style={wtmList}>
                {([
                  <>ETH balance read directly from the chain — no database involved.</>,
                  <>xBank token balance via <code style={whyCode}>balanceOf(address)</code>.</>,
                ] as React.ReactNode[]).map((item, i) => (
                  <div key={i} style={wtmListItem}>
                    <span style={wtmArrow}>▸</span>
                    <span style={wtmListText}>{item}</span>
                  </div>
                ))}
              </div>
            </div>
            <div style={whyCard}>
              <div style={whyCardTitle}>Writes (transactions)</div>
              <div style={wtmList}>
                {([
                  <><strong>Sponsored gas top-up:</strong> if the wallet is newly created, <code style={whyCode}>/api/grant</code> sends a tiny amount of "welcome" ETH.</>,
                  <><strong>xBank purchase:</strong> "Buy 100 xBank" calls the ERC-20 contract's <code style={whyCode}>buy()</code> function.</>,
                ] as React.ReactNode[]).map((item, i) => (
                  <div key={i} style={wtmListItem}>
                    <span style={wtmArrow}>▸</span>
                    <span style={wtmListText}>{item}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
          <div style={bannerNote}>
            <strong>Key insight:</strong> the "bank UI" is no longer the source of truth — the chain is.
          </div>
        </>
      ),
    },
    {
      n: '04', label: 'For Banks',
      title: 'Why banks should care',
      subtitle: 'This is the onboarding layer that makes regulated on-chain finance usable for normal customers.',
      body: (
        <>
          <div style={{ ...whyGrid2, gridTemplateColumns: isMobile ? '1fr' : 'repeat(auto-fit, minmax(280px, 1fr))' }}>
            <div style={whyCard}>
              <div style={whyCardTitle}>Regulatory lens</div>
              <div style={wtmList}>
                {([
                  <>A real rollout binds wallet issuance to a <strong>KYC'd</strong> session — the demo password stands in for that.</>,
                  <>Banks need a clean foundation before Travel Rule messaging: <strong>who owns the address</strong>, and who the bank can vouch for.</>,
                ] as React.ReactNode[]).map((item, i) => (
                  <div key={i} style={wtmListItem}>
                    <span style={wtmArrow}>▸</span>
                    <span style={wtmListText}>{item}</span>
                  </div>
                ))}
              </div>
            </div>
            <div style={whyCard}>
              <div style={whyCardTitle}>Operational lens</div>
              <div style={wtmList}>
                {([
                  <><strong>Fewer support tickets:</strong> gas sponsorship removes "insufficient ETH" failures for new users.</>,
                  <>Production typically uses an <strong>EIP-4337 Paymaster</strong> so customers transact without holding ETH at all.</>,
                ] as React.ReactNode[]).map((item, i) => (
                  <div key={i} style={wtmListItem}>
                    <span style={wtmArrow}>▸</span>
                    <span style={wtmListText}>{item}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
          <div style={nextStep}>
            <div style={nextStepTitle}>What it unlocks next</div>
            <div style={nextStepBody}>
              Once the customer has a wallet and assets, the bank can enable interbank transfers, DeFi access, and more —
              each use case built on this foundation.
            </div>
          </div>
        </>
      ),
    },
  ];

  const active = tabs[tab];

  return (
    <div style={{ ...wtmOuter, padding: isMobile ? '20px 16px 60px' : '48px 24px 80px' }}>
      {/* Divider */}
      <div style={wtmDivider}>
        <div style={wtmDividerLine} />
        <span style={wtmDividerLabel}>Why this matters</span>
        <div style={wtmDividerLine} />
      </div>

      <p style={wtmIntro}>
        A breakdown of what this demo proves — and why it matters for banking.
      </p>

      {/* Tab strip */}
      <div style={wtmTabStrip} role="tablist">
        {tabs.map((t, i) => (
          <button
            key={i}
            role="tab"
            aria-selected={tab === i}
            onClick={() => setTab(i)}
            className="wtm-tab"
            style={{ ...wtmTabBase, ...(tab === i ? wtmTabActive : {}) }}
          >
            <span style={{ ...wtmTabN, color: tab === i ? UC_ACCENT : 'rgba(255,255,255,0.22)' }}>
              {t.n}
            </span>
            {t.label}
          </button>
        ))}
      </div>

      {/* Content panel — key forces remount + fade-in animation on tab change */}
      <div key={tab} role="tabpanel" className="wtm-panel" style={{ ...wtmPanel, padding: isMobile ? '16px' : '24px' }}>
        <div style={wtmPanelHead}>
          <div style={wtmPanelTitle}>{active.title}</div>
          <div style={wtmPanelSub}>{active.subtitle}</div>
        </div>
        {active.body}
      </div>
    </div>
  );
}

/* ── Styles ── */

const pageRoot: CSSProperties = {
  background: '#07080f',
  minHeight: '100vh',
  color: '#e8e8f0',
  fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif",
};

const loadingWrap: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  minHeight: '60vh',
};

const loadingText: CSSProperties = {
  color: 'rgba(255,255,255,0.38)',
  fontSize: 15,
};

/* Login */
const loginOuter: CSSProperties = {
  display: 'flex',
  justifyContent: 'center',
  padding: '88px 24px 140px',
};

const loginCard: CSSProperties = {
  width: '100%',
  maxWidth: 420,
  background: 'rgba(255,255,255,0.032)',
  border: '1px solid rgba(255,255,255,0.09)',
  borderRadius: 20,
  padding: '32px 28px',
  display: 'flex',
  flexDirection: 'column',
  gap: 0,
};

const loginChipRow: CSSProperties = {
  marginBottom: 24,
};

const loginChip: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  padding: '5px 12px',
  borderRadius: 999,
  border: '1px solid rgba(255,255,255,0.10)',
  background: 'rgba(255,255,255,0.04)',
  fontSize: 12,
  fontWeight: 700,
  color: 'rgba(255,255,255,0.65)',
  letterSpacing: '0.02em',
};

const loginTitle: CSSProperties = {
  margin: '0 0 10px',
  fontSize: 28,
  fontWeight: 900,
  color: '#fff',
  letterSpacing: '-0.022em',
  lineHeight: 1.15,
};

const loginSub: CSSProperties = {
  margin: '0 0 24px',
  fontSize: 14,
  color: 'rgba(255,255,255,0.55)',
  lineHeight: 1.6,
};

const inputField: CSSProperties = {
  width: '100%',
  padding: '11px 14px',
  borderRadius: 12,
  border: '1px solid rgba(255,255,255,0.12)',
  background: 'rgba(255,255,255,0.05)',
  color: '#fff',
  fontSize: 14,
  marginBottom: 12,
  boxSizing: 'border-box',
  fontFamily: 'inherit',
};

/* Buttons */
const btnPrimary: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  padding: '11px 20px',
  borderRadius: 12,
  border: '1px solid transparent',
  background: UC_ACCENT,
  color: '#fff',
  fontSize: 14,
  fontWeight: 700,
  cursor: 'pointer',
  letterSpacing: '0.01em',
  fontFamily: 'inherit',
};

const btnGhost: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  padding: '9px 16px',
  borderRadius: 10,
  border: '1px solid rgba(255,255,255,0.12)',
  background: 'rgba(255,255,255,0.04)',
  color: 'rgba(255,255,255,0.60)',
  fontSize: 13,
  fontWeight: 600,
  cursor: 'pointer',
  fontFamily: 'inherit',
};

const btnSecondary: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  padding: '11px 20px',
  borderRadius: 12,
  border: '1px solid rgba(255,255,255,0.14)',
  background: 'rgba(255,255,255,0.05)',
  color: 'rgba(255,255,255,0.75)',
  fontSize: 14,
  fontWeight: 700,
  cursor: 'pointer',
  fontFamily: 'inherit',
};

const statusBox: CSSProperties = {
  marginTop: 16,
  padding: '10px 14px',
  borderRadius: 10,
  border: '1px solid rgba(255,255,255,0.09)',
  background: 'rgba(255,255,255,0.04)',
  color: 'rgba(255,255,255,0.65)',
  fontSize: 13,
  lineHeight: 1.5,
  wordBreak: 'break-all',
};

/* Dashboard */
const pageOuter: CSSProperties = {
  maxWidth: 900,
  margin: '0 auto',
  padding: '40px 24px 120px',
};

const dashHeader: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-end',
  justifyContent: 'space-between',
  marginBottom: 28,
  gap: 16,
  flexWrap: 'wrap',
};

const dashChip: CSSProperties = {
  fontSize: 12,
  fontWeight: 700,
  color: 'rgba(255,255,255,0.42)',
  letterSpacing: '0.04em',
  marginBottom: 6,
};

const dashTitle: CSSProperties = {
  margin: 0,
  fontSize: 30,
  fontWeight: 900,
  color: '#fff',
  letterSpacing: '-0.022em',
};

/* Account cards */
const acctGrid: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
  gap: 14,
  marginBottom: 20,
};

const acctCard: CSSProperties = {
  background: 'rgba(255,255,255,0.032)',
  border: '1px solid rgba(255,255,255,0.08)',
  borderRadius: 16,
  padding: '22px 24px',
};

const acctLabel: CSSProperties = {
  fontSize: 12,
  fontWeight: 700,
  color: 'rgba(255,255,255,0.40)',
  letterSpacing: '0.05em',
  textTransform: 'uppercase',
  marginBottom: 10,
};

const acctAmount: CSSProperties = {
  fontSize: 30,
  fontWeight: 800,
  color: '#fff',
  letterSpacing: '-0.02em',
  marginBottom: 8,
};

const acctIban: CSSProperties = {
  fontSize: 12,
  color: 'rgba(255,255,255,0.30)',
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, 'Courier New', monospace",
  letterSpacing: '0.02em',
};

/* Crypto wallet panel */
const walletPanel: CSSProperties = {
  background: 'rgba(255,255,255,0.04)',
  border: '1px solid rgba(255,255,255,0.10)',
  borderRadius: 16,
  padding: '24px',
  marginBottom: 16,
};

const walletPanelHead: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  marginBottom: 20,
};

const walletPanelTitle: CSSProperties = {
  fontSize: 17,
  fontWeight: 800,
  color: '#fff',
};

const walletEvmBadge: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  padding: '3px 9px',
  borderRadius: 999,
  border: `1px solid ${UC_ACCENT}44`,
  background: `${UC_ACCENT}18`,
  color: UC_ACCENT,
  fontSize: 11,
  fontWeight: 800,
  letterSpacing: '0.05em',
};

const walletUnauth: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 14,
};

const walletUnauthText: CSSProperties = {
  margin: 0,
  fontSize: 14,
  color: 'rgba(255,255,255,0.55)',
  lineHeight: 1.6,
};

const addrRow: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  marginBottom: 16,
  padding: '14px 16px',
  borderRadius: 12,
  background: 'rgba(255,255,255,0.03)',
  border: '1px solid rgba(255,255,255,0.07)',
};

const addrLabel: CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  color: 'rgba(255,255,255,0.35)',
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
};

const addrValue: CSSProperties = {
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, 'Courier New', monospace",
  fontSize: 13,
  color: 'rgba(255,255,255,0.80)',
  wordBreak: 'break-all',
};

const arbiscanLink: CSSProperties = {
  fontSize: 12,
  fontWeight: 700,
  color: UC_ACCENT,
  textDecoration: 'none',
  flexShrink: 0,
};

const balGrid: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
  gap: 10,
  marginBottom: 20,
};

const balCard: CSSProperties = {
  background: 'rgba(255,255,255,0.03)',
  border: '1px solid rgba(255,255,255,0.07)',
  borderRadius: 12,
  padding: '14px 16px',
};

const balLabel: CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  color: 'rgba(255,255,255,0.38)',
  letterSpacing: '0.05em',
  textTransform: 'uppercase',
  marginBottom: 6,
};

const balValue: CSSProperties = {
  fontSize: 18,
  fontWeight: 700,
  color: '#fff',
  letterSpacing: '-0.01em',
};

const balUnit: CSSProperties = {
  fontSize: 13,
  fontWeight: 500,
  color: 'rgba(255,255,255,0.45)',
};

const actionRow: CSSProperties = {
  display: 'flex',
  gap: 10,
  flexWrap: 'wrap',
};

/* ─── Why This Matters — tabbed section styles ─── */

const wtmOuter: CSSProperties = {
  maxWidth: 900,
  margin: '0 auto',
  padding: '48px 24px 80px',
};

const wtmDivider: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 18,
  marginBottom: 20,
};

const wtmDividerLine: CSSProperties = {
  flex: 1,
  height: 1,
  background: 'rgba(255,255,255,0.06)',
};

const wtmDividerLabel: CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: '0.11em',
  textTransform: 'uppercase',
  color: 'rgba(255,255,255,0.28)',
  flexShrink: 0,
};

const wtmIntro: CSSProperties = {
  margin: '0 0 28px',
  fontSize: 15,
  color: 'rgba(255,255,255,0.52)',
  lineHeight: 1.6,
  maxWidth: 560,
};

const wtmTabStrip: CSSProperties = {
  display: 'flex',
  gap: 6,
  flexWrap: 'wrap',
  marginBottom: 20,
};

const wtmTabBase: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 7,
  padding: '8px 14px',
  borderRadius: 10,
  border: '1px solid rgba(255,255,255,0.08)',
  background: 'rgba(255,255,255,0.03)',
  color: 'rgba(255,255,255,0.55)',
  fontSize: 13,
  fontWeight: 600,
  cursor: 'pointer',
  fontFamily: 'inherit',
};

const wtmTabActive: CSSProperties = {
  background: `${UC_ACCENT}18`,
  borderColor: `${UC_ACCENT}44`,
  color: '#fff',
};

const wtmTabN: CSSProperties = {
  fontSize: 11,
  fontWeight: 800,
  letterSpacing: '0.04em',
};

const wtmPanel: CSSProperties = {
  background: 'rgba(255,255,255,0.032)',
  border: '1px solid rgba(255,255,255,0.08)',
  borderRadius: 16,
  padding: '24px',
};

const wtmPanelHead: CSSProperties = {
  marginBottom: 20,
  paddingBottom: 18,
  borderBottom: '1px solid rgba(255,255,255,0.07)',
};

const wtmPanelTitle: CSSProperties = {
  fontSize: 18,
  fontWeight: 800,
  color: '#fff',
  letterSpacing: '-0.015em',
  marginBottom: 6,
};

const wtmPanelSub: CSSProperties = {
  fontSize: 14,
  color: 'rgba(255,255,255,0.52)',
  lineHeight: 1.55,
};

const wtmList: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
};

const wtmListItem: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 10,
};

const wtmArrow: CSSProperties = {
  color: UC_ACCENT,
  fontSize: 10,
  flexShrink: 0,
  marginTop: 3,
};

const wtmListText: CSSProperties = {
  fontSize: 14,
  color: 'rgba(255,255,255,0.68)',
  lineHeight: 1.6,
};

const whyGrid2: CSSProperties = {
  display: 'grid',
  gap: 10,
  gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
};

const whyCard: CSSProperties = {
  border: '1px solid rgba(255,255,255,0.07)',
  borderRadius: 12,
  padding: 12,
  background: 'rgba(255,255,255,0.03)',
};

const whyCardTitle: CSSProperties = {
  fontWeight: 800,
  marginBottom: 8,
  color: '#fff',
  fontSize: 14,
};

const whyText: CSSProperties = {
  color: 'rgba(255,255,255,0.62)',
  lineHeight: 1.55,
  fontSize: 13,
};

const whyList: CSSProperties = {
  margin: 0,
  paddingLeft: 18,
  color: 'rgba(255,255,255,0.62)',
  lineHeight: 1.65,
  fontSize: 13,
};

const whyCode: CSSProperties = {
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Courier New', monospace",
  fontSize: 11,
  background: 'rgba(255,255,255,0.08)',
  border: '1px solid rgba(255,255,255,0.10)',
  color: 'rgba(255,255,255,0.88)',
  padding: '1px 6px',
  borderRadius: 6,
};

const pillRow: CSSProperties = {
  marginTop: 10,
  display: 'flex',
  gap: 8,
  flexWrap: 'wrap',
};

const pill: CSSProperties = {
  display: 'inline-flex',
  padding: '4px 10px',
  borderRadius: 999,
  border: '1px solid rgba(255,255,255,0.10)',
  background: 'rgba(255,255,255,0.05)',
  fontSize: 12,
  fontWeight: 700,
  color: 'rgba(255,255,255,0.60)',
};

const bannerNote: CSSProperties = {
  marginTop: 10,
  padding: 12,
  borderRadius: 12,
  border: `1px solid ${UC_ACCENT}33`,
  background: `${UC_ACCENT}0d`,
  color: 'rgba(255,255,255,0.72)',
  lineHeight: 1.5,
  fontSize: 13,
};

const nextStep: CSSProperties = {
  marginTop: 14,
  padding: '16px 18px',
  borderRadius: 12,
  border: `1px solid ${UC_ACCENT}33`,
  background: `${UC_ACCENT}0d`,
};

const nextStepTitle: CSSProperties = {
  fontWeight: 800,
  marginBottom: 6,
  color: '#fff',
  fontSize: 14,
};

const nextStepBody: CSSProperties = {
  color: 'rgba(255,255,255,0.65)',
  lineHeight: 1.6,
  fontSize: 14,
};
