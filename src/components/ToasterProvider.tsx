"use client";

import { Toaster } from "react-hot-toast";

export default function ToasterProvider() {
  return (
    <Toaster
      position="bottom-right"
      toastOptions={{
        style: {
          fontFamily: "var(--font-dm-sans), sans-serif",
          fontSize: "14px",
          borderRadius: "6px",
        },
        success: {
          iconTheme: { primary: "#023a09", secondary: "#F8F5F0" },
        },
        error: {
          iconTheme: { primary: "#dc2626", secondary: "#fff" },
        },
        duration: 3500,
      }}
    />
  );
}
