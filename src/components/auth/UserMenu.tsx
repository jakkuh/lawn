import { useAuthActions } from "@convex-dev/auth/react";
import { useCurrentUser } from "@/lib/auth";
import { LogOut, User } from "lucide-react";
import { useState, useRef, useEffect } from "react";

export function UserMenu() {
  const { signOut } = useAuthActions();
  const user = useCurrentUser();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const initials = user.name
    ? user.name
        .split(" ")
        .map((n) => n[0])
        .join("")
        .toUpperCase()
        .slice(0, 2)
    : "?";

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        className="w-8 h-8 border-2 border-[#1a1a1a] bg-[#1a1a1a] text-[#f0f0e8] flex items-center justify-center font-mono font-bold text-xs hover:bg-[#2d5a2d] transition-colors"
      >
        {user.imageUrl ? (
          <img
            src={user.imageUrl}
            alt={user.name || "User"}
            className="w-full h-full object-cover"
          />
        ) : (
          initials
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-2 w-56 bg-[#f0f0e8] border-2 border-[#1a1a1a] shadow-[8px_8px_0px_0px_var(--shadow-color)] z-50">
          <div className="px-4 py-3 border-b-2 border-[#1a1a1a]/10">
            <div className="flex items-center gap-2">
              <User className="w-4 h-4 text-[#888]" />
              <div className="min-w-0">
                {user.name && (
                  <p className="text-sm font-bold text-[#1a1a1a] font-mono truncate">
                    {user.name}
                  </p>
                )}
                {user.email && (
                  <p className="text-xs text-[#888] font-mono truncate">
                    {user.email}
                  </p>
                )}
              </div>
            </div>
          </div>
          <button
            onClick={async () => {
              setOpen(false);
              await signOut();
            }}
            className="w-full flex items-center gap-2 px-4 py-2.5 text-[#1a1a1a] hover:bg-[#e8e8e0] font-mono font-bold text-sm transition-colors"
          >
            <LogOut className="w-4 h-4" />
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
