interface NousLegalFooterProps {
  scheme?: "dark" | "light";
}

export function NousLegalFooter({ scheme = "dark" }: NousLegalFooterProps) {
  const isDark = scheme === "dark";

  const textColor = isDark ? "rgba(200,216,236,0.55)" : "rgba(12,24,39,0.45)";
  const textHover = isDark ? "rgba(200,216,236,0.9)" : "rgba(12,24,39,0.85)";
  const copyright = isDark ? "rgba(200,216,236,0.4)" : "rgba(12,24,39,0.35)";
  const border = "none";

  const links = [
    { label: "Privacy Policy", href: "/privacy" },
    { label: "Terms of Service", href: "/terms" },
    { label: "Cookie Policy", href: "/cookies" },
    { label: "Impressum", href: "/impressum" },
  ];

  return (
    <footer style={{ background: "transparent", borderTop: border, padding: "22px 64px" }}>
      <div style={{ maxWidth: "1040px", margin: "0 auto", display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: "12px" }}>
        <p style={{ fontFamily: "JetBrains Mono, monospace", fontSize: "11px", color: copyright, letterSpacing: "0.02em" }}>
          © {new Date().getFullYear()} Nous. All rights reserved.
        </p>
        <div style={{ display: "flex", gap: "24px", flexWrap: "wrap" }}>
          {links.map(({ label, href }) => (
            <a key={label} href={href}
              style={{ fontFamily: "JetBrains Mono, monospace", fontSize: "11px", color: textColor, textDecoration: "none", letterSpacing: "0.02em", transition: "color 0.2s" }}
              onMouseEnter={e => (e.currentTarget.style.color = textHover)}
              onMouseLeave={e => (e.currentTarget.style.color = textColor)}>
              {label}
            </a>
          ))}
        </div>
      </div>
    </footer>
  );
}
