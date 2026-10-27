import type { ReactNode } from "react";

/** A framed live example. Server-safe: it holds no state of its own. */
export function Demo({ title, children, note }: { title: string; children: ReactNode; note?: ReactNode }) {
  return (
    <section
      aria-label={title}
      style={{
        border: "1px solid color-mix(in srgb, currentColor 20%, transparent)",
        borderRadius: 8,
        margin: "1.25rem 0",
        padding: "0.75rem 1rem 1rem",
      }}
    >
      <div
        style={{
          fontSize: "0.75rem",
          fontWeight: 600,
          letterSpacing: "0.04em",
          opacity: 0.7,
          textTransform: "uppercase",
        }}
      >
        Live demo · {title}
      </div>
      <div style={{ marginTop: "0.75rem" }}>{children}</div>
      {note === undefined ? null : (
        <div style={{ fontSize: "0.85rem", marginTop: "0.75rem", opacity: 0.75 }}>{note}</div>
      )}
    </section>
  );
}
