"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import {
  signInWithPopup,
  GoogleAuthProvider,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  updateProfile,
} from "firebase/auth";
import { auth } from "@/lib/firebase";
import { useAuth } from "@/lib/auth-context";

export default function LoginPage() {
  const { user, loading, accessDenied } = useAuth();
  const router = useRouter();

  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [emailError, setEmailError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!loading && user) {
      router.push("/");
    }
  }, [user, loading, router]);

  const handleGoogleSignIn = async () => {
    const provider = new GoogleAuthProvider();
    try {
      await signInWithPopup(auth, provider);
    } catch (error) {
      console.error("Sign-in error:", error);
    }
  };

  const handleEmailSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setEmailError(null);
    setSubmitting(true);

    try {
      if (mode === "signup") {
        const cred = await createUserWithEmailAndPassword(
          auth,
          email,
          password
        );
        if (name.trim()) {
          await updateProfile(cred.user, { displayName: name.trim() });
        }
      } else {
        await signInWithEmailAndPassword(auth, email, password);
      }
    } catch (err: unknown) {
      const code = (err as { code?: string }).code || "";
      if (code === "auth/user-not-found" || code === "auth/invalid-credential") {
        setEmailError("Invalid email or password.");
      } else if (code === "auth/wrong-password") {
        setEmailError("Invalid email or password.");
      } else if (code === "auth/email-already-in-use") {
        setEmailError("An account with this email already exists. Try signing in.");
      } else if (code === "auth/weak-password") {
        setEmailError("Password must be at least 6 characters.");
      } else if (code === "auth/invalid-email") {
        setEmailError("Please enter a valid email address.");
      } else {
        setEmailError("Something went wrong. Please try again.");
      }
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center bg-brand-cream">
        <p className="text-brand-text/50 font-body">Loading...</p>
      </div>
    );
  }

  return (
    <div className="flex h-full items-center justify-center bg-brand-cream">
      <div className="w-full max-w-sm">
        <div className="bg-white border-l-[3px] border-brand-green p-8">
          <h1 className="font-heading text-brand-green text-3xl font-bold text-center mb-1">
            Alec&apos;s Dashboard
          </h1>
          <p className="text-brand-text/50 text-sm font-body text-center mb-8">
            Internal use only · Alec&apos;s Shoes team
          </p>

          {accessDenied && (
            <div className="bg-red-50 border border-red-200 rounded p-4 mb-4">
              <p className="font-body text-sm text-red-700 font-medium mb-1">
                Access Denied
              </p>
              <p className="font-body text-xs text-red-600">
                Your account is not approved to use this dashboard. Ask an admin
                to add your email in Settings.
              </p>
            </div>
          )}

          {emailError && (
            <div className="bg-red-50 border border-red-200 rounded p-3 mb-4">
              <p className="font-body text-xs text-red-600">{emailError}</p>
            </div>
          )}

          {/* Email/password form */}
          <form onSubmit={handleEmailSubmit} className="space-y-3 mb-4">
            {mode === "signup" && (
              <input
                type="text"
                placeholder="Full name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full font-body text-sm border border-brand-cream-dark rounded px-3 py-2.5 bg-white focus:outline-none focus:border-brand-green"
              />
            )}
            <input
              type="email"
              placeholder="Email address"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className="w-full font-body text-sm border border-brand-cream-dark rounded px-3 py-2.5 bg-white focus:outline-none focus:border-brand-green"
            />
            <input
              type="password"
              placeholder="Password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={6}
              className="w-full font-body text-sm border border-brand-cream-dark rounded px-3 py-2.5 bg-white focus:outline-none focus:border-brand-green"
            />
            <button
              type="submit"
              disabled={submitting}
              className="w-full bg-brand-green text-brand-cream font-body text-sm py-2.5 px-4 rounded hover:bg-brand-green-mid transition-colors disabled:opacity-50"
            >
              {submitting
                ? "Please wait..."
                : mode === "signup"
                ? "Create Account"
                : "Sign In"}
            </button>
          </form>

          <p className="text-center font-body text-xs text-brand-text/50 mb-4">
            {mode === "signin" ? (
              <>
                No account?{" "}
                <button
                  type="button"
                  onClick={() => {
                    setMode("signup");
                    setEmailError(null);
                  }}
                  className="text-brand-green hover:underline"
                >
                  Create one
                </button>
              </>
            ) : (
              <>
                Already have an account?{" "}
                <button
                  type="button"
                  onClick={() => {
                    setMode("signin");
                    setEmailError(null);
                  }}
                  className="text-brand-green hover:underline"
                >
                  Sign in
                </button>
              </>
            )}
          </p>

          <div className="relative mb-4">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-brand-cream-dark" />
            </div>
            <div className="relative flex justify-center">
              <span className="bg-white px-3 text-xs font-body text-brand-text/40">
                or
              </span>
            </div>
          </div>

          <button
            onClick={handleGoogleSignIn}
            className="w-full bg-white text-brand-text font-body text-sm py-2.5 px-4 rounded border border-brand-cream-dark hover:bg-brand-cream transition-colors flex items-center justify-center gap-2"
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24">
              <path
                d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"
                fill="#4285F4"
              />
              <path
                d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                fill="#34A853"
              />
              <path
                d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                fill="#FBBC05"
              />
              <path
                d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                fill="#EA4335"
              />
            </svg>
            Sign in with Google
          </button>
        </div>
        <p className="text-center text-brand-text/30 text-xs font-body mt-6">
          © 2026 Alec&apos;s Shoes
        </p>
      </div>
    </div>
  );
}
