import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";

type NavActive =
  | "home"
  | "ebanking"
  | "bank-a"
  | "bank-b"
  | "bankA"
  | "bankB"
  | "kyc-badge"
  | "context-vault"
  | "uc4"
  | "uc5"
  | "uc6"
  | "uc7";

type NavBarProps = { active?: NavActive };

/* Accent colours match the homepage use-case cards */
const ACCENT = {
  uc1: "#3b82f6",
  uc2: "#10b981",
  uc3: "#8b5cf6",
  uc4: "#f59e0b",
  uc5: "#ef4444",
  uc6: "#06b6d4",
  uc7: "#ec4899",
} as const;

export default function NavBar({ active }: NavBarProps) {
  const isHome     = active === "home";
  const isBankA    = active === "bank-a" || active === "bankA";
  const isBankB    = active === "bank-b" || active === "bankB";
  const isEbanking = active === "ebanking";
  const isKyc      = active === "kyc-badge";
  const isUc4      = active === "uc4" || active === "context-vault";
  const isUc5      = active === "uc5";
  const isUc6      = active === "uc6";
  const isUc7      = active === "uc7";
  const isUc2      = isBankA || isBankB;

  return (
    <nav style={navWrap} aria-label="Primary navigation">
      <style jsx>{`
        /* Scrollbar hidden */
        .ucScroller { scrollbar-width: none; -ms-overflow-style: none; }
        .ucScroller::-webkit-scrollbar { display: none; }

        /* Nav items */
        .navPill {
          transition: background 130ms ease, border-color 130ms ease,
            transform 120ms ease;
        }
        .navPill:hover {
          transform: translateY(-1px);
          border-color: rgba(255,255,255,0.18) !important;
          background: rgba(255,255,255,0.08) !important;
        }
        .navSeg {
          transition: background 130ms ease, color 130ms ease;
        }
        .navSeg:hover {
          background: rgba(255,255,255,0.09) !important;
        }
        .chevBtn {
          transition: background 130ms ease, opacity 160ms ease;
        }
        .chevBtn:hover:not(:disabled) {
          background: rgba(255,255,255,0.12) !important;
        }
        /* Reveal chevrons on strip hover on non-touch */
        .stripRoot:hover .chevBtn {
          opacity: 1 !important;
        }
        :focus-visible {
          outline: 2px solid rgba(255,255,255,0.45);
          outline-offset: 2px;
        }
        @media (prefers-reduced-motion: reduce) {
          .navPill, .navSeg, .chevBtn { transition: none !important; }
        }
        /* Mobile: tighter padding, smaller brand */
        @media (max-width: 639px) {
          .navInner { padding: 7px 10px !important; gap: 8px !important; }
          .navBrandSub { display: none !important; }
          .navBrandMain { font-size: 13px !important; }
        }
        @media (max-width: 400px) {
          .navBrandMain { display: none !important; }
        }
      `}</style>

      <div style={navInner} className="navInner">
        {/* ── Brand + home ── */}
        <div style={navLeft}>
          <div style={brandStyle}>
            <span className="navBrandMain" style={{ fontWeight: 900, color: "#fff", letterSpacing: "-0.02em" }}>
              blockchain
            </span>
            <span className="navBrandSub" style={{ color: "rgba(255,255,255,0.3)", marginLeft: 6, fontWeight: 400 }}>
              concept bank
            </span>
          </div>

          <Link
            href="/"
            aria-label="Home"
            data-nav-item
            className="navPill"
            style={{
              ...pillBase,
              width: 36,
              height: 36,
              padding: 0,
              justifyContent: "center",
              borderRadius: 10,
              ...(isHome ? pillActiveBase : {}),
            }}
          >
            <HomeIcon />
          </Link>
        </div>

        {/* ── Scrollable strip ── */}
        <NavStrip activeKey={active ?? ""}>
          {/* UC1 */}
          <NavPill
            n="01"
            label="eBanking"
            href="/ebanking"
            accent={ACCENT.uc1}
            active={isEbanking}
          />

          {/* UC2 – segmented Bank A / Bank B */}
          <NavSegmented
            n="02"
            label="Interbank Payment"
            accent={ACCENT.uc2}
            groupActive={isUc2}
            left={{ label: "Bank A", href: "/bank-a", active: isBankA }}
            right={{ label: "Bank B", href: "/bank-b", active: isBankB }}
          />

          {/* UC3 */}
          <NavPill
            n="03"
            label="KYC Badge"
            href="/kyc-badge"
            accent={ACCENT.uc3}
            active={isKyc}
          />

          {/* UC4 */}
          <NavPill
            n="04"
            label="Context Passport"
            href="/context-vault"
            accent={ACCENT.uc4}
            active={isUc4}
          />

          {/* UC5 */}
          <NavPill
            n="05"
            label="Trading Bot"
            href="/uc5"
            accent={ACCENT.uc5}
            active={isUc5}
          />

          {/* UC6 */}
          <NavPill
            n="06"
            label="LP Bot"
            href="/uc6"
            accent={ACCENT.uc6}
            active={isUc6}
          />

          {/* UC7 */}
          <NavPill
            n="07"
            label="Source of Wealth"
            href="/uc7"
            accent={ACCENT.uc7}
            active={isUc7}
          />
        </NavStrip>
      </div>
    </nav>
  );
}

