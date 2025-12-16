// pages/ebanking.tsx
import { useEffect, useMemo, useRef, useState } from 'react';
import { usePrivy, useWallets } from '@privy-io/react-auth';
import { BrowserProvider } from 'ethers';
import { encodeFunctionData, formatEther, getAddress } from 'viem';
import { useRouter } from 'next/router';
import { publicClient } from '../lib/aa';
import NavBar from '../components/NavBar';

const CHAIN_ID = 421614; // Arbitrum Sepolia
const DEMO_ETH_CHF = 2000;

const ERC20_MIN_ABI = [
  { inputs: [{ internalType: 'address', name: 'spender', type: 'address' }, { internalType: 'uint256', name: 'value', type: 'uint256' }], name: 'approve', outputs: [{ internalType: 'bool', name: '', type: 'bool' }], stateMutability: 'nonpayable', type: 'function' },
  { inputs: [], name: 'buy', outputs: [], stateMutability: 'nonpayable', type: 'function' },
  { inputs: [{ internalType: 'address', name: 'owner', type: 'address' }], name: 'balanceOf', outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }], stateMutability: 'view', type: 'function' },
  { inputs: [], name: 'symbol', outputs: [{ internalType: 'string', name: '', type: 'string' }], stateMutability: 'view', type: 'function' },
];

const XBANK = process.env.NEXT_PUBLIC_XBANK_ADDRESS as `0x${string}` | undefined;
const RPC   = process.env.NEXT_PUBLIC_RPC_URL;

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
  const [xbBal,  setXbBal]  = useState<bigint>(BigInt(0));
  const [xbSymbol, setXbSymbol] = useState<string>('XBANK');

  const grantInFlight = useRef(false);
  const initInFlight  = useRef(false);

  const walletsRef = useRef<any[]>([]);
  useEffect(() => { walletsRef.current = (wallets as any[]) || []; }, [wallets]);

  const short = (a?: string) => (a ? a.slice(0, 6) + '…' + a.slice(-4) : '');
  const arbiscanAddr = (addr: string) => `https://sepolia.arbiscan.io/address/${addr}`;

  const checkingChf = useMemo(() => 12345.55, []);
  const savingChf   = useMemo(() => 38500.10, []);

  const ensureSepolia = async (eip1193: any) => {
    try {
      await eip1193.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x66eee' }] });
    } catch (err: any) {
      if (err?.code === 4902 && RPC) {
        await eip1193.request({
          method: 'wallet_addEthereumChain',
          params: [{
            chainId: '0x66eee',
            chainName: 'Arbitrum Sepolia',
            nativeCurrency: { name: 'Sepolia Ether', symbol: 'ETH', decimals: 18 },
            rpcUrls: [RPC],
            blockExplorerUrls: ['https://sepolia.arbiscan.io'],
          }],
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
        try { addr = await w.address(); } catch {}
      }
      return addr && /^0x[0-9a-fA-F]{40}$/.test(addr) ? (getAddress(addr) as `0x${string}`) : undefined;
    };

    // If there are no wallets at all, proactively create one
    if (!walletsRef.current?.length && typeof createWallet === 'function') {
      setStatus('Creating your embedded wallet…');
      try { await createWallet(); } catch (e:any) {
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

  if (!ready) return (
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
              onChange={(e)=>setPasswordInput(e.target.value)}
              style={{width:'100%', padding:8, marginBottom:8}}
            />
            <button onClick={onBankLogin}>Login</button>
            {status && <p style={{marginTop:8}}>{status}</p>}
          </div>
        ) : (
          <>
            <div style={grid}>
              <div style={card}>
                <h3>Checking (CHF)</h3>
                <p style={bigAmount}>{checkingChf.toLocaleString('en-CH', { style:'currency', currency:'CHF' })}</p>
                <small>IBAN: CHxx 1234 5678 9012 3456 7</small>
              </div>
              <div style={card}>
                <h3>Saving (CHF)</h3>
                <p style={bigAmount}>{savingChf.toLocaleString('en-CH', { style:'currency', currency:'CHF' })}</p>
                <small>IBAN: CHxx 7654 3210 9876 5432 1</small>
              </div>
            </div>

            <div style={panel}>
              <h3>Crypto Wallet</h3>

              {!authenticated ? (
                <button onClick={onLoginOrOpen}>Log-in or create wallet</button>
              ) : (
                <>
                  <p>
                    <strong>Wallet Address (EOA):</strong>{' '}
                    {eoa ? (
                      <>
                        <span style={{fontFamily:'monospace'}}>{eoa}</span>{' '}
                        <a href={arbiscanAddr(eoa)} target="_blank" rel="noreferrer">Arbiscan</a>
                      </>
                    ) : '…'}
                  </p>

                  <div style={{display:'flex', gap:24, flexWrap:'wrap'}}>
                    <div>
                      <div><small>ETH balance</small></div>
                      <div style={{fontFamily:'monospace', fontSize:18}}>
                        {Number(formatEther(ethBal)).toFixed(6)} ETH
                      </div>
                    </div>
                    <div>
                      <div><small>~ CHF value</small></div>
                      <div style={{fontSize:18}}>
                        {(Number(formatEther(ethBal))*DEMO_ETH_CHF).toLocaleString('en-CH', { style:'currency', currency:'CHF' })}
                      </div>
                    </div>
                    <div>
                    
                      <div><small>{xbSymbol} balance</small></div>
                      <div style={{fontSize:18}}>
                        {(Number(xbBal)/1e18).toLocaleString('en-CH')}
                       
                      </div>
                    </div>
                  </div>

                  <div style={{marginTop:12, display:'flex', gap:12, flexWrap:'wrap'}}>
                    <button onClick={onBuyXBank}>Buy 100 xBank stablecoin</button>
                    <button onClick={onGoTransact}>Interbank payment transfer</button>
                    <button onClick={onEbankingLogout} style={{marginLeft:'auto', opacity:0.7}}>
                      Logout from eBanking
                    </button>
                  </div>
                </>
              )}

              {status && <p style={{marginTop:8}}>{status}</p>}
            </div>
          </>
        )}
      </div>
    </>
  );
}

const panel: React.CSSProperties = { border:'1px solid #e6e8eb', borderRadius:14, padding:16, background:'#fff' };
const grid:  React.CSSProperties = { display:'grid', gridTemplateColumns:'1fr 1fr', gap:16, margin:'12px 0 20px' };
const card:  React.CSSProperties = { border:'1px solid #eee', borderRadius:14, padding:16, background:'#fff' };
const bigAmount: React.CSSProperties = { fontSize:24, margin:0 };
