import Link from 'next/link';
export default function Home(){
  return (
    <main style={{padding:24}}>
      <h1>Bank PoC MVP</h1>
      <ul>
        <li><Link href="/wallet">Wallet</Link></li>
        <li><Link href="/bank-a">Bank A</Link></li>
        <li><Link href="/bank-b">Bank B</Link></li>
        <li><Link href="/directory">Directory</Link></li>
        <li><Link href="/logs">Logs</Link></li>
      </ul>
    </main>
  );
}
