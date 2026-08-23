import {
  isRouteErrorResponse,
  Links,
  Meta,
  NavLink,
  Outlet,
  Scripts,
  ScrollRestoration,
} from "react-router";
import type { Route } from "./+types/root";
import { useTaskStore } from "./lib/task-store.js";
import "./app.css";

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>react-alien-signals React Router PoC</title>
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

/**
 * The only component in this app that reads `.value` as a bare expression,
 * so it's the one the plugin's default `mode: "auto"` picks up on its own
 * (no explicit useSignals() call) — which is also what exercises
 * react-alien-signals/runtime's managed boundary under `transform: "managed"`.
 */
function RemainingBadge({ remaining }: { remaining: { value: number } }) {
  return <span className="badge">残り {remaining.value}</span>;
}

export default function App() {
  const store = useTaskStore();

  return (
    <div className="app-shell">
      <nav>
        <NavLink to="/" end>
          タスク
        </NavLink>
        <NavLink to="/activity">アクティビティ</NavLink>
        <RemainingBadge remaining={store.remaining} />
      </nav>
      <Outlet context={store} />
    </div>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let message = "Oops!";
  let details = "予期しないエラーが発生しました。";
  let stack: string | undefined;

  if (isRouteErrorResponse(error)) {
    message = error.status === 404 ? "404" : "Error";
    details =
      error.status === 404
        ? "ページが見つかりませんでした。"
        : error.statusText || details;
  } else if (import.meta.env.DEV && error && error instanceof Error) {
    details = error.message;
    stack = error.stack;
  }

  return (
    <main className="app-shell">
      <h1>{message}</h1>
      <p>{details}</p>
      {stack ? (
        <pre>
          <code>{stack}</code>
        </pre>
      ) : null}
    </main>
  );
}
