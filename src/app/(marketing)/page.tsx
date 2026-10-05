import Link from "next/link";

const PERSONAL_WORKSPACE_ITEMS = ["Personal Dashboard", "Connections", "Agreements", "Payments", "Profile"];

/**
 * Must match AppNav.tsx's BUSINESS_NAV_ITEMS exactly — those are the only Business destinations
 * with real, launched functionality today. Never promote an item out of the "coming soon" list here
 * before it has a real nav entry in AppNav.tsx.
 */
const BUSINESS_LIVE_ITEMS = [
  "Dashboard",
  "Outstanding Balances",
  "Customers",
  "Agreements",
  "Employees",
  "Organization Settings",
  "Billing & Subscription",
];

/** Pages exist and are permission-checked, but intentionally have no nav entry yet (AppNav.tsx) — never shown as "available" here. */
const BUSINESS_COMING_SOON_ITEMS = ["Payments", "Reports", "Reconciliation", "Documents", "Audit History", "Integrations"];

const INDUSTRIES: ReadonlyArray<{
  name: string;
  body: string;
  icon: "truck" | "freight" | "warehouse" | "storefront";
  features: readonly string[];
}> = [
  {
    name: "Trucking",
    body: "Keep drivers, customers, and payments moving.",
    icon: "truck",
    features: ["Outstanding driver or customer balances", "Route-level payment follow-up", "Document-backed repayment visibility"],
  },
  {
    name: "Freight",
    body: "Coordinate payments across brokers and carriers.",
    icon: "freight",
    features: ["Broker/carrier payment coordination", "Payment tracking across parties", "Faster arrangement follow-through"],
  },
  {
    name: "3PL",
    body: "Manage multiple customers with complete visibility.",
    icon: "warehouse",
    features: ["Multi-customer balance management", "Centralized reporting and reconciliation", "Team-based account oversight"],
  },
  {
    name: "Retail",
    body: "Simplify high-volume customer repayments.",
    icon: "storefront",
    features: ["High-volume customer repayment management", "Store/location visibility", "Payment documentation and audit trail"],
  },
];

function IndustryIcon({ name }: { name: string }) {
  if (name === "truck") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M2.75 6.75h10.5v9H2.75z" />
        <path d="M13.25 10.25h4.1l3.9 3.1v2.4h-8z" />
        <circle cx="6.5" cy="17.75" r="1.6" />
        <circle cx="17" cy="17.75" r="1.6" />
      </svg>
    );
  }

  if (name === "freight") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M3.25 7.25 12 3.5l8.75 3.75v9.5L12 20.5l-8.75-3.75Z" />
        <path d="M3.25 7.25 12 11l8.75-3.75M12 11v9.5" />
      </svg>
    );
  }

  if (name === "warehouse") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M2.75 10.25 12 4.75l9.25 5.5v8.25H2.75Z" />
        <path d="M8.5 18.5v-5.25h7V18.5" />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3.5 9.25h17l-1.4-4.5h-14.2Z" />
      <path d="M4.25 9.25V19h15.5V9.25" />
      <path d="M9.5 19v-4.25h5V19" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg className="industry-check" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="7.25" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M5 8.3 7 10.3 11.2 5.9" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Small decorative landscape accent for the personal-workspace welcome banner — original shapes, no photography, no people. */
function HorizonScene() {
  return (
    <svg className="workspace-preview__scene" viewBox="0 0 64 48" aria-hidden="true">
      <rect width="64" height="48" rx="8" fill="#dbe8fd" />
      <circle cx="48" cy="14" r="7" fill="#fde9b8" />
      <path d="M0 40 18 22 30 34 42 18 64 40Z" fill="#9fc3f5" opacity="0.85" />
      <path d="M0 44 22 28 34 38 46 24 64 44Z" fill="#6fa0e8" />
    </svg>
  );
}

