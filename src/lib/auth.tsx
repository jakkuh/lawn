"use client";

import { isSelfHosted } from "./selfHosted";
import { useConvexAuth, useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import { useUser as useClerkUser, useAuth as useClerkAuth } from "@clerk/tanstack-react-start";

export type CurrentUser = {
  id: string | null;
  email: string | null;
  name: string | null;
  imageUrl: string | null;
  isLoaded: boolean;
};

export function useCurrentUser(): CurrentUser {
  if (isSelfHosted) {
    return useSelfHostedUser();
  }
  return useClerkCurrentUser();
}

function useSelfHostedUser(): CurrentUser {
  const viewer = useQuery(api.users.viewer);
  const { isAuthenticated } = useConvexAuth();

  if (viewer === undefined) {
    return { id: null, email: null, name: null, imageUrl: null, isLoaded: false };
  }

  if (!isAuthenticated || !viewer) {
    return { id: null, email: null, name: null, imageUrl: null, isLoaded: true };
  }

  return {
    id: viewer._id,
    email: viewer.email ?? null,
    name: viewer.name ?? null,
    imageUrl: viewer.image ?? null,
    isLoaded: true,
  };
}

function useClerkCurrentUser(): CurrentUser {
  const { user, isLoaded } = useClerkUser();
  if (!isLoaded || !user) {
    return { id: null, email: null, name: null, imageUrl: null, isLoaded };
  }
  return {
    id: user.id,
    email: user.primaryEmailAddress?.emailAddress ?? null,
    name: user.fullName ?? user.firstName ?? null,
    imageUrl: user.imageUrl ?? null,
    isLoaded: true,
  };
}

export function useAuthState() {
  if (isSelfHosted) {
    return useSelfHostedAuthState();
  }
  return useClerkAuthState();
}

function useSelfHostedAuthState() {
  const { isLoading, isAuthenticated } = useConvexAuth();
  return { isLoading, isAuthenticated };
}

function useClerkAuthState() {
  const { isLoaded, userId } = useClerkAuth();
  return {
    isLoading: !isLoaded,
    isAuthenticated: !!userId,
  };
}
