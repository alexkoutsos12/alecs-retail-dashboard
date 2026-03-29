"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { signInWithPopup, GoogleAuthProvider } from "firebase/auth";
import { auth } from "@/lib/firebase";
import { useAuth } from "@/lib/auth-context";

export default function LoginPage() {
  const { user, loading } = useAuth();
  const router = useRouter();

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
          <button
            onClick={handleGoogleSignIn}
            className="w-full bg-brand-green text-brand-cream font-body text-sm py-2.5 px-4 rounded hover:bg-brand-green-mid transition-colors"
          >
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
