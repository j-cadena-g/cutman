import { isRouteErrorResponse, Links, Meta, Outlet, Scripts, ScrollRestoration } from "react-router";
import type { Route } from "./+types/root";
import "./app.css";

export function meta(): Route.MetaDescriptors {
  return [
    { title: "Cutman" },
    { name: "description", content: "Cutman is the season story for your Sleeper league." },
  ];
}

export const links: Route.LinksFunction = () => [
  { rel: "icon", href: "/favicon.svg", type: "image/svg+xml" },
  { rel: "preconnect", href: "https://fonts.googleapis.com" },
  { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
  {
    rel: "stylesheet",
    href: "https://fonts.googleapis.com/css2?family=Figtree:ital,wght@0,400;0,600;0,700;1,400&family=Fraunces:opsz,wght@9..144,500;9..144,700&display=swap",
  },
];

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
      </head>
      <body className="min-h-screen antialiased">
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let title = "Something broke";
  let detail = "The snap got lost. Refresh and try again.";
  if (isRouteErrorResponse(error)) {
    title = error.status === 404 ? "Not on this roster" : `Error ${error.status}`;
    detail = error.status === 404 ? "That page does not exist." : error.statusText || detail;
  } else if (import.meta.env.DEV && error instanceof Error) {
    detail = error.message;
  }
  return (
    <main className="mx-auto max-w-xl px-6 py-24">
      <p className="text-xs font-semibold uppercase tracking-[0.22em] text-flag">Cutman</p>
      <h1 className="mt-4 font-display text-4xl">{title}</h1>
      <p className="mt-3 text-muted">{detail}</p>
    </main>
  );
}
