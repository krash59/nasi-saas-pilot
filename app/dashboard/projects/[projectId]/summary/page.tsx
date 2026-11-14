import Link from "next/link";
import { SummaryEditor } from "./SummaryEditor";

type Props = { params: Promise<{ projectId: string }> };

export default async function SummaryPage({ params }: Props) {
  const { projectId } = await params;
  return (
    <main style={{ maxWidth: 720, margin: "2rem auto", padding: "0 1rem" }}>
      <p>
        <Link href={`/dashboard/projects/${projectId}/design`}>Back to design chat</Link>
      </p>
      <h1>Design Summary</h1>
      <p>Only text you confirm here counts. Approval does not authorize building the app.</p>
      <SummaryEditor projectId={projectId} />
    </main>
  );
}
