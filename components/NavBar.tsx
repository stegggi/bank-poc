import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
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
  // placeholders (safe even if you never pass these)
  | "uc4"
  | "uc5"
  | "uc6"
  | "uc7";

type NavBarProps = { active?: NavActive };

export default function NavBar({ active }: NavBarProps) {
  const isBankA = active === "bank-a" || active === "bankA";
  const isBankB = active === "bank-b" || active === "bankB";
  const isKyc = active === "kyc-badge";
  const isUc4 = active === "uc4" || active === "context-vault";
  const isUc5 = active === "uc5";
  const isUc6 = active === "uc6";

  const groups = useMemo<
    Array<{
      uc: string;
      title: string;
      items:
        | {
            kind: "pills";
            pills: Array<{ href: string; label: string; on: boolean; disabled?: boolean }>;
          }
        | {
            kind: "segmented";
            left: { href: string; label: string; on: boolean };
            right: { href: string; label: string; on: boolean };
          };
    }>
  >(
    () => [
      {
        uc: "UC1",
        title: "eBanking",
        items: {
          kind: "pills",
          pills: [{ href: "/ebanking", label: "Open crypto wallet", on: active === "ebanking" }],
        },
      },
      {
        uc: "UC2",
        title: "Interbank Payment",
        items: {
          kind: "segmented",
          left: { href: "/bank-a", label: "Bank A", on: isBankA },
          right: { href: "/bank-b", label: "Bank B", on: isBankB },
        },
      },
      {
        uc: "UC3",
        title: "Trust credential",
        items: {
          kind: "pills",
          pills: [{ href: "/kyc-badge", label: "KYC badge", on: isKyc }],
        },
      },
      {
        uc: "UC4",
        title: "Context Passport",
        items: {
          kind: "pills",
          pills: [{ href: "/context-vault", label: "Context vault", on: isUc4 }],
        },
      },
      {
        uc: "UC5",
        title: "Shared state",
        items: {
          kind: "pills",
          pills: [{ href: "/uc5", label: "State demo", on: isUc5 }],
        },
      },
      {
        uc: "UC6",
        title: "LP automation",
        items: {
          kind: "pills",
          pills: [{ href: "/uc6", label: "UC6: LP Bot", on: isUc6 }],
        },
      },

      // Placeholders (disabled so they don’t navigate)
    ],
    [active, isBankA, isBankB, isKyc, isUc4, isUc5, isUc6]
  );

  return (
    <nav style={styles.wrap} aria-label="Primary">
      <style jsx>{`
        /* Hide scrollbar everywhere (visual) while keeping scroll functionality */
        .ucScroller {
          scrollbar-width: none; /* Firefox */
          -ms-overflow-style: none; /* IE/old Edge */
        }
        .ucScroller::-webkit-scrollbar {
          display: none; /* Chrome/Safari */
          width: 0;
          height: 0;
        }

        .cluster {
          transition: transform 150ms ease, box-shadow 150ms ease, border-color 150ms ease;
        }
        .cluster:hover {
          transform: translateY(-1px);
          box-shadow: 0 10px 30px rgba(0, 0, 0, 0.06);
          border-color: rgba(0, 0, 0, 0.16);
        }

        .pill,
        .segment,
        .iconPill,
        .chevBtn {
          transition: transform 140ms ease, background 140ms ease, color 140ms ease,
            border-color 140ms ease, opacity 140ms ease;
          outline: none;
        }
        .pill:hover:not([data-disabled="true"]),
        .segment:hover,
        .iconPill:hover {
          transform: translateY(-1px);
        }
        .pill:focus-visible,
        .segment:focus-visible,
        .iconPill:focus-visible,
        .chevBtn:focus-visible {
          box-shadow: 0 0 0 4px rgba(0, 0, 0, 0.12);
        }

        /* Arrows fade in on hover (desktop), but stay usable always */
        .stripOuter:hover .chevBtn {
          opacity: 1 !important;
        }
      `}</style>

      <div style={styles.inner}>
        {/* Left: Brand + Home icon */}
        <div style={styles.left}>
          <div style={styles.brand}>
            <span style={{ fontWeight: 950, letterSpacing: -0.2 }}>blockchain</span>
            <span style={{ opacity: 0.6, marginLeft: 6 }}>concept bank</span>
          </div>

          <IconPill href="/" active={active === "home"} ariaLabel="Home">
            <HomeIcon active={active === "home"} />
          </IconPill>
        </div>

        {/* Right: scalable strip */}
        <UseCaseStrip activeKey={active || ""}>
          {groups.map((g) => {
            const clusterActive =
              g.items.kind === "pills"
                ? g.items.pills.some((p) => p.on)
                : g.items.left.on || g.items.right.on;

            return (
              <UseCaseCluster key={g.uc} uc={g.uc} title={g.title} active={clusterActive}>
                {g.items.kind === "pills" ? (
                  <div style={styles.pillRow}>
                    {g.items.pills.map((p) => (
                      <PillLink key={p.label} href={p.href} active={p.on} disabled={!!p.disabled}>
                        {p.label}
                      </PillLink>
                    ))}
                  </div>
                ) : (
                  <div style={styles.segmented}>
                    <Segment href={g.items.left.href} active={g.items.left.on} side="left">
                      {g.items.left.label}
                    </Segment>
                    <div style={styles.segmentDivider} />
                    <Segment href={g.items.right.href} active={g.items.right.on} side="right">
                      {g.items.right.label}
                    </Segment>
                  </div>
                )}
              </UseCaseCluster>
            );
          })}
        </UseCaseStrip>
      </div>
    </nav>
  );
}

