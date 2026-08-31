import { createHashRouter, Navigate } from "react-router-dom";
import { lazy, Suspense, type ReactNode } from "react";
import { AppShell } from "@/components/shell/AppShell";
import { RouteErrorFallback } from "@/components/shell/ErrorBoundary";
import { Spinner } from "@/components/ui/Spinner";
import { Home } from "@/pages/Home";

const Instance = lazy(() =>
  import("@/pages/Instance").then((m) => ({ default: m.Instance })),
);
const NotFound = lazy(() =>
  import("@/pages/NotFound").then((m) => ({ default: m.NotFound })),
);

function LoadingFallback() {
  return (
    <div className="flex h-[60vh] items-center justify-center">
      <Spinner />
    </div>
  );
}

function suspended(page: ReactNode) {
  return <Suspense fallback={<LoadingFallback />}>{page}</Suspense>;
}

export const router = createHashRouter([
  {
    path: "/",
    element: <AppShell />,
    errorElement: <RouteErrorFallback />,
    children: [
      {
        index: true,
        element: <Home />,
      },
      {
        path: "server/:uuid",
        element: suspended(<Instance />),
      },
      {
        path: "404",
        element: suspended(<NotFound />),
      },
      { path: "*", element: <Navigate to="/404" replace /> },
    ],
  },
]);
