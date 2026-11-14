import Link from "next/link";
import { listProjectsForCurrentCustomer } from "@/lib/tenant/customer";
import { NewProjectForm } from "./NewProjectForm";

export default async function DashboardPage() {
  let projects: { id: string; name: string; status: string }[] = [];
  let error: string | null = null;

  try {
    const rows = await listProjectsForCurrentCustomer();
    projects = rows as typeof projects;
  } catch {
    error = "We could not load your projects. Please try again.";
  }

  return (
    <main style={{ maxWidth: 720, margin: "2rem auto", padding: "0 1rem" }}>
      <p>
        <Link href="/">Home</Link>
      </p>
      <h1>Your projects</h1>
      {error && <p role="alert">{error}</p>}
      <NewProjectForm />
      <ul>
        {projects.map((p) => (
          <li key={p.id}>
            <Link href={`/dashboard/projects/${p.id}/design`}>{p.name}</Link> — {p.status}
          </li>
        ))}
      </ul>
    </main>
  );
}
