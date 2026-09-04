import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route("onboarding", "routes/onboarding.tsx"),
  route("explore", "routes/explore.tsx"),
  route("explore/u/:username", "routes/explore-user.tsx"),
  route("explore/leagues/:sleeperLeagueId", "routes/explore-league.tsx"),
  route("leagues/:leagueId", "routes/league.tsx"),
  route("sign-in/*", "routes/sign-in.tsx"),
  route("sign-up/*", "routes/sign-up.tsx"),
] satisfies RouteConfig;
