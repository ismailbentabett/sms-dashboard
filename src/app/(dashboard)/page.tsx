import { redirect } from "next/navigation";

// The Overview dashboard ships in Phase 3; until then the sync status page is home.
export default function Home() {
  redirect("/sync");
}
