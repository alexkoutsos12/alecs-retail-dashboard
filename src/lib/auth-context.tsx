"use client";

import { createContext, useContext, useEffect, useState, ReactNode } from "react";
import { User, onAuthStateChanged, signOut } from "firebase/auth";
import { doc, getDoc, setDoc, serverTimestamp, updateDoc } from "firebase/firestore";
import { auth, db } from "./firebase";

/**
 * User roles.
 *
 * We support two active roles: `admin` (full access) and `viewer` (full
 * access scoped to a specific list of module IDs via `allowedModules`).
 *
 * `manager` is a legacy role that's being phased out. Any user doc still
 * carrying `role: "manager"` is silently migrated to `admin` on their next
 * sign-in (see auth-context below). The type union keeps it for the
 * migration transition only.
 */
export type UserRole = "admin" | "viewer" | "manager";

interface UserData {
  email: string;
  name: string;
  photoURL: string;
  role: UserRole;
  /** Only meaningful for viewers — list of module ids they can access. */
  allowedModules?: string[];
  createdAt: unknown;
}

interface AuthContextType {
  user: User | null;
  userData: UserData | null;
  loading: boolean;
  accessDenied: boolean;
  clearAccessDenied: () => void;
}

const AuthContext = createContext<AuthContextType>({
  user: null,
  userData: null,
  loading: true,
  accessDenied: false,
  clearAccessDenied: () => {},
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [userData, setUserData] = useState<UserData | null>(null);
  const [loading, setLoading] = useState(true);
  const [accessDenied, setAccessDenied] = useState(false);

  const clearAccessDenied = () => setAccessDenied(false);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      if (firebaseUser) {
        try {
          const email = firebaseUser.email?.toLowerCase() || "";
          const userRef = doc(db, "users", firebaseUser.uid);
          const userSnap = await getDoc(userRef);

          if (userSnap.exists()) {
            // Existing user — always allowed.
            // Migrate legacy "manager" role to "admin" transparently —
            // the manager role is being retired in favor of admin + viewer.
            const existing = userSnap.data() as UserData;
            const patch: Partial<UserData> & Record<string, unknown> = {
              name: firebaseUser.displayName || "",
              photoURL: firebaseUser.photoURL || "",
            };
            if (existing.role === "manager") {
              patch.role = "admin";
            }
            await updateDoc(userRef, patch);
            const updated = await getDoc(userRef);
            setUser(firebaseUser);
            setUserData(updated.data() as UserData);
            setAccessDenied(false);
          } else {
            // New user — check allowlist
            const allowRef = doc(db, "allowedEmails", email);
            const allowSnap = await getDoc(allowRef);

            if (allowSnap.exists()) {
              // Approved — create their user doc. The admin may have
              // pre-assigned a role + allowedModules when adding the email;
              // fall back to a no-access viewer for legacy allowlist
              // entries so nobody accidentally gets admin rights.
              const allow = allowSnap.data() as {
                role?: UserRole;
                allowedModules?: string[];
              };
              let role: UserRole;
              if (allow.role === "admin") role = "admin";
              else if (allow.role === "manager") role = "admin"; // migrate
              else role = "viewer";
              const newUser: UserData = {
                email,
                name: firebaseUser.displayName || "",
                photoURL: firebaseUser.photoURL || "",
                role,
                ...(role === "viewer"
                  ? {
                      allowedModules: Array.isArray(allow.allowedModules)
                        ? allow.allowedModules
                        : [],
                    }
                  : {}),
                createdAt: serverTimestamp(),
              };
              await setDoc(userRef, newUser);
              setUser(firebaseUser);
              setUserData(newUser);
              setAccessDenied(false);
            } else {
              // Not approved — sign out
              setAccessDenied(true);
              setUser(null);
              setUserData(null);
              await signOut(auth);
            }
          }
        } catch {
          // Firestore permission denied or network error — treat as not approved
          setAccessDenied(true);
          setUser(null);
          setUserData(null);
          await signOut(auth);
        }
      } else {
        setUser(null);
        setUserData(null);
      }

      setLoading(false);
    });

    return () => unsubscribe();
  }, []);

  return (
    <AuthContext.Provider value={{ user, userData, loading, accessDenied, clearAccessDenied }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
