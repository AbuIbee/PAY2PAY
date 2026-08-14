import type { Metadata } from "next";
import { Suspense } from "react";
import { LoginForm } from "@/components/LoginForm";

export const metadata: Metadata = { title: "Sign in" };

export default function LoginPage() {
  return (
    <article className="section" style={{ paddingBlockStart: "2.5rem" }}>
      <h1 style={{ fontFamily: "Georgia, 'Times New Roman', serif", fontSize: "var(--text-2xl)", fontWeight: 500 }}>
        Sign in
      </h1>
      <div style={{ marginTop: "1.5rem" }}>
        <Suspense fallback={<p role="status">Loading…</p>}>
          <LoginForm />
        </Suspense>
      </div>
    </article>
  );
}
