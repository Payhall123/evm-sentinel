import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";

export default async function HomePage() {
  const session = await getSession();
  if (session?.role === "admin") redirect("/admin");
  if (session?.role === "user") redirect("/dashboard");
  redirect("/login");
}