/** ---- Strip / scrolling logic (auto-disabling arrows + fades + auto-scroll active) ---- */

function UseCaseStrip({ children, activeKey }: { children: ReactNode; activeKey: string }) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);

  const [overflowing, setOverflowing] = useState(false);
  const [canLeft, setCanLeft] = useState(false);
  const [canRight, setCanRight] = useState(false);
  const [coarsePointer, setCoarsePointer] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia?.("(pointer: coarse)");
    if (!mq) return;
    const update = () => setCoarsePointer(!!mq.matches);
    update();
    mq.addEventListener?.("change", update);
    return () => mq.removeEventListener?.("change", update);
  }, []);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;

    let raf = 0;

    const update = () => {
      const max = el.scrollWidth - el.clientWidth;
      const hasOverflow = max > 1;
      setOverflowing(hasOverflow);

      if (!hasOverflow) {
        setCanLeft(false);
        setCanRight(false);
        return;
      }

      setCanLeft(el.scrollLeft > 1);
      setCanRight(el.scrollLeft < max - 1);
    };

    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = window.requestAnimationFrame(update);
    };

    el.addEventListener("scroll", onScroll, { passive: true });

    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(onScroll);
      ro.observe(el);
    }
    window.addEventListener("resize", onScroll);

    update();

    return () => {
      el.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (ro) ro.disconnect();
      cancelAnimationFrame(raf);
    };
  }, []);

  // Keep active cluster visible
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const active = el.querySelector<HTMLElement>('[data-active-cluster="true"]');
    if (!active) return;

    const a = active.getBoundingClientRect();
    const s = el.getBoundingClientRect();
    const mostlyVisible = a.left >= s.left + 10 && a.right <= s.right - 10;
    if (mostlyVisible) return;

    active.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
  }, [activeKey]);

  const scrollByStep = (dir: -1 | 1) => {
    const el = scrollerRef.current;
    if (!el) return;
    const step = Math.max(240, Math.floor(el.clientWidth * 0.6));
    el.scrollBy({ left: dir * step, behavior: "smooth" });
  };

  const baseOpacity = coarsePointer ? 0.95 : 0.22;

  return (
    <div style={styles.stripOuter} className="stripOuter">
      {overflowing && (
        <>
          <div
            aria-hidden="true"
            style={{
              ...styles.edgeFade,
              left: 0,
              opacity: canLeft ? 1 : 0,
              background:
                "linear-gradient(90deg, rgba(255,255,255,0.96) 0%, rgba(255,255,255,0.0) 100%)",
            }}
          />
          <div
            aria-hidden="true"
            style={{
              ...styles.edgeFade,
              right: 0,
              opacity: canRight ? 1 : 0,
              background:
                "linear-gradient(270deg, rgba(255,255,255,0.96) 0%, rgba(255,255,255,0.0) 100%)",
            }}
          />
        </>
      )}

      {overflowing && (
        <button
          type="button"
          aria-label="Scroll left"
          onClick={() => scrollByStep(-1)}
          disabled={!canLeft}
          className="chevBtn"
          style={{
            ...styles.chevronBtn,
            ...styles.chevLeft,
            opacity: baseOpacity,
            ...(canLeft ? null : styles.chevDisabled),
          }}
        >
          <ChevronLeft />
        </button>
      )}

      <div ref={scrollerRef} style={styles.stripScroller} className="ucScroller">
        {children}
      </div>

      {overflowing && (
        <button
          type="button"
          aria-label="Scroll right"
          onClick={() => scrollByStep(1)}
          disabled={!canRight}
          className="chevBtn"
          style={{
            ...styles.chevronBtn,
            ...styles.chevRight,
            opacity: baseOpacity,
            ...(canRight ? null : styles.chevDisabled),
          }}
        >
          <ChevronRight />
        </button>
      )}
    </div>
  );
}

