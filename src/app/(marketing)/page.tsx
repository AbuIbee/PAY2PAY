import Image from "next/image";
import Link from "next/link";
import styles from "./home.module.css";

const INDUSTRIES = ["Trucking", "Freight", "3PL", "Retail"];

export default function HomePage() {
  return (
    <div className={`${styles.home} paid2you-home-fit`}>
      <section className={styles.hero} aria-labelledby="home-hero-title">
        <div className={styles.heroInner}>
          <div className={styles.heroCopy}>
            <div className={styles.eyebrow}>AGREEMENTS. PAYMENTS. CONNECTIONS.</div>

            <h1 id="home-hero-title">
              One platform.
              <br />
              <span>Business and Personal.</span>
            </h1>

            <p>
              Paid2You gives businesses a dedicated operating experience for teams,
              outstanding balances, customers, and agreements, while My Paid2You
              remains a complete Personal account for individual agreements,
              payments, and connections.
            </p>

            <div className={styles.actions}>
              <Link
                className={styles.primaryCta}
                href="/signup?accountType=business"
              >
                Create Business Account <span aria-hidden="true">→</span>
              </Link>

              <Link
                className={styles.secondaryCta}
                href="/signup?accountType=personal"
              >
                Create Personal Account <span aria-hidden="true">→</span>
              </Link>
            </div>

            <div className={styles.ctaNotes} aria-hidden="true">
              <span>For teams, fleets, 3PLs, retailers, and growing businesses</span>
              <span>Personal account · Get started in minutes</span>
            </div>
          </div>

          <div className={styles.heroAsset}>
            <Image
              src="/home/homepageanalytics2.png"
              alt="Paid2You Personal and Business dashboard preview"
              fill
              priority
              sizes="(max-width: 70rem) 96vw, 49vw"
              className={styles.heroImage}
            />
          </div>
        </div>
      </section>

      <section className={styles.layeredSection} aria-labelledby="platform-overview-title">
        <h2 id="platform-overview-title" className={styles.srOnly}>
          Paid2You Personal and Business platform overview
        </h2>

        <div className={styles.layeredAsset}>
          <Image
            src="/home/2LAYERED_homepage_IMG.png"
            alt="Paid2You Personal and Business workspaces with Trucking, Freight, 3PL, and Retail industry examples"
            fill
            priority
            sizes="100vw"
            className={styles.layeredImage}
          />
        </div>

        <div className={styles.srOnly}>
          <h3>My Paid2You</h3>
          <h3>Paid2You Business</h3>
          {INDUSTRIES.map((industry) => (
            <h3 key={industry}>{industry}</h3>
          ))}
        </div>
      </section>
    </div>
  );
}
