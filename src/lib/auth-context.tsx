"use client";

import { createContext, useContext, useEffect, useState, ReactNode } from "react";
import { User, onAuthStateChanged, signOut } from "firebase/auth";
import { doc, getDoc, setDoc, serverTimestamp, updateDoc } from "firebase/firestore";
import { auth, db } from "./firebase";

interface UserData {
  email: string;
  name: string;
  photoURL: string;
  role: "admin" | "manager";
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
            // Existing user — always allowed
            await updateDoc(userRef, {
              name: firebaseUser.displayName || "",
              photoURL: firebaseUser.photoURL || "",
            });
            const updated = await getDoc(userRef);
            setUser(firebaseUser);
            setUserData(updated.data() as UserData);
            setAccessDenied(false);
          } else {
            // New user — check allowlist
            const allowRef = doc(db, "allowedEmails", email);
            const allowSnap = await getDoc(allowRef);

            if (allowSnap.exists()) {
              // Approved — create their user doc
              const newUser: UserData = {
                email,
                name: firebaseUser.displayName || "",
                photoURL: firebaseUser.photoURL || "",
                role: "manager",
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