function UseCaseCluster({
  uc,
  title,
  children,
  active,
}: {
  uc: string;
  title: string;
  children: ReactNode;
  active?: boolean;
}) {
  return (
    <div
      className="cluster"
      data-active-cluster={active ? "true" : "false"}
      style={{
        ...styles.cluster,
        ...(active ? styles.clusterActive : null),
      }}
      title={`${uc}: ${title}`}
      aria-label={`${uc}: ${title}`}
    >
      <div style={styles.clusterMeta}>
        <span style={styles.ucTitle}>{`${uc}: ${title}`}</span>
      </div>
      {children}
    </div>
  );
}

/** ---- Link pills ---- */

function PillLink({
  href,
  active,
  disabled,
  children,
}: {
  href: string;
  active?: boolean;
  disabled?: boolean;
  children: ReactNode;
}) {
  if (disabled) {
    return (
      <span
        className="pill"
        data-disabled="true"
        style={{
          ...styles.pill,
          ...styles.pillDisabled,
          ...(active ? styles.pillActive : null),
        }}
        title="Coming soon"
      >
        {children}
      </span>
    );
  }

  return (
    <Link
      href={href}
      className="pill"
      style={{
        ...styles.pill,
        ...(active ? styles.pillActive : null),
      }}
    >
      {children}
    </Link>
  );
}

function Segment({
  href,
  active,
  side,
  children,
}: {
  href: string;
  active?: boolean;
  side: "left" | "right";
  children: ReactNode;
}) {
  const radius = side === "left" ? "999px 0 0 999px" : "0 999px 999px 0";
  return (
    <Link
      href={href}
      className="segment"
      style={{
        ...styles.segment,
        borderRadius: radius,
        ...(active ? styles.segmentActive : null),
      }}
    >
      {children}
    </Link>
  );
}

function IconPill({
  href,
  active,
  ariaLabel,
  children,
}: {
  href: string;
  active?: boolean;
  ariaLabel: string;
  children: ReactNode;
}) {
  return (
    <Link
      href={href}
      aria-label={ariaLabel}
      title={ariaLabel}
      className="iconPill"
      style={{
        width: 40,
        height: 40,
        borderRadius: 14,
        display: "grid",
        placeItems: "center",
        textDecoration: "none",
        border: "1px solid rgba(0,0,0,0.10)",
        background: active ? "#0b0b0c" : "rgba(255,255,255,0.9)",
        color: active ? "#fff" : "#111",
        boxShadow: active ? "0 10px 28px rgba(0,0,0,0.18)" : "0 10px 28px rgba(0,0,0,0.06)",
        flex: "0 0 auto",
      }}
    >
      {children}
    </Link>
  );
}

/** ---- Icons ---- */

