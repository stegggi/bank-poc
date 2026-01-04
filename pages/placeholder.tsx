// pages/placeholder.tsx
import type { CSSProperties } from "react";
import NavBar from "../components/NavBar";

export default function PlaceholderUseCase() {
  return (
    <>
      <NavBar active={"placeholder" as any} />

      <div style={wrap}>
        <div style={panel}>
          <h1 style={{ margin: 0, fontSize: 28, letterSpacing: -0.2 }}>
            Use case 4: Placeholder
          </h1>
          <p style={{ marginTop: 12, color: "#555", lineHeight: 1.55, maxWidth: 900 }}>
            This is a placeholder slot for the next module. It exists so the navigation can scale to many use cases
            without the navbar getting taller.
          </p>
        </div>
      </div>
    </>
  );
}

const wrap: CSSProperties = {
  maxWidth: 1100,
  margin: "0 auto",
  padding: "18px 16px",
};

const panel: CSSProperties = {
  border: "1px solid #e6e8eb",
  background: "#fff",
  borderRadius: 16,
  padding: 16,
  boxShadow: "0 1px 0 rgba(0,0,0,0.02)",
};

const callout: CSSProperties = {
  marginTop: 14,
  border: "1px solid #e6e8eb",
  background: "#fafafa",
  borderRadius: 14,
  padding: "12px 14px",
};
