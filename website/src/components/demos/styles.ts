import type { CSSProperties } from "react";

export const row: CSSProperties = { alignItems: "center", display: "flex", flexWrap: "wrap", gap: "0.5rem" };

export const button: CSSProperties = {
  border: "1px solid color-mix(in srgb, currentColor 35%, transparent)",
  borderRadius: 6,
  cursor: "pointer",
  font: "inherit",
  padding: "0.25rem 0.75rem",
};

export const field: CSSProperties = {
  border: "1px solid color-mix(in srgb, currentColor 35%, transparent)",
  borderRadius: 6,
  font: "inherit",
  padding: "0.25rem 0.5rem",
};

export const muted: CSSProperties = { fontSize: "0.85rem", opacity: 0.7 };