/** Original, license-free illustrated "scenes" standing in for photography — flat shapes only, never a real/implied photo, never a human face. */
function DeskScene() {
  return (
    <svg className="workspace-card__scene" viewBox="0 0 320 120" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <rect width="320" height="120" fill="#eaf1fd" />
      <circle cx="268" cy="30" r="22" fill="#fde9b8" />
      <rect x="36" y="70" width="140" height="8" rx="4" fill="#c7d8f5" />
      <rect x="50" y="52" width="112" height="22" rx="3" fill="#10234a" />
      <rect x="56" y="57" width="100" height="12" rx="2" fill="#2f74e0" />
      <rect x="92" y="74" width="28" height="10" fill="#9fb3d6" />
      <path d="M210 90c0-26 14-40 14-40s14 14 14 40Z" fill="#16a34a" />
      <rect x="221" y="86" width="6" height="18" fill="#7a5230" />
    </svg>
  );
}

function RoadScene() {
  return (
    <svg className="workspace-card__scene" viewBox="0 0 320 120" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <rect width="320" height="120" fill="#dcebff" />
      <circle cx="60" cy="28" r="20" fill="#fcd9a0" />
      <path d="M0 96h320v24H0Z" fill="#415272" />
      <path d="M20 108h26M70 108h26M120 108h26M170 108h26M220 108h26M270 108h26" stroke="#dfe6f3" strokeWidth="4" strokeLinecap="round" />
      <rect x="150" y="56" width="80" height="34" rx="4" fill="#155fd4" />
      <rect x="226" y="66" width="32" height="24" rx="3" fill="#10234a" />
      <rect x="232" y="70" width="12" height="10" fill="#cfe0ff" />
      <circle cx="172" cy="94" r="9" fill="#1b2435" />
      <circle cx="238" cy="94" r="9" fill="#1b2435" />
    </svg>
  );
}

function ContainersScene() {
  return (
    <svg className="industry-card__scene" viewBox="0 0 320 100" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <rect width="320" height="100" fill="#def4ec" />
      <rect x="20" y="40" width="70" height="36" fill="#0f7a53" />
      <rect x="96" y="40" width="70" height="36" fill="#2f9d6f" />
      <rect x="172" y="40" width="70" height="36" fill="#155fd4" />
      <rect x="20" y="20" width="70" height="18" fill="#2f9d6f" />
      <rect x="96" y="20" width="70" height="18" fill="#0f7a53" />
      <rect x="248" y="30" width="52" height="46" fill="#10234a" />
      <rect x="258" y="38" width="14" height="12" fill="#cfe0ff" />
    </svg>
  );
}

function WarehouseScene() {
  return (
    <svg className="industry-card__scene" viewBox="0 0 320 100" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <rect width="320" height="100" fill="#ece4fd" />
      <rect x="24" y="18" width="270" height="12" fill="#6d3fd6" opacity="0.5" />
      <rect x="24" y="40" width="270" height="12" fill="#6d3fd6" opacity="0.5" />
      <rect x="24" y="62" width="270" height="12" fill="#6d3fd6" opacity="0.5" />
      <rect x="44" y="20" width="18" height="18" fill="#f8b24a" />
      <rect x="90" y="42" width="18" height="18" fill="#f8b24a" />
      <rect x="150" y="20" width="18" height="18" fill="#f8b24a" />
      <rect x="210" y="64" width="18" height="18" fill="#f8b24a" />
      <rect x="250" y="70" width="30" height="20" fill="#10234a" />
      <rect x="252" y="60" width="4" height="12" fill="#10234a" />
    </svg>
  );
}

function StorefrontScene() {
  return (
    <svg className="industry-card__scene" viewBox="0 0 320 100" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <rect width="320" height="100" fill="#ffe9d6" />
      <rect x="40" y="36" width="240" height="48" fill="#ffffff" stroke="#f0c391" strokeWidth="2" />
      <rect x="40" y="24" width="240" height="16" fill="#c2590a" />
      <rect x="40" y="24" width="30" height="16" fill="#ffffff" opacity="0.4" />
      <rect x="100" y="24" width="30" height="16" fill="#ffffff" opacity="0.4" />
      <rect x="160" y="24" width="30" height="16" fill="#ffffff" opacity="0.4" />
      <rect x="220" y="24" width="30" height="16" fill="#ffffff" opacity="0.4" />
      <rect x="58" y="48" width="60" height="36" fill="#dceafd" />
      <rect x="140" y="58" width="36" height="26" fill="#c2590a" />
      <rect x="196" y="48" width="60" height="36" fill="#dceafd" />
    </svg>
  );
}