function HomeIcon({ active }: { active?: boolean }) {
  const stroke = active ? "#fff" : "#111";
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M3 10.5L12 3l9 7.5"
        stroke={stroke}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M5 9.5V21h14V9.5"
        stroke={stroke}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M10 21v-6h4v6"
        stroke={stroke}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ChevronLeft() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M15 18l-6-6 6-6"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ChevronRight() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M9 6l6 6-6 6"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** ---- Styles ---- */

const styles: Record<string, CSSProperties> = {
  wrap: {
    position: "sticky",
    top: 0,
    zIndex: 100,
    background: "rgba(255,255,255,0.82)",
    backdropFilter: "blur(10px)",
    borderBottom: "1px solid rgba(0,0,0,0.06)",
  },
  inner: {
    maxWidth: 1240,
    margin: "0 auto",
    padding: "10px 16px",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 18,
    flexWrap: "nowrap",
  },
  left: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    flexWrap: "nowrap",
    flex: "0 0 auto",
  },
  brand: {
    fontSize: 18,
    display: "flex",
    alignItems: "baseline",
    whiteSpace: "nowrap",
  },

  stripOuter: {
    position: "relative",
    flex: "1 1 auto",
    minWidth: 0,
  },
  stripScroller: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    overflowX: "auto",
    overflowY: "hidden",
    whiteSpace: "nowrap",
    padding: "2px 46px",
    scrollBehavior: "smooth",
    WebkitOverflowScrolling: "touch",
    scrollSnapType: "x proximity",

    // extra inline hardening for scrollbar hiding
    scrollbarWidth: "none",
    msOverflowStyle: "none",
  },

  edgeFade: {
    position: "absolute",
    top: 0,
    bottom: 0,
    width: 46,
    pointerEvents: "none",
    transition: "opacity 160ms ease",
    zIndex: 2,
  },

  chevronBtn: {
    position: "absolute",
    top: "50%",
    transform: "translateY(-50%)",
    width: 30,
    height: 30,
    borderRadius: 999,
    border: "1px solid rgba(0,0,0,0.10)",
    background: "rgba(255,255,255,0.92)",
    backdropFilter: "blur(10px)",
    display: "grid",
    placeItems: "center",
    cursor: "pointer",
    color: "#111",
    boxShadow: "0 10px 28px rgba(0,0,0,0.08)",
    zIndex: 3,
  },
  chevLeft: { left: 8 },
  chevRight: { right: 8 },
  chevDisabled: {
    opacity: 0.2,
    cursor: "not-allowed",
  },

  cluster: {
    display: "inline-flex",
    alignItems: "center",
    gap: 10,
    border: "1px solid rgba(0,0,0,0.10)",
    background: "rgba(250,250,250,0.92)",
    borderRadius: 999,
    padding: "6px 10px",
    flex: "0 0 auto",
    scrollSnapAlign: "start",
  },
  clusterActive: {
    borderColor: "rgba(0,0,0,0.22)",
    boxShadow: "0 10px 28px rgba(0,0,0,0.08)",
    background: "rgba(255,255,255,0.96)",
  },
  clusterMeta: {
    display: "inline-flex",
    alignItems: "center",
    flex: "0 0 auto",
  },

  // Plain title text (no extra pill)
  ucTitle: {
    fontSize: 12,
    fontWeight: 900,
    color: "rgba(0,0,0,0.62)",
    maxWidth: 240,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    lineHeight: 1,
    paddingRight: 2,
  },

  pillRow: {
    display: "inline-flex",
    alignItems: "center",
    gap: 8,
    flex: "0 0 auto",
  },
  pill: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    textDecoration: "none",
    border: "1px solid rgba(0,0,0,0.10)",
    background: "rgba(255,255,255,0.95)",
    borderRadius: 999,
    padding: "8px 10px",
    fontSize: 13,
    fontWeight: 850,
    color: "rgba(0,0,0,0.78)",
    lineHeight: 1,
    whiteSpace: "nowrap",
    flex: "0 0 auto",
  },
  pillActive: {
    background: "#0b0b0c",
    borderColor: "#0b0b0c",
    color: "#fff",
    boxShadow: "0 10px 26px rgba(0,0,0,0.18)",
  },
  pillDisabled: {
    opacity: 0.55,
    cursor: "default",
  },

  segmented: {
    display: "inline-flex",
    alignItems: "stretch",
    borderRadius: 999,
    border: "1px solid rgba(0,0,0,0.10)",
    background: "rgba(255,255,255,0.95)",
    overflow: "hidden",
    flex: "0 0 auto",
  },
  segmentDivider: {
    width: 1,
    background: "rgba(0,0,0,0.10)",
  },
  segment: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    textDecoration: "none",
    padding: "8px 10px",
    fontSize: 13,
    fontWeight: 850,
    color: "rgba(0,0,0,0.78)",
    lineHeight: 1,
    whiteSpace: "nowrap",
    flex: "0 0 auto",
  },
  segmentActive: {
    background: "#0b0b0c",
    color: "#fff",
  },
};
