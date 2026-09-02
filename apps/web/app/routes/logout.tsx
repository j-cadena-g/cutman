import { redirect } from "react-router";
import { cloudflareEnv } from "~/lib/env";
import { destroySession } from "~/lib/session.server";
import type { Route } from "./+types/logout";

export async function action({ request, context }: Route.ActionArgs) {
  const env = cloudflareEnv(context);
  const cookie = await destroySession(request, env);
  throw redirect("/login", { headers: { "Set-Cookie": cookie } });
}

export async function loader() {
  throw redirect("/");
}