/* ── NavPill ── */
function NavPill({
  n,
  label,
  href,
  accent,
  active,
}: {
  n: string;
  label: string;
  href: string;
  accent: string;
  active: boolean;
}) {
  return (
    <Link
      href={href}
      data-nav-item
      data-nav-active={active}
      className="navPill"
      style={{
        ...pillBase,
        ...(active
          ? {
              background: `${accent}1a`,
              borderColor: `${accent}55`,
            }
          : {}),
      }}
    >
      <span
        style={{
          ...numStyle,
          color: active ? accent : "rgba(255,255,255,0.25)",
        }}
      >
        {n}
      </span>
      <span
        style={{
          color: active ? "#fff" : "rgba(255,255,255,0.58)",
          fontWeight: active ? 700 : 500,
        }}
      >
        {label}
      </span>
    </Link>
  );
}

/* ── NavSegmented (UC2: Bank A / Bank B) ── */
function NavSegmented({
  n,
  label,
  accent,
  groupActive,
  left,
  right,
}: {
  n: string;
  label: string;
  accent: string;
  groupActive: boolean;
  left: { label: string; href: string; active: boolean };
  right: { label: string; href: string; active: boolean };
}) {
  return (
    <div
      data-nav-item
      data-nav-active={groupActive}
      aria-label={label}
      style={{
        display: "inline-flex",
        alignItems: "stretch",
        borderRadius: 10,
        border: `1px solid ${groupActive ? `${accent}55` : "rgba(255,255,255,0.08)"}`,
        background: groupActive ? `${accent}1a` : "rgba(255,255,255,0.04)",
        overflow: "hidden",
        flex: "0 0 auto",
        whiteSpace: "nowrap",
      }}
    >
      {/* UC number */}
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          padding: "0 6px 0 10px",
          fontSize: 11,
          fontWeight: 800,
          letterSpacing: "0.04em",
          color: groupActive ? accent : "rgba(255,255,255,0.25)",
          borderRight: "1px solid rgba(255,255,255,0.08)",
          flexShrink: 0,
        }}
      >
        {n}
      </span>

      {/* Bank A */}
      <Link
        href={left.href}
        className="navSeg"
        style={{
          ...segBase,
          color: left.active ? "#fff" : "rgba(255,255,255,0.52)",
          fontWeight: left.active ? 700 : 500,
          background: left.active ? `${accent}28` : "transparent",
        }}
      >
        {left.label}
      </Link>

      {/* Divider */}
      <span
        style={{
          width: 1,
          alignSelf: "stretch",
          background: "rgba(255,255,255,0.09)",
          flexShrink: 0,
        }}
      />

      {/* Bank B */}
      <Link
        href={right.href}
        className="navSeg"
        style={{
          ...segBase,
          color: right.active ? "#fff" : "rgba(255,255,255,0.52)",
          fontWeight: right.active ? 700 : 500,
          background: right.active ? `${accent}28` : "transparent",
        }}
      >
        {right.label}
      </Link>
    </div>
  );
}

