"use client";

import { ConvexReactClient } from "convex/react";
import { ConvexProviderWithClerk } from "convex/react-clerk";
import { ConvexAuthProvider } from "@convex-dev/auth/react";
import { useAuth } from "@clerk/tanstack-react-start";
import { ReactNode } from "react";
import { isSelfHosted } from "./selfHosted";

const convexUrl = import.meta.env.VITE_CONVEX_URL;

if (!convexUrl) {
  throw new Error("Missing VITE_CONVEX_URL");
}

const convex = new ConvexReactClient(convexUrl);

export function ConvexClientProvider({ children }: { children: ReactNode }) {
  if (isSelfHosted) {
    return (
      <ConvexAuthProvider client={convex}>
        {children}
      </ConvexAuthProvider>
    );
  }

  return (
    <ConvexProviderWithClerk client={convex} useAuth={useAuth}>
      {children}
    </ConvexProviderWithClerk>
  );
}

export { convex };
