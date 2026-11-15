"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

const DONE = new Set(["sent", "failed", "partial"]);

export function CampaignAutoRefresh({ status }: { status: string }) {
  const router = useRouter();

  useEffect(() => {
    if (DONE.has(status)) return;
    const timer = setInterval(() => router.refresh(), 2000);
    return () => clearInterval(timer);
  }, [router, status]);

  return null;
}
