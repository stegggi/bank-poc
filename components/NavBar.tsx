// components/NavBar.tsx
import Link from 'next/link';

type NavBarProps = { active?: 'home' | 'ebanking' | 'bankA' | 'bankB' };

export default function NavBar({ active }: NavBarProps) {
  return (
    <div style={styles.wrap}>
      <div style={styles.inner}>
        <div style={styles.brand}>
          <span style={{ fontWeight: 700 }}>finalix</span>
          <span style={{ opacity: 0.6, marginLeft: 6 }}>concept bank</span>
        </div>
        <nav style={styles.nav}>
          <NavItem href="/" label="Home" active={active === 'home'} />
          <NavItem href="/ebanking" label="eBanking" active={active === 'ebanking'} />
          <NavItem href="/bank-a" label="Interbank Payment (Bank A)" active={active === 'bankA'} />
          <NavItem href="/bank-b" label="Interbank Payment (Bank B)" active={active === 'bankB'} />
        </nav>
      </div>
    </div>
  );
}

function NavItem({ href, label, active }: { href: string; label: string; active?: boolean }) {
  return (
    <Link
      href={href}
      style={{
        padding: '10px 14px',
        borderRadius: 10,
        textDecoration: 'none',
        color: active ? '#0a0a0a' : '#333',
        background: active ? '#f1f3f5' : 'transparent',
        border: active ? '1px solid #e6e8eb' : '1px solid transparent',
        fontWeight: 600,
      }}
    >
      {label}
    </Link>
  );
}

const styles: Record<string, React.CSSProperties> = {
  wrap: {
    position: 'sticky',
    top: 0,
    zIndex: 100,
    background: 'rgba(255,255,255,0.85)',
    backdropFilter: 'blur(6px)',
    borderBottom: '1px solid #eee',
  },
  inner: {
    maxWidth: 1000,
    margin: '0 auto',
    padding: '10px 16px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  brand: { fontSize: 18, letterSpacing: 0.2 },
  nav: { display: 'flex', gap: 8, alignItems: 'center' },
};