/* ── NavStrip: scroll container with edge fades + chevrons ── */
function NavStrip({
  children,
  activeKey,
}: {
  children: ReactNode;
  activeKey: string;
}) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const rafRef      = useRef(0);
  const mountedRef  = useRef(true);

  const [canLeft,     setCanLeft]     = useState(false);
  const [canRight,    setCanRight]    = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const [coarse,      setCoarse]      = useState(false);

  /* Detect coarse pointer once */
  useEffect(() => {
    const mq = window.matchMedia("(pointer: coarse)");
    const sync = () => setCoarse(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  /* Overflow + scroll-arrow state */
  useEffect(() => {
    mountedRef.current = true;
    const el = scrollerRef.current;
    if (!el) return;

    const update = () => {
      if (!mountedRef.current) return;            // guard after unmount
      const maxScroll = el.scrollWidth - el.clientWidth;
      const hasOverflow = maxScroll > 4;           // 4px threshold beats sub-pixel rounding
      setOverflowing(hasOverflow);
      setCanLeft(hasOverflow && el.scrollLeft > 4);
      setCanRight(hasOverflow && el.scrollLeft < maxScroll - 4);
    };

    const onScroll = () => {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(update);
    };

    el.addEventListener("scroll", onScroll, { passive: true });

    const ro = new ResizeObserver(onScroll);
    ro.observe(el);                               // container size changes
    /* Also observe each nav item so pill text/count changes trigger a recheck */
    el.querySelectorAll<HTMLElement>("[data-nav-item]").forEach((c) => ro.observe(c));

    window.addEventListener("resize", onScroll);
    update();                                     // initial sync

    return () => {
      mountedRef.current = false;
      cancelAnimationFrame(rafRef.current);
      el.removeEventListener("scroll", onScroll);
      ro.disconnect();
      window.removeEventListener("resize", onScroll);
    };
  }, []);

  /* Scroll active item into view when activeKey changes */
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;

    const item = el.querySelector<HTMLElement>("[data-nav-active='true']");
    if (!item) return;

    /* Use getBoundingClientRect so offsetLeft parent-chain doesn't matter */
    const stripRect = el.getBoundingClientRect();
    const itemRect  = item.getBoundingClientRect();

    const fullyVisible =
      itemRect.left >= stripRect.left + 6 &&
      itemRect.right <= stripRect.right - 6;
    if (fullyVisible) return;

    /* Centre the item in the strip */
    const itemCentre = el.scrollLeft + (itemRect.left - stripRect.left) + itemRect.width / 2;
    el.scrollTo({ left: Math.max(0, itemCentre - el.clientWidth / 2), behavior: "smooth" });
  }, [activeKey]);

  const scrollBy = (dir: -1 | 1) => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollBy({ left: dir * Math.floor(el.clientWidth * 0.65), behavior: "smooth" });
  };

  /* On non-touch, chevrons fade in only on hover (via CSS .stripRoot:hover .chevBtn).
     On touch, always visible so they remain tappable. */
  const chevronBaseOpacity = coarse ? 1 : 0;

  return (
    <div style={stripRoot} className="stripRoot">
      {/* Edge fade — left */}
      <div
        aria-hidden="true"
        style={{
          ...edgeFade,
          left: 0,
          opacity: canLeft ? 1 : 0,
          background: "linear-gradient(to right, #07080f 20%, transparent 100%)",
        }}
      />
      {/* Edge fade — right */}
      <div
        aria-hidden="true"
        style={{
          ...edgeFade,
          right: 0,
          opacity: canRight ? 1 : 0,
          background: "linear-gradient(to left, #07080f 20%, transparent 100%)",
        }}
      />

      {/* Chevron — left */}
      {overflowing && (
        <button
          type="button"
          aria-label="Scroll left"
          className="chevBtn"
          onClick={() => scrollBy(-1)}
          disabled={!canLeft}
          style={{
            ...chevBtn,
            left: 4,
            opacity: chevronBaseOpacity,
            ...(canLeft ? {} : { opacity: 0, pointerEvents: "none" }),
          }}
        >
          <ChevLeft />
        </button>
      )}

      {/* Scroller */}
      <div ref={scrollerRef} style={stripScroller} className="ucScroller">
        {children}
      </div>

      {/* Chevron — right */}
      {overflowing && (
        <button
          type="button"
          aria-label="Scroll right"
          className="chevBtn"
          onClick={() => scrollBy(1)}
          disabled={!canRight}
          style={{
            ...chevBtn,
            right: 4,
            opacity: chevronBaseOpacity,
            ...(canRight ? {} : { opacity: 0, pointerEvents: "none" }),
          }}
        >
          <ChevRight />
        </button>
      )}
    </div>
  );
}

