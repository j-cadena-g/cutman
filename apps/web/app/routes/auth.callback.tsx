import { redirect } from "react-router";
import { cloudflareEnv } from "~/lib/env";
import { completeMagicLink } from "~/lib/session.server";
import type { Route } from "./+types/auth.callback";

export async function loader({ request, context }: Route.LoaderArgs) {
  const env = cloudflareEnv(context);
  const token = new URL(request.url).searchParams.get("token");
  if (!token) {
    throw redirect("/login");
  }
  try {
    const cookie = await completeMagicLink(env, token, request.url);
    return redirect("/", { headers: { "Set-Cookie": cookie } });
  } catch {
    throw redirect("/login?sent=0");
  }
}

export default function AuthCallback() {
  return null;
}
