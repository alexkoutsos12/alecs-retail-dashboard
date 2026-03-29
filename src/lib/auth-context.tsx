"use client";

import { createContext, useContext, useEffect, useState, ReactNode } from "react";
import { User, onAuthStateChanged } from "firebase/auth";
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
}

const AuthContext = createContext<AuthContextType>({
  user: null,
  userData: null,
  loading: true,
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [userData, setUserData] = useState<UserData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      setUser(firebaseUser);

      if (firebaseUser) {
        const userRef = doc(db, "users", firebaseUser.uid);
        const userSnap = await getDoc(userRef);

        if (userSnap.exists()) {
          await updateDoc(userRef, {
            name: firebaseUser.displayName || "",
            photoURL: firebaseUser.photoURL || "",
          });
          const updated = await getDoc(userRef);
          setUserData(updated.data() as UserData);
        } else {
          const newUser: UserData = {
            email: firebaseUser.email || "",
            name: firebaseUser.displayName || "",
            photoURL: firebaseUser.photoURL || "",
            role: "manager",
            createdAt: serverTimestamp(),
          };
          await setDoc(userRef, newUser);
          setUserData(newUser);
        }
      } else {
        setUserData(null);
      }

      setLoading(false);
    });

    return () => unsubscribe();
  }, []);

  return (
    <AuthContext.Provider value={{ user, userData, loading }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
