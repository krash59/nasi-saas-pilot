import Link from "next/link";
import { DesignChat } from "./DesignChat";

type Props = { params: Promise<{ projectId: string }> };

export default async function DesignPage({ params }: Props) {
  const { projectId } = await params;
  return (
    <main style={{ maxWidth: 720, margin: "2rem auto", padding: "0 1rem" }}>
      <p>
        <Link href="/dashboard">Dashboard</Link>
      </p>
      <h1>Design conversation</h1>
      <p>Guided design talk (Wave 2). AI replies are drafts until you confirm fields in the summary.</p>
      <DesignChat projectId={projectId} />
    </main>
  );
}