function IndustryScene({ icon }: { icon: string }) {
  if (icon === "truck") return <RoadScene />;
  if (icon === "freight") return <ContainersScene />;
  if (icon === "warehouse") return <WarehouseScene />;
  return <StorefrontScene />;
}

function HeroVisual() {
  return (
    <>
      <div className="hero-visual" aria-hidden="true">
        <div className="workspace-preview">
          <div className="workspace-preview__bar">
            <div className="workspace-preview__title">
              <i>P</i>
              <div>
                <strong>My Paid2You</strong>
                <small>Personal Account</small>
              </div>
            </div>
            <div className="workspace-preview__bar-actions">
              <span className="workspace-preview__bell">🔔</span>
              <span className="workspace-preview__avatar">●</span>
            </div>
          </div>
          <div className="workspace-preview__body">
            <div className="workspace-preview__banner">
              <div>
                <strong>Welcome back</strong>
                <p>Manage your agreements, payments, and connections all in one place.</p>
              </div>
              <HorizonScene />
            </div>
            <div className="workspace-preview__stats">
              <div>
                <div>
                  <span>Agreements</span>
                  <strong>12</strong>
                </div>
                <em>›</em>
              </div>
              <div>
                <div>
                  <span>Payments</span>
                  <strong>$3,280</strong>
                </div>
                <em>›</em>
              </div>
              <div>
                <div>
                  <span>Connections</span>
                  <strong>8</strong>
                </div>
                <em>›</em>
              </div>
              <div>
                <div>
                  <span>Profile</span>
                  <strong>Complete</strong>
                </div>
                <em>›</em>
              </div>
            </div>
          </div>
        </div>

        <div className="workspace-preview workspace-preview--business">
          <div className="workspace-preview__bar">
            <div className="workspace-preview__title">
              <i>B</i>
              <div>
                <strong>Sample Trucking Co.</strong>
                <small>Business Account</small>
              </div>
            </div>
            <div className="workspace-preview__bar-actions">
              <span className="workspace-preview__bell">🔔</span>
              <span className="workspace-preview__avatar">●</span>
            </div>
          </div>
          <div className="workspace-preview__body">
            <div className="workspace-preview__banner workspace-preview__banner--business">
              <div className="workspace-preview__banner-row">
                <span>Growth Plan · 312 / 499 arrangements</span>
                <a href="#business-workspace">Manage Plan</a>
              </div>
              <div className="workspace-preview__progress">
                <span style={{ width: "63%" }} />
              </div>
            </div>
            <div className="workspace-preview__stats">
              <div>
                <div>
                  <span>Outstanding Balances</span>
                  <strong>$48,200</strong>
                </div>
                <em>›</em>
              </div>
              <div>
                <div>
                  <span>Customers</span>
                  <strong>36</strong>
                </div>
                <em>›</em>
              </div>
              <div>
                <div>
                  <span>Employees</span>
                  <strong>14</strong>
                </div>
                <em>›</em>
              </div>
              <div>
                <div>
                  <span>Agreements</span>
                  <strong>27</strong>
                </div>
                <em>›</em>
              </div>
            </div>
          </div>
        </div>
      </div>
      <p className="hero-visual__caption">
        Example data shown for illustration only — not a real account, business, or balance.
      </p>
    </>
  );
}

