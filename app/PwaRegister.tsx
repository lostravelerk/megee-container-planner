"use client";

import { useEffect } from "react";

export default function PwaRegister() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    if (process.env.NODE_ENV !== "production") {
      // A previously installed production worker can otherwise serve a stale
      // planner while developing on the same origin. Limit cleanup to this
      // application's registrations and cache prefix.
      void navigator.serviceWorker.getRegistrations().then((registrations) =>
        Promise.all(
          registrations
            .filter((registration) => new URL(registration.scope).origin === location.origin)
            .map((registration) => registration.unregister()),
        ),
      );
      if ("caches" in window)
        void caches.keys().then((keys) =>
          Promise.all(
            keys
              .filter((key) => key.startsWith("megee-container-planner-"))
              .map((key) => caches.delete(key)),
          ),
        );
      return;
    }
    void navigator.serviceWorker
      .register("/sw.js", { scope: "/", updateViaCache: "none" })
      .then((registration) => registration.update());
  }, []);
  return null;
}
