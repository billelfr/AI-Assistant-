"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useRouter } from "next/navigation";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const supabase = createClient();
  const router = useRouter();

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setErrorMsg(null);
    setMessage(null);

    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      setErrorMsg(error.message);
      setLoading(false);
    } else {
      router.push("/dashboard");
    }
  };

  const handleSignUp = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setErrorMsg(null);
    setMessage(null);

    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: { emailRedirectTo: `${window.location.origin}/auth/callback` },
    });

    if (error) {
      setErrorMsg(error.message);
    } else {
      setMessage("Check your email to confirm your registration.");
    }
    setLoading(false);
  };

  return (
    <div style={{
      minHeight: "100vh",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      padding: "24px 16px",
      background: "var(--bg)",
    }}>
      <div style={{
        width: "100%",
        maxWidth: "400px",
      }}>
        {/* Wordmark */}
        <div style={{ marginBottom: "32px", textAlign: "center" }}>
          <span style={{
            fontSize: "1.5rem",
            fontWeight: 600,
            color: "var(--text-primary)",
            letterSpacing: "-0.02em",
          }}>
            Nudgly
          </span>
          <p style={{
            marginTop: "8px",
            fontSize: "0.875rem",
            color: "var(--text-secondary)",
          }}>
            Sign in to your workspace
          </p>
        </div>

        {/* Card */}
        <div style={{
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: "12px",
          padding: "32px",
        }}>
          <form style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
            {/* Feedback messages */}
            {errorMsg && (
              <p style={{
                fontSize: "0.875rem",
                color: "var(--color-danger)",
                padding: "10px 12px",
                background: "rgba(248,113,113,0.08)",
                borderRadius: "6px",
                margin: 0,
              }}>
                {errorMsg}
              </p>
            )}
            {message && (
              <p style={{
                fontSize: "0.875rem",
                color: "var(--color-success)",
                padding: "10px 12px",
                background: "rgba(52,211,153,0.08)",
                borderRadius: "6px",
                margin: 0,
              }}>
                {message}
              </p>
            )}

            {/* Email */}
            <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
              <label style={{
                fontSize: "0.8125rem",
                fontWeight: 500,
                color: "var(--text-secondary)",
              }}>
                Email address
              </label>
              <input
                id="login-email"
                type="email"
                required
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                style={{
                  width: "100%",
                  minHeight: "44px",
                  padding: "0 12px",
                  background: "var(--bg)",
                  border: "1px solid var(--border)",
                  borderRadius: "6px",
                  color: "var(--text-primary)",
                  fontSize: "0.9375rem",
                  outline: "none",
                }}
                onFocus={(e) => { e.currentTarget.style.borderColor = "var(--accent)"; }}
                onBlur={(e) => { e.currentTarget.style.borderColor = "var(--border)"; }}
              />
            </div>

            {/* Password */}
            <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
              <label style={{
                fontSize: "0.8125rem",
                fontWeight: 500,
                color: "var(--text-secondary)",
              }}>
                Password
              </label>
              <input
                id="login-password"
                type="password"
                required
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                style={{
                  width: "100%",
                  minHeight: "44px",
                  padding: "0 12px",
                  background: "var(--bg)",
                  border: "1px solid var(--border)",
                  borderRadius: "6px",
                  color: "var(--text-primary)",
                  fontSize: "0.9375rem",
                  outline: "none",
                }}
                onFocus={(e) => { e.currentTarget.style.borderColor = "var(--accent)"; }}
                onBlur={(e) => { e.currentTarget.style.borderColor = "var(--border)"; }}
              />
            </div>

            {/* Actions */}
            <div style={{ display: "flex", gap: "8px", paddingTop: "8px" }}>
              <button
                id="btn-sign-in"
                type="submit"
                onClick={handleLogin}
                disabled={loading}
                style={{
                  flex: 1,
                  minHeight: "44px",
                  background: "var(--accent)",
                  color: "#fff",
                  border: "none",
                  borderRadius: "6px",
                  fontSize: "0.9375rem",
                  fontWeight: 500,
                  cursor: loading ? "not-allowed" : "pointer",
                  opacity: loading ? 0.6 : 1,
                  transition: "background 0.15s",
                }}
                onMouseEnter={(e) => { if (!loading) e.currentTarget.style.background = "var(--accent-hover)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = "var(--accent)"; }}
              >
                {loading ? "Signing in…" : "Sign in"}
              </button>
              <button
                id="btn-sign-up"
                type="button"
                onClick={handleSignUp}
                disabled={loading}
                style={{
                  flex: 1,
                  minHeight: "44px",
                  background: "transparent",
                  color: "var(--text-secondary)",
                  border: "1px solid var(--border)",
                  borderRadius: "6px",
                  fontSize: "0.9375rem",
                  fontWeight: 500,
                  cursor: loading ? "not-allowed" : "pointer",
                  opacity: loading ? 0.6 : 1,
                  transition: "border-color 0.15s, color 0.15s",
                }}
                onMouseEnter={(e) => {
                  if (!loading) {
                    e.currentTarget.style.borderColor = "var(--text-secondary)";
                    e.currentTarget.style.color = "var(--text-primary)";
                  }
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.borderColor = "var(--border)";
                  e.currentTarget.style.color = "var(--text-secondary)";
                }}
              >
                Create account
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
