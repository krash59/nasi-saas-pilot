"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuthenticatedApiFetch } from "@/lib/providers/use-authenticated-api-fetch";

export function NewProjectForm() {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  const apiFetch = useAuthenticatedApiFetch();

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const res = await apiFetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const data = await res.json();
    if (!res.ok) {
      setError(data.error ?? "Failed");
      return;
    }
    router.push(`/dashboard/projects/${data.project.id}/design`);
  }

  return (
    <form onSubmit={onSubmit} style={{ marginTop: "1rem" }}>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Project name"
        required
      />
      <button type="submit">Start design</button>
      {error && <p role="alert">{error}</p>}
    </form>
  );
}
