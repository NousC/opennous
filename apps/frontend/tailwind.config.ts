import type { Config } from "tailwindcss";

export default {
  darkMode: ["class"],
  content: ["./pages/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}", "./app/**/*.{ts,tsx}", "./src/**/*.{ts,tsx}"],
  prefix: "",
  theme: {
    container: {
      center: true,
      padding: "2rem",
      screens: {
        "2xl": "1400px",
      },
    },
    extend: {
      animation: {
        'float': 'float 3s ease-in-out infinite',
      },
      // Motion tokens (standard 11): quick, ease-out, never bouncy.
      transitionTimingFunction: {
        out: 'var(--ease-out)',
      },
      transitionDuration: {
        fast: 'var(--dur-fast)',
        base: 'var(--dur-base)',
      },
      boxShadow: {
        card: 'var(--shadow-card)',
        pop: 'var(--shadow-pop)',
        // The search palette's shadow: every dialog, alert and sheet uses it (GET-654).
        modal: '0 24px 70px -20px rgba(0,0,0,0.4)',
      },
      keyframes: {
        float: {
          '0%, 100%': { transform: 'translate(-50%, -50%) translateY(0px)' },
          '50%': { transform: 'translate(-50%, -50%) translateY(-8px)' },
        },
      },
      // One weight scale, set by the search palette (GET-658): nothing heavier than this for a title.
      // Geist is variable, so 550 sits between medium and the old 600 that read heavy.
      fontWeight: {
        semibold: '550',
      },
      fontFamily: {
        // Default app typeface — matches the base rule in index.css so `font-sans`
        // and inherited text resolve to the same self-hosted Geist stack (GET-593).
        sans: ['Geist Variable', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'sans-serif'],
        // A document's title, and only that (GET-426). Declared rather than left to
        // Tailwind's default stack so the one place we change register is a decision
        // somebody made, and so it is the same face on every machine that has Charter.
        serif: ['Charter', 'Iowan Old Style', 'Palatino', 'Georgia', 'ui-serif', 'serif'],
        inter: ['Inter', 'sans-serif'],
        'public-sans': ['Public Sans', 'sans-serif'],
        'space-mono': ['Space Mono', 'monospace'],
        fraunces: ['Fraunces', 'Georgia', 'serif'],
        'geist-mono': ['Geist Mono Variable', 'Geist Mono', 'ui-monospace', 'SF Mono', 'Menlo', 'monospace'],
        // Times, keycaps and ids (interface refresh): Geist Mono, self-hosted like Geist.
        mono: ['Geist Mono Variable', 'Geist Mono', 'ui-monospace', 'SF Mono', 'Menlo', 'monospace'],
      },
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        // The app frame + sidebar: one step cooler than the content panel.
        frame: "hsl(var(--frame))",
        foreground: "hsl(var(--foreground))",
        // Interface refresh tokens (GET-593): secondary ink, in-card dividers, row
        // hover, and status colours for dots, small text and numbers.
        "ink-2": "hsl(var(--ink-2))",
        hairline: "hsl(var(--hairline))",
        hover: "hsl(var(--hover))",
        positive: "hsl(var(--positive))",
        warning: { DEFAULT: "hsl(var(--warning))", dot: "hsl(var(--warning-dot))" },
        risk: "hsl(var(--risk))",
        brand: "hsl(var(--brand))",
        // Landing page color palette
        'landing-orange': '#f8f1e1',
        'landing-green': '#1e3429',
        'landing-yellow': '#eaf62f',
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        sidebar: {
          DEFAULT: "hsl(var(--sidebar-background))",
          foreground: "hsl(var(--sidebar-foreground))",
          primary: "hsl(var(--sidebar-primary))",
          "primary-foreground": "hsl(var(--sidebar-primary-foreground))",
          accent: "hsl(var(--sidebar-accent))",
          "accent-foreground": "hsl(var(--sidebar-accent-foreground))",
          border: "hsl(var(--sidebar-border))",
          ring: "hsl(var(--sidebar-ring))",
        },
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      keyframes: {
        "accordion-down": {
          from: {
            height: "0",
          },
          to: {
            height: "var(--radix-accordion-content-height)",
          },
        },
        "accordion-up": {
          from: {
            height: "var(--radix-accordion-content-height)",
          },
          to: {
            height: "0",
          },
        },
        float: {
          '0%, 100%': { transform: 'translate(-50%, -50%) translateY(0px)' },
          '50%': { transform: 'translate(-50%, -50%) translateY(-8px)' },
        },
        marquee: {
          '0%': { transform: 'translateX(0)' },
          '100%': { transform: 'translateX(-50%)' },
        },
        // Onboarding modal transitions - minimal, clean slide
        "onboarding-slide-in": {
          from: { opacity: "0", transform: "translate(calc(-50% + 16px), -50%)" },
          to: { opacity: "1", transform: "translate(-50%, -50%)" },
        },
        "onboarding-slide-out": {
          from: { opacity: "1", transform: "translate(-50%, -50%)" },
          to: { opacity: "0", transform: "translate(calc(-50% - 16px), -50%)" },
        },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
        float: "float 3s ease-in-out infinite",
        marquee: "marquee 30s linear infinite",
        // Onboarding modal transitions - fast and minimal
        "onboarding-in": "onboarding-slide-in 0.15s cubic-bezier(0.16, 1, 0.3, 1)",
        "onboarding-out": "onboarding-slide-out 0.12s cubic-bezier(0.16, 1, 0.3, 1)",
      },
    },
  },
  plugins: [
    require("tailwindcss-animate"),
    require("@tailwindcss/typography"),
  ],
} satisfies Config;