/* ── Icons ── */
function HomeIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M3 10.5L12 3l9 7.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M5 9.5V21h14V9.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M10 21v-6h4v6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function ChevLeft() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M15 18l-6-6 6-6" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function ChevRight() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/* ── Styles ── */
const navWrap: CSSProperties = {
  position: "sticky",
  top: 0,
  zIndex: 100,
  background: "rgba(7,8,15,0.85)",
  backdropFilter: "blur(16px)",
  WebkitBackdropFilter: "blur(16px)",
  borderBottom: "1px solid rgba(255,255,255,0.07)",
  fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif",
};

const navInner: CSSProperties = {
  maxWidth: 1240,
  margin: "0 auto",
  padding: "9px 16px",
  display: "flex",
  alignItems: "center",
  gap: 14,
};

const navLeft: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  flex: "0 0 auto",
};

const brandStyle: CSSProperties = {
  fontSize: 15,
  display: "flex",
  alignItems: "baseline",
  whiteSpace: "nowrap",
};

const stripRoot: CSSProperties = {
  position: "relative",
  flex: "1 1 auto",
  minWidth: 0,
};

const stripScroller: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  overflowX: "auto",
  overflowY: "hidden",
  padding: "3px 36px",
  scrollbarWidth: "none",
  msOverflowStyle: "none",
  WebkitOverflowScrolling: "touch",
};

const edgeFade: CSSProperties = {
  position: "absolute",
  top: 0,
  bottom: 0,
  width: 40,
  pointerEvents: "none",
  transition: "opacity 160ms ease",
  zIndex: 2,
};

const chevBtn: CSSProperties = {
  position: "absolute",
  top: "50%",
  transform: "translateY(-50%)",
  width: 26,
  height: 26,
  borderRadius: 999,
  border: "1px solid rgba(255,255,255,0.10)",
  background: "rgba(255,255,255,0.06)",
  display: "grid",
  placeItems: "center",
  cursor: "pointer",
  color: "rgba(255,255,255,0.75)",
  zIndex: 3,
  transition: "opacity 160ms ease, background 130ms ease",
};

const pillBase: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "7px 12px",
  borderRadius: 10,
  border: "1px solid rgba(255,255,255,0.08)",
  background: "rgba(255,255,255,0.04)",
  textDecoration: "none",
  fontSize: 13,
  whiteSpace: "nowrap",
  flex: "0 0 auto",
  color: "inherit",
};

const pillActiveBase: CSSProperties = {
  background: "rgba(255,255,255,0.1)",
  borderColor: "rgba(255,255,255,0.2)",
};

const numStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 800,
  letterSpacing: "0.05em",
  lineHeight: 1,
  flexShrink: 0,
};

const segBase: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  padding: "7px 10px",
  textDecoration: "none",
  fontSize: 13,
  whiteSpace: "nowrap",
  flexShrink: 0,
};
