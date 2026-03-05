import { useAuthActions } from "@convex-dev/auth/react";
import { useState } from "react";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";

export function SignUpForm() {
  const { signIn } = useAuthActions();
  const navigate = useNavigate();
  const search = useRouterState({
    select: (state) => state.location.searchStr,
  });
  const redirectUrl =
    new URLSearchParams(search).get("redirect_url") || "/dashboard";

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await signIn("password", { email, password, name, flow: "signUp" });
      navigate({ to: redirectUrl });
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Sign up failed. Try again.",
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="bg-[#f0f0e8] border-2 border-[#1a1a1a] shadow-[8px_8px_0px_0px_var(--shadow-color)] p-8">
      <h1 className="text-[#1a1a1a] font-black uppercase tracking-tighter text-2xl font-mono mb-1">
        Create Account
      </h1>
      <p className="text-[#888] font-mono text-sm mb-6">
        Get started with lawn
      </p>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-[#1a1a1a] font-bold uppercase font-mono text-xs mb-1">
            Name
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            className="w-full bg-transparent border-2 border-[#1a1a1a] text-[#1a1a1a] focus:border-[#2d5a2d] focus:outline-none px-3 py-2 font-mono"
          />
        </div>
        <div>
          <label className="block text-[#1a1a1a] font-bold uppercase font-mono text-xs mb-1">
            Email
          </label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            className="w-full bg-transparent border-2 border-[#1a1a1a] text-[#1a1a1a] focus:border-[#2d5a2d] focus:outline-none px-3 py-2 font-mono"
          />
        </div>
        <div>
          <label className="block text-[#1a1a1a] font-bold uppercase font-mono text-xs mb-1">
            Password
          </label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={8}
            className="w-full bg-transparent border-2 border-[#1a1a1a] text-[#1a1a1a] focus:border-[#2d5a2d] focus:outline-none px-3 py-2 font-mono"
          />
          <p className="text-[#888] font-mono text-xs mt-1">
            Minimum 8 characters
          </p>
        </div>

        {error && (
          <p className="text-red-600 font-mono text-sm">{error}</p>
        )}

        <button
          type="submit"
          disabled={loading}
          className="w-full bg-[#1a1a1a] hover:bg-[#2d5a2d] text-[#f0f0e8] border-2 border-[#1a1a1a] shadow-[4px_4px_0px_0px_var(--shadow-color)] hover:translate-y-[2px] hover:translate-x-[2px] hover:shadow-[2px_2px_0px_0px_var(--shadow-color)] font-mono font-bold uppercase text-sm py-2.5 px-4 transition-all disabled:opacity-50"
        >
          {loading ? "Creating account..." : "Sign Up"}
        </button>
      </form>

      <p className="mt-6 text-center text-[#888] font-mono text-sm">
        Already have an account?{" "}
        <Link
          to="/sign-in"
          className="text-[#2d5a2d] hover:text-[#1a1a1a] font-bold"
        >
          Sign in
        </Link>
      </p>
    </div>
  );
}