export default function HomePage() {
  return (
    <>
      <section className="hero" aria-labelledby="hero-heading">
        <div className="hero__copy">
          <span className="eyebrow eyebrow--brand">
            <span /> Agreements. Payments. Connections.
          </span>
          <h1 id="hero-heading">
            One account. <em>Business</em> and <em>Personal.</em>
          </h1>
          <p className="hero__lede">
            One Paid2You identity gives you a free personal workspace for agreements, payments, and
            connections — and the option to create subscription-based business organizations for teams,
            balances, customers, documents, and reporting.
          </p>
          <div className="hero__actions">
            <div className="button-group">
              <Link className="button button--primary button--large" href="/signup?accountType=business">
                Create Business Account <span aria-hidden="true">→</span>
              </Link>
              <span className="button-group__caption">For teams, fleets, 3PLs, and businesses</span>
            </div>
            <div className="button-group">
              <Link className="button button--ghost button--large" href="/signup?accountType=personal">
                Create Personal Account <span aria-hidden="true">→</span>
              </Link>
              <span className="button-group__caption">Free • Get started in minutes</span>
            </div>
          </div>
          <p className="preview-note">
            Already have an account? <Link href="/login">Sign in</Link>.
          </p>
        </div>
        <HeroVisual />
      </section>

      <section className="section" aria-labelledby="workspaces-heading">
        <div className="section-heading section-heading--brand">
          <h2 id="workspaces-heading">Two powerful workspaces. One platform.</h2>
          <p>Manage your personal finances or run your business — all with your Paid2You account.</p>
        </div>
        <div className="workspace-grid">
          <article className="workspace-card" id="personal-workspace">
            <DeskScene />
            <div className="workspace-card__body">
              <div className="workspace-card__header">
                <span className="workspace-card__icon" aria-hidden="true">
                  P
                </span>
                <div>
                  <h3>My Paid2You</h3>
                  <span className="workspace-card__kicker">A free personal workspace to manage your work and payments.</span>
                </div>
              </div>
              <ul className="workspace-card__list">
                {PERSONAL_WORKSPACE_ITEMS.map((item) => (
                  <li key={item}>
                    <span className="workspace-check" aria-hidden="true">
                      ✓
                    </span>
                    {item}
                  </li>
                ))}
              </ul>
              <p className="workspace-card__footnote">
                Every Paid2You account includes a personal workspace at no cost — no subscription required.
              </p>
            </div>
          </article>

          <article className="workspace-card workspace-card--business" id="business-workspace">
            <RoadScene />
            <div className="workspace-card__body">
              <div className="workspace-card__header">
                <span className="workspace-card__icon" aria-hidden="true">
                  B
                </span>
                <div>
                  <h3>Paid2You Business</h3>
                  <span className="workspace-card__kicker">Subscription-based tools for growing organizations.</span>
                </div>
              </div>
              <ul className="workspace-card__list">
                {BUSINESS_LIVE_ITEMS.map((item) => (
                  <li key={item}>
                    <span className="workspace-check" aria-hidden="true">
                      ✓
                    </span>
                    {item}
                  </li>
                ))}
                {BUSINESS_COMING_SOON_ITEMS.map((item) => (
                  <li key={item} className="is-future">
                    {item}
                    <span className="workspace-soon">Coming soon</span>
                  </li>
                ))}
              </ul>
              <p className="workspace-card__footnote">
                Create a Business workspace any time from your personal account — no separate login
                required.
              </p>
            </div>
          </article>
        </div>
      </section>

      <section className="section section--industries" aria-labelledby="industries-heading">
        <div className="section-heading section-heading--brand">
          <h2 id="industries-heading">
            Built for the industries with the hardest collection and repayment workflows.
          </h2>
          <p>
            Purpose-built tools for Trucking, Freight, 3PL, and Retail — with the payments,
            documentation, and visibility you need.
          </p>
        </div>
        <div className="industry-grid">
          {INDUSTRIES.map((industry) => (
            <article className="industry-card" key={industry.name}>
              <div className="industry-card__head">
                <div className={`industry-card__icon industry-card__icon--${industry.icon === "truck" ? "trucking" : industry.icon}`}>
                  <IndustryIcon name={industry.icon} />
                </div>
                <h3>{industry.name}</h3>
                <p>{industry.body}</p>
              </div>
              <IndustryScene icon={industry.icon} />
              <ul className="industry-card__features">
                {industry.features.map((feature) => (
                  <li key={feature}>
                    <CheckIcon />
                    {feature}
                  </li>
                ))}
              </ul>
            </article>
          ))}
        </div>
      </section>
    </>
  );
}
